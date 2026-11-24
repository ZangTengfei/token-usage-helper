import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  collect,
  detectSources,
  stageWorkBuddy,
  dateWindow,
} from "../../../public/tools/club-usage.mjs";
import { normalizeLocalSnapshot, dashboard } from "../renderer/analytics.mjs";
import { UsageController } from "../core.mjs";

const nativeRequire = createRequire(new URL("../../token-usage-tauri/package.json", import.meta.url));
const executable = join(
  dirname(nativeRequire.resolve(
    process.platform === "win32" ? "@tokscale/cli-win32-x64-msvc" : "@tokscale/cli-darwin-arm64",
  )),
  process.platform === "win32" ? "tokscale.exe" : "tokscale",
);
test("WorkBuddy native scan: both roots, function/message identity, cache and context-only exclusion", async () => {
  const home = await mkdtemp(join(tmpdir(), "workbuddy-fixture-"));
  const staged = await mkdtemp(join(tmpdir(), "workbuddy-metadata-"));
  try {
    assert.equal((await detectSources(home, {})).workbuddy, "absent");
    const day = dateWindow().until;
    const timestamp = Date.parse(`${day}T02:00:01Z`);
    await mkdir(join(home, ".workbuddy-ai"), { recursive: true });
    const db = new DatabaseSync(join(home, ".workbuddy-ai/workbuddy.db"));
    db.exec(`CREATE TABLE sessions(id TEXT, model TEXT, cwd TEXT);
      CREATE TABLE session_usage(session_id TEXT, used INTEGER, size INTEGER, updated_at INTEGER);
      INSERT INTO sessions VALUES('context-only','wrong-context-model','/PRIVATE');
      INSERT INTO session_usage VALUES('context-only',999999,1000000,${timestamp});`);
    db.close();
    assert.deepEqual((await collect(executable, ["workbuddy"], home)).rows, []);
    const base = {
      timestamp,
      sessionId: "session-1",
      status: "completed",
      cwd: "/PRIVATE",
      providerData: {
        model: "workbuddy-test",
        messageId: "request-1",
        rawUsage: {
          input_tokens: 100,
          output_tokens: 30,
          total_tokens: 130,
          cache_read_input_tokens: 20,
        },
      },
      arguments: "PRIVATE ARGUMENTS",
      content: "PRIVATE CONTENT",
    };
    const pair = [
      { ...base, id: "call-1", type: "function_call" },
      {
        ...base,
        id: "message-1",
        type: "message",
        role: "assistant",
        message: { content: "PRIVATE REPLY" },
      },
    ];
    for (const root of [".workbuddy", ".workbuddy-ai"]) {
      await mkdir(join(home, root, "projects/p"), { recursive: true });
      await writeFile(
        join(home, root, "projects/p/session-1.jsonl"),
        pair.map(JSON.stringify).join("\n") + "\nmalformed-tail",
      );
    }
    const separate = {
      ...base,
      id: "call-2",
      type: "function_call",
      sessionId: "session-2",
      providerData: {
        requestModelId: "workbuddy-test",
        messageId: "request-2",
        rawUsage: {
          input_tokens: 80,
          output_tokens: 30,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
        },
      },
    };
    await writeFile(
      join(home, ".workbuddy-ai/projects/p/session-2.jsonl"),
      JSON.stringify(separate),
    );
    // Ignore incomplete responses even when usage fields exist.
    await writeFile(
      join(home, ".workbuddy-ai/projects/p/pending.jsonl"),
      JSON.stringify({ ...separate, status: "pending" }),
    );
    assert.equal((await detectSources(home, {})).workbuddy, "found");
    assert.equal(await stageWorkBuddy(home, staged), 6);
    const metadata = await readFile(
      join(staged, ".workbuddy/projects/p/session-1.jsonl"),
      "utf8",
    );
    assert.doesNotMatch(metadata, /PRIVATE|content|arguments|cwd/);
    assert.deepEqual(await readdir(join(staged, ".workbuddy-ai")), [
      "projects",
    ]);
    const snapshot = await collect(executable, ["workbuddy"], home);
    assert.deepEqual(snapshot.rows, [
      {
        date: day,
        client: "workbuddy",
        model: "workbuddy-test",
        input: 160,
        output: 60,
        cache_read: 40,
        cache_write: 5,
        reasoning: 0,
      },
    ]);
    assert.equal(normalizeLocalSnapshot(snapshot).rows[0].client, "workbuddy");
    assert.equal(dashboard(snapshot, { client: "workbuddy" }).total, 265);
    const mixed = await collect(executable, ["codex", "workbuddy"], home);
    assert.deepEqual(mixed.rows, snapshot.rows);
    const controller = new UsageController({
      settings: { snapshot },
      save: async () => {},
    });
    assert.equal(controller.state().sources.workbuddy, false);
    await controller.setSource({ client: "workbuddy", enabled: true });
    assert.equal(controller.state().sources.workbuddy, true);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(staged, { recursive: true, force: true });
  }
});
