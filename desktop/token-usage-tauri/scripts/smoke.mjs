// Local-only native smoke harness. Interact with the app, then Ctrl+C to clean up.
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  repo = resolve(root, "../..");
const verifyWindows = process.argv.includes("--verify-windows");
if (verifyWindows && process.platform !== "win32") throw new Error("Windows verification requires Windows x64.");
const profile = await mkdtemp(join(tmpdir(), "club-tauri-smoke-"));
const home = join(profile, "logs");
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const rows = [];
for (let i = 0; i < 90; i++) {
  const date = new Date(today + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() - i);
  if (i % 13 === 1) continue;
  rows.push({
    date: date.toISOString().slice(0, 10),
    client: "codex",
    model: "smoke-fixture",
    input: (90 - i) * 10000,
    output: (90 - i) * 1000,
    cache_read: (90 - i) * 50000,
    cache_write: 0,
    reasoning: 0,
  });
}
const report = { start: 0, approved: 0, sync: 0, revoked: 0, validRows: 0, board: 0 };
const output = join(repo, "output/tauri-smoke");
await mkdir(output, { recursive: true });
let pairing;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET") {
      if (req.url.startsWith("/api/token-usage/leaderboard?")) {
        assert.equal(req.headers.authorization, undefined);
        const period = new URL(req.url, "http://localhost").searchParams.get("period");
        assert.ok(["today", "7d", "30d", "all"].includes(period));
        report.board++;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ period, rows: [{ nickname: "Windows 测试成员", tokens: 123456, active_days: 2, clients: ["codex"], last_synced_at: new Date().toISOString() }] }));
        return;
      }
      if (req.url.startsWith("/token-usage/connect?id=") && pairing) {
        pairing.approved = true;
        report.approved++;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        "<title>Tauri 本机测试</title><h1>本机测试连接已确认</h1><p>这是隔离测试服务，未连接正式社区。可以关闭此页面，回到试用客户端。</p>",
      );
      return;
    }
    let text = "";
    for await (const b of req) text += b;
    const body = text ? JSON.parse(text) : null;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/token-usage/connect") {
      if (body.action === "start") {
        assert.match(body.token_hash, /^[a-f0-9]{64}$/);
        assert.match(body.poll_hash, /^[a-f0-9]{64}$/);
        assert.equal(body.token, undefined);
        pairing = {
          id: "11111111-1111-4111-8111-111111111111",
          tokenHash: body.token_hash,
          pollHash: body.poll_hash,
          approved: false,
        };
        report.start++;
        res.end(
          JSON.stringify({
            id: pairing.id,
            code: "11111111",
            expires_at: new Date(Date.now() + 600000).toISOString(),
          }),
        );
      } else {
        assert.equal(body.id, pairing.id);
        assert.equal(hash(body.secret), pairing.pollHash);
        res.end(
          JSON.stringify(
            body.action === "cancel"
              ? { state: "denied" }
              : {
                  state: pairing.approved ? "approved" : "pending",
                  nickname: "本机测试用户",
                },
          ),
        );
      }
    } else if (req.url === "/api/token-usage/sync") {
      assert.equal(hash(req.headers.authorization.slice(7)), pairing.tokenHash);
      assert.ok(body.rows.length > 0);
      assert.ok(
        body.rows.every(
          (r) => r.model === "fixture-gpt" || r.model === "fixture-qwen",
        ),
      );
      assert.ok(!text.includes("PRIVATE"));
      report.sync++;
      report.validRows = body.rows.length;
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url === "/api/token-usage/device") {
      assert.equal(hash(req.headers.authorization.slice(7)), pairing.tokenHash);
      report.revoked++;
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
    await writeFile(
      join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ message: "Local smoke assertion failed" }));
    console.error("Local smoke assertion failed:", e.message);
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const site = "http://127.0.0.1:" + server.address().port;
await writeFile(
  join(profile, "settings.json"),
  JSON.stringify({
    site,
    enabled: false,
    snapshot: {
      version: 1,
      collector: "tokscale@4.20.1",
      captured_at: new Date().toISOString(),
      rows,
    },
    lastCollectedAt: new Date().toISOString(),
    sources: { codex: true, claude: false, opencode: false, qwen: true },
  }),
  { mode: 0o600 },
);
await mkdir(join(home, ".codex/sessions"), { recursive: true });
const timestamp = today + "T02:00:01Z",
  usage = {
    input_tokens: 100,
    cached_input_tokens: 20,
    output_tokens: 30,
    reasoning_output_tokens: 5,
  };
