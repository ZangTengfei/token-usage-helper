import test from "node:test";
import assert from "node:assert/strict";
import { CommunityBoard, normalizeBoard } from "../renderer/leaderboard.mjs";
import { UsageController } from "../core.mjs";

const row = { nickname: "成员", tokens: 1234, active_days: 2,
  clients: ["codex"], last_synced_at: "2026-11-02T00:00:00Z", avatar_url: "javascript:alert(1)" };
const data = (period, rows = [row]) => ({ period, rows });
test("public board validates response and strips unsafe avatar and extra fields", () => {
  assert.equal(normalizeBoard(data("7d", [{ ...row, secret: "private" }]), "7d")[0].secret, undefined);
  assert.equal(normalizeBoard(data("7d"), "7d")[0].avatar_url, "");
  assert.throws(() => normalizeBoard(data("30d"), "7d"));
  assert.throws(() => normalizeBoard(data("7d", [{ ...row, tokens: -1 }]), "7d"));
  assert.throws(() => normalizeBoard({ rows: null, period: "7d" }, "7d"));
});
test("board caches per period, deduplicates pending reads, keeps offline results", async () => {
  let calls = 0, clock = 1000, offline = false;
  const board = new CommunityBoard(async (period) => {
    calls++;
    if (offline) throw new Error("offline");
    return { ok: true, site: "https://example.com", data: data(period) };
  }, () => clock);
  board.useSite("https://example.com");
  await Promise.all([board.load("7d"), board.load("7d")]);
  assert.equal(calls, 1);
  await board.load("7d");
  assert.equal(calls, 1);
  await board.load("30d");
  assert.equal(calls, 2);
  offline = true;
  clock += 60_001;
  await board.load("7d");
  assert.equal(board.entry("7d").rows[0].tokens, 1234);
  assert.match(board.entry("7d").error, /上次/);
});
test("site change drops old results including late responses", async () => {
  let finish;
  const board = new CommunityBoard(() => new Promise((r) => { finish = r; }));
  board.useSite("https://old.example");
  const pending = board.load("7d");
  board.useSite("https://new.example");
  finish({ ok: true, site: "https://old.example", data: data("7d") });
  await pending;
  assert.equal(board.entry("7d").rows, undefined);
});
test("a failed IPC response shows an error rather than an empty successful board", async () => {
  const board = new CommunityBoard(async () => ({ ok: false }));
  board.useSite("https://example.com");
  await board.load("7d");
  assert.match(board.entry("7d").error, /检查网络/);
  assert.equal(board.entry("7d").fetchedAt, undefined);
});
test("desktop public board never sends device credentials and rejects arbitrary paths", async () => {
  const calls = [];
  const controller = new UsageController({ settings: { token: "secret" }, api: async (...args) => {
    calls.push(args); return data("7d");
  } });
  assert.equal((await controller.leaderboard("7d")).ok, true);
  assert.deepEqual(calls[0], ["https://changzhouai.club", "/api/token-usage/leaderboard?period=7d", null, undefined, "GET"]);
  await assert.rejects(() => controller.leaderboard("7d&path=private"));
  assert.equal(calls.length, 1);
});
