import test from "node:test";
import assert from "node:assert/strict";
import {
  dashboard,
  heatCells,
  normalizeLocalSnapshot,
  todayISO,
  shiftDate,
} from "../renderer/analytics.mjs";
import { UsageController } from "../core.mjs";
const now = new Date("2026-09-17T04:00:00Z");
const row = (date, client = "codex", n = 10, model = "model") => ({
  date,
  client,
  model,
  input: n,
  output: 2,
  cache_read: 20,
  cache_write: 3,
  reasoning: 1,
});
const snapshot = {
  version: 1,
  collector: "tokscale@4.17.0",
  captured_at: now.toISOString(),
  rows: [
    row("2026-09-17"),
    row("2026-09-16", "claude", 100, "other"),
    row("2026-09-11"),
    row("2026-09-10"),
    row("2026-08-19"),
    row("2026-08-18"),
  ],
};
test("rolling dates use Shanghai, including leap/year boundaries", () => {
  assert.equal(todayISO(new Date("2026-12-31T16:00:00Z")), "2027-01-01");
  assert.equal(shiftDate("2024-03-01", -1), "2024-02-29");
  const r = dashboard(snapshot, { now });
  assert.equal(r.metrics.today.total, 36);
  assert.equal(r.metrics.week.total, 36 + 126 + 36);
  assert.equal(r.metrics.month.total, 36 + 126 + 36 + 36 + 36);
  assert.equal(r.days.length, 90);
});
test("tool/cache filters and all breakdowns agree", () => {
  const r = dashboard(snapshot, {
    now,
    client: "codex",
    includeCache: false,
    range: 7,
  });
  assert.equal(r.total, 26);
  assert.equal(
    r.days.reduce((s, d) => s + d.total, 0),
    r.total,
  );
  assert.equal(
    r.models.reduce((s, d) => s + d.tokens, 0),
    r.total,
  );
  assert.equal(
    r.tools.reduce((s, d) => s + d.tokens, 0),
    r.total,
  );
  assert.equal(
    r.buckets.input + r.buckets.output + r.buckets.reasoning,
    r.total,
  );
  assert.equal(r.metrics.week.total, 26);
  assert.ok(r.cacheRatio > 0);
});
test("missing and explicit zero records remain distinct; no unrecorded tool becomes a zero", () => {
  const zero = {
    ...row("2026-09-17"),
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    reasoning: 0,
  };
  const r = dashboard({ rows: [zero] }, { now, range: 7 });
  assert.equal(r.days.at(-1).known, true);
  assert.equal(r.days.at(-1).level, 0);
  assert.equal(r.days[0].known, false);
  assert.equal(r.days[0].level, -1);
  assert.equal(
    dashboard({ rows: [zero] }, { now, client: "claude" }).metrics.today.days,
    0,
  );
});
test("calendar columns align Monday and exclude placeholder dates", () => {
  const r = dashboard(snapshot, { now });
  const cells = heatCells(r.days);
  assert.equal(cells.length % 7, 0);
  assert.equal(cells.filter(Boolean).length, 90);
  for (let i = 0; i < cells.length; i++)
    if (cells[i])
      assert.equal((new Date(cells[i].date).getUTCDay() + 6) % 7, i % 7);
});
test("large outliers do not erase small positive heat levels", () => {
  const r = dashboard(
    { rows: [row("2026-09-17", "codex", 1), row("2026-09-16", "codex", 1e11)] },
    { now },
  );
  assert.ok(r.days.at(-1).level >= 1);
  assert.equal(r.days.at(-2).level, 5);
});
test("old summaries do not fabricate a daily history", () => {
  const r = dashboard(null, { now });
  assert.ok(r.days.every((d) => !d.known));
  assert.equal(r.metrics.today.days, 0);
});
test("snapshot whitelist, malformed values and duplicate rejection", () => {
  const r = normalizeLocalSnapshot(
    {
      ...snapshot,
      prompt: "secret",
      rows: [{ ...row("2026-09-17"), path: "/private", message: "secret" }],
    },
    now,
  );
  assert.ok(!JSON.stringify(r).includes("secret"));
  assert.ok(!JSON.stringify(r).includes("/private"));
  assert.throws(() =>
    normalizeLocalSnapshot({ rows: [row("2026-09-31")] }, now),
  );
  assert.throws(() =>
    normalizeLocalSnapshot(
      { rows: [{ ...row("2026-09-17"), input: NaN }] },
      now,
    ),
  );
  assert.throws(() =>
    normalizeLocalSnapshot(
      { rows: [row("2026-09-17"), row("2026-09-17")] },
      now,
    ),
  );
});
function currentSnapshot() {
  const today = todayISO();
  return {
    version: 1,
    collector: "tokscale@4.17.0",
    captured_at: new Date().toISOString(),
    rows: [row(today)],
  };
}
test("offline upload preserves local statistics without advancing upload timestamp", async () => {
  const saves = [];
  const c = new UsageController({
    settings: { token: "secret", lastSyncedAt: "2026-01-01T00:00:00Z" },
    save: async (x) => saves.push(x),
    collect: async () => currentSnapshot(),
    api: async () => {
      throw Error("offline");
    },
    open: async () => {},
  });
  await c.sync();
  assert.equal(c.state().snapshot.rows.length, 1);
  assert.ok(c.state().lastCollectedAt);
  assert.equal(c.state().lastSyncedAt, "2026-01-01T00:00:00Z");
  assert.equal(c.state().pendingUpload, true);
  assert.ok(!JSON.stringify(c.state()).includes("secret"));
  assert.ok(saves.length);
});
test("unlinked local read and explicit read-only action never upload", async () => {
  let calls = 0;
  const c = new UsageController({
    save: async () => {},
    collect: async () => currentSnapshot(),
    api: async () => {
      calls++;
      return { ok: true };
    },
    open: async () => {},
  });
  await c.sync();
  assert.equal(calls, 0);
  assert.equal(c.state().snapshot.rows.length, 1);
  c.settings.token = "secret";
  await c.sync({ upload: false });
  assert.equal(calls, 0);
  assert.equal(c.state().lastSyncedAt, null);
});
test("empty/read-error never erase previously cached rows or claim success", async () => {
  const cached = currentSnapshot();
  const c = new UsageController({
    settings: { snapshot: cached, lastCollectedAt: cached.captured_at },
    save: async () => {},
    collect: async () => ({ rows: [] }),
    open: async () => {},
  });
  await c.sync();
  assert.equal(c.settings.snapshot, cached);
  assert.match(c.state().message, /未发现/);
  assert.equal(c.state().lastCollectedAt, cached.captured_at);
});
test("successful upload clears pending while preserving separate collection time", async () => {
  const c = new UsageController({
    settings: { token: "secret" },
    save: async () => {},
    collect: async () => currentSnapshot(),
    api: async () => ({ ok: true }),
    open: async () => {},
  });
  await c.sync();
  assert.equal(c.state().pendingUpload, false);
  assert.ok(c.state().lastCollectedAt);
  assert.ok(c.state().lastSyncedAt);
});