const lines = [
  {
    timestamp,
    type: "session_meta",
    payload: { id: "fixture", timestamp, cwd: "/PRIVATE" },
  },
  { timestamp, type: "turn_context", payload: { model: "fixture-gpt" } },
  {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: usage, last_token_usage: usage },
    },
  },
];
await writeFile(
  join(home, ".codex/sessions/rollout-fixture.jsonl"),
  lines.map(JSON.stringify).join("\n") + "\n",
);
await mkdir(join(home, ".qwen/projects/test/chats"), { recursive: true });
await writeFile(
  join(home, ".qwen/projects/test/chats/session.jsonl"),
  JSON.stringify({
    type: "assistant",
    timestamp,
    sessionId: "fixture-qwen",
    model: "fixture-qwen",
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 30,
      cachedContentTokenCount: 20,
      thoughtsTokenCount: 5,
      totalTokenCount: 130,
    },
  }) + "\n",
);
await writeFile(join(output, "profile-path.txt"), profile);
const bundle =
  process.env.CLUB_USAGE_TAURI_SMOKE_BUNDLE ||
  (process.platform === "win32" ? join(root, "src-tauri/target/release") : join(
    root,
    "src-tauri/target/release/bundle/macos/AI Club Token 用量助手.app",
  ));
const executable = join(bundle, process.platform === "win32"
  ? "aiclub-usage-tauri.exe" : "Contents/MacOS/aiclub-usage-tauri");
let debugPort;
if (verifyWindows) {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  debugPort = probe.address().port;
  await new Promise((r) => probe.close(r));
}
const app = spawn(executable, [], {
  env: {
    ...process.env,
    CLUB_USAGE_TAURI_DATA: profile,
    CLUB_USAGE_TAURI_COLLECTOR_HOME: home,
    ...(process.platform === "win32" ? { WEBVIEW2_USER_DATA_FOLDER: join(profile, "webview") } : {}),
    ...(verifyWindows ? { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1` } : {}),
  },
  stdio: "ignore",
});
console.log(
  "Native smoke app started; isolated HTTP server and credentials. PID",
  app.pid,
);
let cleaning = false;
async function cleanup(status = 0) {
  if (cleaning) return;
  cleaning = true;
  if (app.pid && app.exitCode === null) {
    const exited = new Promise((r) => app.once("exit", r));
    app.kill();
    await exited;
  }
  server.close();
  const stored = JSON.parse(
    await readFile(join(profile, "settings.json"), "utf8"),
  );
  assert.equal(stored.token, undefined);
  assert.equal(stored.credential, undefined);
  const service = "club.changzhouai.usage.tauri.test." + hash(profile);
  if (process.platform === "win32") spawnSync("cmdkey.exe", ["/delete:upload." + service], { stdio: "ignore", windowsHide: true });
  else spawnSync(
    "security",
    [
      "delete-generic-password",
      "-s",
      service,
      "-a",
      "upload",
    ],
    { stdio: "ignore" },
  );
  await writeFile(
    join(output, "final.json"),
    JSON.stringify(
      {
        ...report,
        linkedDataNotStored: !stored.token,
        snapshotRows: stored.snapshot?.rows.length,
        lastSyncedAt: stored.lastSyncedAt,
        enabled: stored.enabled,
      },
      null,
      2,
    ),
  );
  await rm(profile, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  console.log("Cleaned test profile and temporary system credential.");
  process.exit(status);
}
process.on("SIGINT", () => void cleanup());
process.on("SIGTERM", () => void cleanup());
app.on("exit", (code) => {
  if (!cleaning) void cleanup(verifyWindows ? 1 : (code || 0));
});
app.on("error", async (error) => {
  console.error("Cannot launch smoke app:", error.message);
  await cleanup(1);
});
if (verifyWindows) {
  try {
    const { verify } = await import("./verify-windows.mjs");
    await verify({ debugPort, output, report });
    await cleanup();
  } catch (error) {
    console.error(error);
    await cleanup(1);
  }
}
