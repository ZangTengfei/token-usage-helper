import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  dateWindow,
  collect,
  detectSources,
} from "../public/tools/club-usage.mjs";
const home = await mkdtemp(join(tmpdir(), "club-collector-test-"));
try {
  const { until } = dateWindow();
  const timestamp = `${until}T02:00:01Z`;
  await mkdir(join(home, ".codex/sessions"), { recursive: true });
  const lines = [
    {
      timestamp,
      type: "session_meta",
      payload: { id: "fixture", timestamp, cwd: "/private-fixture" },
    },
    {
      timestamp,
      type: "turn_context",
      payload: { model: "gpt-5", cwd: "/private-fixture" },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 30,
            reasoning_output_tokens: 5,
          },
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 30,
            reasoning_output_tokens: 5,
          },
        },
      },
    },
  ];
  await writeFile(
    join(home, ".codex/sessions/rollout-fixture.jsonl"),
    lines.map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
  async function fixture(path, data, jsonl = true) {
    await mkdir(join(home, path, ".."), { recursive: true });
    await writeFile(
      join(home, path),
      jsonl
        ? data.map((x) => JSON.stringify(x)).join("\n") + "\n"
        : JSON.stringify(data),
    );
  }
  await fixture(
    ".gemini/tmp/project/chats/session-fixture.json",
    {
      sessionId: "gemini-fixture",
      projectHash: "fixture",
      startTime: timestamp,
      lastUpdated: timestamp,
      messages: [
        {
          id: "1",
          type: "gemini",
          timestamp,
          model: "gemini-test",
          tokens: {
            input: 100,
            output: 30,
            cached: 20,
            thoughts: 5,
            total: 135,
          },
        },
      ],
    },
    false,
  );
  await fixture(".kimi/sessions/project/session/wire.jsonl", [
    {
      timestamp: Date.parse(timestamp) / 1000,
      message: {
        type: "StatusUpdate",
        payload: {
          message_id: "kimi-1",
          token_usage: {
            input_other: 80,
            output: 30,
            input_cache_read: 20,
            input_cache_creation: 5,
          },
        },
      },
    },
  ]);
  await fixture(".qwen/projects/project/chats/session.jsonl", [
    {
      type: "assistant",
      timestamp,
      sessionId: "qwen-fixture",
      model: "qwen-test",
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 30,
        cachedContentTokenCount: 20,
        thoughtsTokenCount: 5,
        totalTokenCount: 130,
      },
    },
  ]);
  const claw = {
    type: "message",
    id: "unique-message",
    message: {
      role: "assistant",
      model: "claw-test",
      provider: "anthropic",
      timestamp: Date.parse(timestamp),
      usage: { input: 80, output: 30, cacheRead: 20, cacheWrite: 5 },
    },
  };
  await fixture(".openclaw/agents/main/sessions/session.jsonl", [claw]);
  await fixture(".openclaw/agents/main/sessions/fork.jsonl", [claw]);
  const dshMessage = {
    type: "assistant/message",
    seq: 1,
    time: Date.parse(timestamp),
    data: {
      turn: 1,
      step: 1,
      message: {
        id: "dsh-message",
        role: "assistant",
        content: "private-fixture",
        source: {
          provider: "deepseek",
          model: "configured-model",
          replayState: { response: { responseModel: "deepseek-test" } },
        },
      },
      usage: {
        inputTokens: 80,
        outputTokens: 30,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
        reasoningTokens: 5,
      },
    },
  };
  const dshSummary = {
    ...dshMessage,
    type: "compaction/summary",
    seq: 2,
    data: {
      ...dshMessage.data,
      compactionId: "summary-1",
      message: { ...dshMessage.data.message, id: "dsh-summary" },
    },
  };
  const dshLines = [
    { type: "session", id: "dsh-original", cwd: "/private-fixture" },
    dshMessage,
    dshSummary,
  ];
  await fixture(".dsh/sessions/project/original/session.jsonl", dshLines);
  // Duplicate transcript encoded as appended zstd frames must not double count.
  const compressed = join(
    home,
    ".dsh/sessions/project/copy/session.jsonl.zstd",
  );
  await mkdir(join(compressed, ".."), { recursive: true });
  await writeFile(
    compressed,
    Buffer.concat(
      dshLines.map((line) =>
        zstdCompressSync(Buffer.from(JSON.stringify(line) + "\n")),
      ),
    ),
  );
  // An inherited event with a different ID is excluded by the fork boundary.
  await fixture(".dsh/sessions/project/fork/session.jsonl", [
    { type: "session", id: "dsh-fork", seedLength: 3 },
    {
      ...dshMessage,
      data: {
        ...dshMessage.data,
        message: { ...dshMessage.data.message, id: "inherited-only" },
      },
    },
  ]);
  // Pinned upstream native formats: three editor task logs, Pi JSONL,
  // Copilot OTEL, Hermes/Goose SQLite and Droid settings + transcript.
  for (const [client, extension] of Object.entries({
    cline: "saoudrizwan.claude-dev",
    roocode: "rooveterinaryinc.roo-cline",
    kilocode: "kilocode.kilo-code",
  })) {
    const task = `.config/Code/User/globalStorage/${extension}/tasks/task-${client}`;
    await fixture(
      `${task}/ui_messages.json`,
      [
        {
          type: "say",
          say: "api_req_started",
          ts: timestamp,
          text: JSON.stringify({
            tokensIn: 100,
            tokensOut: 30,
            cacheReads: 20,
            cacheWrites: 5,
            apiProtocol: "anthropic",
          }),
        },
      ],
      false,
    );
    await mkdir(join(home, task), { recursive: true });
    await writeFile(
      join(home, task, "api_conversation_history.json"),
      "<environment_details><model>claude-sonnet-4</model></environment_details>",
    );
  }
  await fixture(".pi/agent/sessions/project/session.jsonl", [
    { type: "session", id: "pi-fixture", cwd: "/private-fixture" },
    {
      type: "message",
      id: "pi-1",
      timestamp,
      message: {
        role: "assistant",
        model: "claude-sonnet-4",
        provider: "anthropic",
        usage: { input: 80, output: 30, cacheRead: 20, cacheWrite: 5 },
      },
    },
  ]);
  await fixture(".copilot/otel/usage.jsonl", [
    {
      type: "span",
      traceId: "trace-test",
      spanId: "span-test",
      name: "chat gpt-4o",
      endTime: [Date.parse(timestamp) / 1000, 0],
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.response.model": "gpt-4o",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 30,
        "gen_ai.usage.cache_read.input_tokens": 20,
      },
    },
  ]);
  async function sqlite(path, sql, values) {
    await mkdir(join(home, path, ".."), { recursive: true });
    const db = new DatabaseSync(join(home, path));
    try {
      db.exec(sql);
      db.prepare(values[0]).run(...values.slice(1));
    } finally {
      db.close();
    }
  }
  await sqlite(
    ".hermes/state.db",
    `CREATE TABLE sessions(id TEXT,model TEXT,billing_provider TEXT,started_at REAL,message_count INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER,actual_cost_usd REAL,estimated_cost_usd REAL)`,
    [
      "INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      "hermes-fixture",
      "gpt-4o",
      "openai",
      Date.parse(timestamp) / 1000,
      1,
      80,
      30,
      20,
      5,
      0,
      0,
      0,
    ],
  );
  await sqlite(
    ".local/share/goose/sessions/sessions.db",
    `CREATE TABLE sessions(id TEXT,model_config_json TEXT,provider_name TEXT,created_at TEXT,total_tokens INTEGER,input_tokens INTEGER,output_tokens INTEGER,accumulated_total_tokens INTEGER,accumulated_input_tokens INTEGER,accumulated_output_tokens INTEGER)`,
    [
      "INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?)",
      "goose-fixture",
      JSON.stringify({ model_name: "gpt-4o" }),
      "openai",
      timestamp,
      130,
      100,
      30,
      130,
      100,
      30,
    ],
  );
  await fixture(
    ".factory/sessions/project/droid-fixture.settings.json",
    { model: "gpt-4o", tokenUsage: { inputTokens: 100, outputTokens: 30 } },
    false,
  );
  await fixture(".factory/sessions/project/droid-fixture.jsonl", [
    { type: "session_start", id: "droid-fixture" },
    {
      type: "message",
      timestamp,
      message: { role: "assistant", content: "fixture" },
    },
  ]);
  await fixture(".qwen/projects/project/chats/gemini-session.jsonl", [
    {
      type: "assistant",
      timestamp,
      sessionId: "qwen-gemini-fixture",
      model: "qwen-test",
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 30,
        cachedContentTokenCount: 20,
        thoughtsTokenCount: 5,
        totalTokenCount: 135,
      },
    },
  ]);
  // GeneratorMetadata from agy and the IDE uses the same protobuf layout.
  const varint = (n) => {
    const bytes = [];
    while (n >= 128) {
      bytes.push(n % 128 + 128);
      n = Math.floor(n / 128);
    }
    return Buffer.from([...bytes, n]);
  };
  const integer = (field, value) => Buffer.concat([varint(field * 8), varint(value)]);
  const message = (field, bytes) =>
    Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
  const stamp = message(4, integer(1, Date.parse(timestamp) / 1000));
  for (const [store, session, response] of [
    ["antigravity-cli", "00000000-0000-4000-8000-000000000001", "reply-cli"],
    ["antigravity", "00000000-0000-4000-8000-000000000001", "reply-cli"],
    ["antigravity", "00000000-0000-4000-8000-000000000002", "reply-ide"],
  ]) {
    const root = join(home, ".gemini", store, "conversations");
    await mkdir(root, { recursive: true });
    const db = new DatabaseSync(join(root, `${session}.db`));
    try {
      db.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER)");
      const usage = Buffer.concat([
        integer(1, 1132), // Model enum, excluded from Token totals.
        integer(2, 80), integer(3, 30), integer(4, 7), integer(5, 20),
        integer(9, 5), integer(10, 25), message(11, Buffer.from(response)),
      ]);
      const blob = message(1, Buffer.concat([
        message(4, usage), message(9, stamp), message(19, Buffer.from("gemini-2.5-pro")),
      ]));
      db.prepare("INSERT INTO gen_metadata VALUES (0, ?, ?)").run(blob, blob.length);
    } finally {
      db.close();
    }
  }
  const tokscaleConfig = process.platform === "win32" ? "AppData/Roaming/tokscale" : ".config/tokscale";
  await fixture(join(tokscaleConfig, "antigravity-cache/sessions/legacy.jsonl"), [
    {
      type: "usage", sessionId: "legacy", responseId: "reply-cache",
      timestamp: Date.parse(timestamp), modelId: "gemini-2.5-pro",
      input: 80, output: 30, cacheRead: 20, cacheWrite: 7, reasoning: 5,
    },
  ]);
  const detection = await detectSources(home, {});
  for (const client of ["codex", "gemini", "kimi", "qwen", "openclaw", "dsh", "antigravity"])
    assert.equal(detection[client], "found");
  assert.equal(detection.claude, "absent");
  const native = process.platform === "win32"
    ? "desktop/token-usage-tauri/src-tauri/resources/collector/tokscale.exe"
    : "desktop/token-usage-tauri/src-tauri/resources/collector/tokscale";
  if (process.platform === "win32" && !existsSync(native))
    throw new Error("请先运行 npm run prepare:app --prefix desktop/token-usage-tauri，生成 Windows 采集器。");
  const started = performance.now();
  const executable = existsSync(native) ? native : undefined;
  const data = await collect(executable, [
    "codex", "gemini", "kimi", "qwen", "openclaw", "dsh", "cline", "roocode",
    "kilocode", "copilot", "hermes", "pi", "goose", "droid", "antigravity",
  ], home);
  console.log(
    `Isolated native fixture scan: ${Math.round(performance.now() - started)} ms`,
  );
  assert.equal(data.rows.length, 15);
  const withoutAntigravity = await collect(executable, ["codex"], home);
  assert.deepEqual(withoutAntigravity.rows.map((row) => row.client), ["codex"]);
  assert.deepEqual(
    data.rows.find((x) => x.client === "codex"),
    {
      date: until,
      client: "codex",
      model: "gpt-5",
      input: 80,
      output: 25,
      cache_read: 20,
      cache_write: 0,
      reasoning: 5,
    },
  );
  for (const [client, expected] of Object.entries({
    gemini: [80, 30, 20, 0, 5],
    kimi: [80, 30, 20, 5, 0],
    qwen: [160, 55, 40, 0, 10],
    cline: [100, 30, 20, 5, 0],
    roocode: [75, 30, 20, 5, 0],
    kilocode: [75, 30, 20, 5, 0],
    copilot: [80, 30, 20, 0, 0],
    hermes: [80, 30, 20, 5, 0],
    pi: [80, 30, 20, 5, 0],
    goose: [100, 30, 0, 0, 0],
    droid: [100, 30, 0, 0, 0],
    openclaw: [80, 30, 20, 5, 0],
    dsh: [160, 50, 40, 10, 10],
    antigravity: [240, 75, 60, 21, 15],
  })) {
    const row = data.rows.find((x) => x.client === client);
    assert.deepEqual(
      [row.input, row.output, row.cache_read, row.cache_write, row.reasoning],
      expected,
      client,
    );
  }
  assert.equal(
    data.rows.find((x) => x.client === "dsh").model,
    "deepseek-test",
  );
  assert.equal(
    (await detectSources(home, { DSH_HOME: join(home, "missing") })).dsh,
    "absent",
  );
  assert.ok(!JSON.stringify(data).includes("private-fixture"));
  console.log(
    "PASS pinned Tokscale: fifteen sources, Antigravity IDE/CLI/cache and cross-store deduplication, disjoint token buckets and privacy whitelist",
  );
} finally {
  await rm(home, { recursive: true, force: true });
}
