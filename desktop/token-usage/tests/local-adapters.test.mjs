import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  collectLocalSources,
  detectLocalSources,
} from "../../../public/tools/local-usage-adapters.mjs";
import { collect, dateWindow } from "../../../public/tools/club-usage.mjs";
import { normalizeLocalSnapshot, dashboard } from "../renderer/analytics.mjs";
const sources = ["zcode", "teleagent", "qoder", "kiro"];
const day = dateWindow().until,
  iso = day + "T02:00:01Z",
  ms = Date.parse(iso);
const substitute = (text) =>
  text
    .replaceAll("$DAY", day)
    .replaceAll("$ISO", iso)
    .replaceAll('"$MS"', String(ms))
    .replaceAll("$MS", String(ms));
async function home(t) {
  const p = await mkdtemp(join(tmpdir(), "club-local-adapters-"));
  t.after(() => rm(p, { recursive: true, force: true }));
  return p;
}
async function log(root, path, rows) {
  const dest = join(root, path);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(
    dest,
    rows.map(JSON.stringify).join("\n") + "\n{incomplete-tail",
  );
}
const sorted = (rows) =>
  rows
    .toSorted((a, b) =>
      JSON.stringify([a.client, a.model]).localeCompare(
        JSON.stringify([b.client, b.model]),
      ),
    )
    .map((r) => ({
      ...r,
      ...(r.unavailable ? { unavailable: r.unavailable.toSorted() } : {}),
    }));
