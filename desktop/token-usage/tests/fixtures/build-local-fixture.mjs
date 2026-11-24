import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dateWindow } from "../../../../public/tools/club-usage.mjs";
export async function buildLocalFixture(root) {
  const day = dateWindow().until,
    iso = day + "T02:00:01Z",
    ms = Date.parse(iso);
  const sub = (s) =>
    s
      .replaceAll("$DAY", day)
      .replaceAll("$ISO", iso)
      .replaceAll('"$MS"', String(ms))
      .replaceAll("$MS", String(ms));
  const fixture = JSON.parse(
    sub(
      await readFile(new URL("./local-adapters.json", import.meta.url), "utf8"),
    ),
  );
  for (const entry of fixture.databases) {
    const path = join(root, entry.path);
    await mkdir(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(entry.schema);
    for (const row of entry.rows) {
      const fields = Object.keys(row);
      db.prepare(
        `INSERT INTO ${entry.table} (${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")})`,
      ).run(
        ...Object.values(row).map((v) => (typeof v === "string" ? sub(v) : v)),
      );
    }
    db.close();
  }
  for (const entry of fixture.logs) {
    const path = join(root, entry.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      entry.rows.map(JSON.stringify).join("\n") + "\n{incomplete-tail",
    );
  }
  return fixture;
}