test("resume during a cancelled read queues exactly one fresh sync", async () => {
  let release,
    reads = 0,
    uploads = 0;
  const c = new UsageController({
    settings: { token: "secret" },
    save: async () => {},
    collect: () =>
      ++reads === 1
        ? new Promise((r) => (release = r))
        : Promise.resolve(currentSnapshot()),
    api: async () => {
      uploads++;
      return { ok: true };
    },
    open: async () => {},
  });
  const flight = c.sync();
  await c.pause();
  await c.pause();
  release(currentSnapshot());
  await flight;
  assert.equal(reads, 2);
  assert.equal(uploads, 1);
  assert.equal(c.state().pendingUpload, false);
});
test("acknowledged upload is not mislabeled as network failure when saving status fails", async () => {
  let writes = 0;
  const c = new UsageController({
    settings: { token: "secret" },
    save: async () => {
      if (++writes === 2) throw Error("disk unavailable");
    },
    collect: async () => currentSnapshot(),
    api: async () => ({ ok: true }),
    open: async () => {},
  });
  await c.sync();
  assert.ok(c.state().lastSyncedAt);
  assert.match(c.state().message, /社区已接收/);
});

test("new collector provenance and expanded source survive offline normalization", () => {
  const current = {
    ...snapshot,
    collector: "tokscale@4.20.1",
    rows: [row("2026-09-17", "cline")],
  };
  const clean = normalizeLocalSnapshot(current, now);
  assert.equal(clean.collector, "tokscale@4.20.1");
  assert.equal(clean.rows[0].client, "cline");
  assert.equal(
    normalizeLocalSnapshot(snapshot, now).collector,
    "tokscale@4.17.0",
  );
  assert.equal(dashboard(current, { now }).tools[0].name, "cline");
});

test("profile image URLs cannot load local files, scripts or credential URLs", async () => {
  const { safeAvatarUrl } = await import("../renderer/profile.mjs");
  for (const url of [
    "file:///private/a.png",
    "javascript:alert(1)",
    "data:image/svg+xml,test",
    "http://example.com/a.png",
    "https://name:secret@example.com/a.png",
  ])
    assert.equal(safeAvatarUrl(url), "");
  assert.equal(
    safeAvatarUrl("https://example.com/a.png"),
    "https://example.com/a.png",
  );
});