test("shared SQLite/JSONL corpus: real counters, platform roots, dedup, incomplete/credits/text exclusion and provenance", async (t) => {
  const root = await home(t),
    f = JSON.parse(
      substitute(
        await readFile(
          new URL("./fixtures/local-adapters.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  for (const entry of f.databases) {
    const path = join(root, entry.path);
    await mkdir(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(entry.schema);
    for (const r of entry.rows) {
      const fields = Object.keys(r);
      db.prepare(
        `INSERT INTO ${entry.table} (${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")})`,
      ).run(
        ...Object.values(r).map((v) =>
          typeof v === "string" ? substitute(v) : v,
        ),
      );
    }
    db.close();
  }
  for (const entry of f.logs) await log(root, entry.path, entry.rows);
  assert.deepEqual(
    await detectLocalSources(root),
    Object.fromEntries(sources.map((id) => [id, "found"])),
  );
  const mirrored = join(root, ".kiro/sessions/cli/mirror.json");
  await mkdir(dirname(mirrored), { recursive: true });
  await writeFile(mirrored, "{incomplete mirror must not be read when DB exists");
  const actual = await collectLocalSources(
    root,
    sources,
    dateWindow().since,
    day,
  );
  assert.deepEqual(sorted(actual), sorted(f.expected));
  assert.doesNotMatch(JSON.stringify(actual), /PRIVATE|credits|session|uuid/);
  const snapshot = await collect(undefined, sources, root); // Custom-only collection must never invoke npx/Tokscale.
  assert.equal(snapshot.collector, "club-usage@1");
  assert.deepEqual(
    sorted(normalizeLocalSnapshot(snapshot).rows),
    sorted(f.expected),
  );
  assert.deepEqual(
    dashboard(snapshot, { client: "qoder" }).unavailable.toSorted(),
    ["cache_write", "reasoning"],
  );
});
test("ZCode legacy JSONL requires numerical usage; authoritative cache totals split correctly", async (t) => {
  const root = await home(t);
  await log(root, ".zcode/projects/p/session.jsonl", [
    { role: "user", content: "PRIVATE".repeat(100) },
    { role: "assistant", content: "PRIVATE".repeat(100) },
    {
      role: "assistant",
      model: "glm-fixture",
      sessionId: "s",
      timestamp: iso,
      usage: {
        input: 100,
        output: 30,
        cache_read: 20,
        cache_write: 5,
        reasoning: 5,
        total: 130,
      },
    },
  ]);
  const r = await collectLocalSources(root, ["zcode"], dateWindow().since, day);
  assert.deepEqual(r, [
    {
      date: day,
      client: "zcode",
      model: "glm-fixture",
      input: 75,
      output: 25,
      cache_read: 20,
      cache_write: 5,
      reasoning: 5,
    },
  ]);
});
test("unmeasured Qoder credits and text create no zero-token rows; absent adapters stay absent", async (t) => {
  const root = await home(t);
  assert.deepEqual(
    await detectLocalSources(root),
    Object.fromEntries(sources.map((id) => [id, "absent"])),
  );
  await log(root, ".qoder-cn/projects/p/s.jsonl", [
    {
      type: "assistant",
      timestamp: iso,
      message: {
        model: "q",
        usage: { input_tokens: 0, output_tokens: 0, credits: 9 },
      },
    },
  ]);
  assert.deepEqual(
    await collectLocalSources(root, ["qoder"], dateWindow().since, day),
    [],
  );
});
test("invalid counters or unsupported existing schema fail without overwriting prior snapshots", async (t) => {
  const root = await home(t);
  await log(root, ".qoder/projects/p/s.jsonl", [
    {
      type: "assistant",
      timestamp: iso,
      message: {
        usage: {
          prompt_tokens: 5,
          completion_tokens: 2,
          cache_read_input_tokens: 10,
        },
      },
    },
  ]);
  await assert.rejects(
    collectLocalSources(root, ["qoder"], dateWindow().since, day),
    /缓存/,
  );
  const path = join(root, ".zcode/cli/db/db.sqlite");
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE unrelated(id)");
  db.close();
  await assert.rejects(
    collectLocalSources(root, ["zcode"], dateWindow().since, day),
    /结构/,
  );
});

test("ambiguous generic overlap fails safely and absent cache metrics stay unknown", async (t) => {
  const root = await home(t);
  await log(root, ".zcode/projects/p/s.jsonl", [
    {
      role: "assistant",
      timestamp: iso,
      usage: { input: 100, output: 30, cache_read: 20 },
    },
  ]);
  await assert.rejects(
    collectLocalSources(root, ["zcode"], dateWindow().since, day),
    /总量/,
  );
  await log(root, ".qoder/projects/p/s.jsonl", [
    {
      type: "assistant",
      timestamp: iso,
      message: {
        usage: {
          input: 100,
          output: 30,
          cache_read: 20,
        },
      },
    },
  ]);
  await assert.rejects(
    collectLocalSources(root, ["qoder"], dateWindow().since, day),
    /口径/,
  );
});

test('a standalone downloaded helper still runs help without companion modules', async t => {
  const { copyFile, realpath } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const root = await home(t),path = join(root,'club-usage.mjs');
  await copyFile(new URL('../../../public/tools/club-usage.mjs',import.meta.url),path);
  const result=spawnSync(process.execPath,[await realpath(path),'help'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/preview/);
});

test("Kiro CLI snapshots deduplicate copies, exclude credits/context/text and protect invalid counters", async (t) => {
  const root = await home(t), dir = join(root, ".kiro/sessions/cli");
  await mkdir(dir, { recursive: true });
  const session = {session_id: "PRIVATE_SESSION", session_state: {
    rts_model_state: {model_info: {model_id: "kiro-cli"}},
    conversation_metadata: {user_turn_metadatas: [
      {end_timestamp: ms / 1000, input_token_count: 80, output_token_count: 30, cache_read_input_token_count: 20, cache_write_input_token_count: 5},
      {end_timestamp: iso, input_token_count: 0, output_token_count: 0, context_usage_percentage: 60, assistant_response_length: 9999, metering_usage: [{unit: "credit", value: 10}]},
      {end_timestamp: iso, input_token_count: 7},
      {input_token_count: 900, output_token_count: 900},
    ]},
  }};
  await writeFile(join(dir, "s.json"), JSON.stringify(session));
  await writeFile(join(dir, "copy.json"), JSON.stringify(session));
  await writeFile(join(dir, "s.jsonl"), JSON.stringify({kind: "AssistantMessage", data: {content: "PRIVATE_TEXT"}}));
  const rows = await collectLocalSources(root, ["kiro"], dateWindow().since, day);
  assert.deepEqual(rows, [{date: day, client: "kiro", model: "kiro-cli", input: 87, output: 30, cache_read: 20, cache_write: 5, reasoning: 0, unavailable: ["cache_read", "cache_write", "output", "reasoning"]}]);
  session.session_state.conversation_metadata.user_turn_metadatas[0].input_token_count = -1;
  await writeFile(join(dir, "s.json"), JSON.stringify(session));
  await assert.rejects(collectLocalSources(root, ["kiro"], dateWindow().since, day), /非负整数/);
  // Disabled sources never open incompatible Kiro metadata.
  assert.deepEqual(await collectLocalSources(root, ["qoder"], dateWindow().since, day), []);
});

test("ZCode completed status retains 90-day history even when old rows have no completion timestamp", async (t) => {
  const root = await home(t), p = join(root, '.zcode/cli/db/db.sqlite');
  await mkdir(dirname(p), {recursive:true});
  const db = new DatabaseSync(p);
  db.exec(`CREATE TABLE model_usage(id TEXT PRIMARY KEY,session_id TEXT,model_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,input_tokens INTEGER,output_tokens INTEGER,computed_total_tokens INTEGER);`);
  const insert = db.prepare('INSERT INTO model_usage VALUES(?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<91;i++) {
    const time = ms-i*86400000;
    insert.run(`call-${i}`,'private-session','zcode-history','completed',time,i<7?time:null,100,30,130);
  }
  for(const status of ['running','failed','cancelled',null])
    insert.run(`skip-${status}`,'private-session','zcode-history',status,ms,ms,1000,300,1300);
  db.close();
  // DB remains authoritative: do not add mirrored transcript counts.
  await log(root,'.zcode/projects/p/mirror.jsonl',[{role:'assistant',timestamp:iso,model:'zcode-history',usage:{input:999,output:999}}]);
  const snapshot = await collect(undefined,['zcode'],root);
  assert.equal(snapshot.rows.length,90);
  for(const range of [7,30,90]) {
    const d = dashboard(snapshot,{client:'zcode',range});
    assert.equal(d.days.filter(day=>day.known).length,range);
    assert.equal(d.days.reduce((n,day)=>n+day.total,0),range*130);
  }
});

test('Qoder CLI SDK usage needs no total or Credits; cache buckets are separate from input', async t => {
  const root = await home(t);
  const usage = {input_tokens:100,output_tokens:30,cache_read_input_tokens:20,cache_creation_input_tokens:5};
  const call = u => ({type:'assistant',timestamp:iso,sessionId:'s',message:{id:'call',model:'qoder-sdk',usage:u}});
  await log(root,'.qoder/projects/p/s.jsonl',[call(usage)]);
  const rows = await collectLocalSources(root,['qoder'],dateWindow().since,day);
  assert.equal(rows.length,1);
  assert.deepEqual([rows[0].input,rows[0].output,rows[0].cache_read,rows[0].cache_write],[100,30,20,5]);
  await log(root,'.qoder/projects/p/s.jsonl',[call({...usage,credits:999})]);
  assert.deepEqual(await collectLocalSources(root,['qoder'],dateWindow().since,day),rows);
});

test('Qoder CLI distinguishes native SDK, OpenAI and explicit totals; Credits cannot bypass ambiguity', async t => {
  const root = await home(t);
  const cases = [
    [{input_tokens:100,output_tokens:30,cache_read_input_tokens:20,cache_creation_input_tokens:5,total_tokens:130},[75,30,20,5,0]],
    [{input_tokens:100,output_tokens:30,cache_read_input_tokens:20,cache_creation_input_tokens:5,total_tokens:155},[100,30,20,5,0]],
    [{prompt_tokens:100,completion_tokens:30,cache_read_input_tokens:20,cache_creation_input_tokens:5},[75,30,20,5,0]],
    [{input_tokens:100,output_tokens:30,cache_read_input_tokens:20,reasoning_tokens:5},[100,25,20,0,5]],
    [{input_tokens:0,output_tokens:0,cache_creation_input_tokens:123},[0,0,0,123,0]],
  ];
  for (const [usage,expected] of cases) {
    await log(root,'.qoder/projects/p/s.jsonl',[{type:'assistant',timestamp:iso,message:{id:'call',usage}}]);
    const [row] = await collectLocalSources(root,['qoder'],dateWindow().since,day);
    assert.deepEqual(['input','output','cache_read','cache_write','reasoning'].map(k=>row[k]),expected);
  }
  for(const extra of [{},{credits:99}]) {
    await log(root,'.qoder/projects/p/s.jsonl',[{type:'assistant',timestamp:iso,message:{usage:{input:100,output:30,cache_read:20,...extra}}}]);
    await assert.rejects(collectLocalSources(root,['qoder'],dateWindow().since,day),/口径无法识别/);
  }
});
