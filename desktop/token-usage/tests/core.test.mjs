import test from "node:test";
import assert from "node:assert/strict";
import { UsageController, siteOrigin, summary } from "../core.mjs";
const id = "11111111-1111-4111-8111-111111111111";
const snapshot = {
  rows: [
    {
      date: "2026-09-16",
      client: "codex",
      model: "fixture-model",
      input: 80,
      output: 25,
      cache_read: 20,
      cache_write: 0,
      reasoning: 5,
    },
  ],
};
function fixture(overrides = {}) {
  const calls = [],
    saved = [],
    opened = [];
  const c = new UsageController({
    settings: { site: "http://127.0.0.1:3107" },
    save: async (x) => saved.push(x),
    open: async (x) => opened.push(x),
    collect: async () => snapshot,
    api: async (_site, path, body, token) => {
      calls.push({ path, body, token });
      if (body?.action === "start")
        return {
          id,
          code: "11111111",
          expires_at: new Date(Date.now() + 600000).toISOString(),
        };
      if (body?.action === "poll")
        return { state: "approved", nickname: "Tester" };
      return { ok: true };
    },
    ...overrides,
  });
  return { c, calls, saved, opened };
}
test("login requires browser approval, hashes only on start; no credentials in renderer state", async () => {
  const { c, calls, saved, opened } = fixture();
  await c.start("My computer");
  assert.match(opened[0], /token-usage\/connect\?id=/);
  assert.equal(c.state().linked, false);
  assert.equal(calls[0].body.token_hash.length, 64);
  assert.ok(!JSON.stringify(c.state()).includes(c.pending.token));
  assert.ok(!JSON.stringify(c.state()).includes(c.pending.secret));
  assert.equal(saved.length, 0);
  await c.poll();
  assert.equal(c.state().linked, true);
  assert.equal(saved.at(-1).token.startsWith("club_usage_"), true);
  assert.equal(calls.filter((x) => x.path.endsWith("/sync")).length, 1);
  assert.equal(c.state().summary.total, 130);
});
test("pause stops upload after an in-flight collection; no automatic sync while paused", async () => {
  let release;
  const { c, calls } = fixture({
    settings: { site: "https://changzhouai.club", token: "test" },
    collect: () => new Promise((r) => (release = r)),
  });
  const flight = c.sync();
  await c.pause();
  release(snapshot);
  await flight;
  assert.equal(calls.length, 0);
  await c.tick();
  assert.equal(calls.length, 0);
});
test("sync is single flight and tick does not retry every three seconds on failure", async () => {
  let release;
  let collections = 0;
  const { c } = fixture({
    settings: { token: "test" },
    collect: () => {
      collections++;
      return new Promise((r) => (release = r));
    },
    api: async () => {
      throw new Error("offline");
    },
  });
  const flight = c.sync();
  await c.sync();
  release(snapshot);
  await flight;
  await c.tick();
  assert.equal(collections, 1);
  assert.match(c.state().message, /offline/);
});
test("changing site while connected forbidden; localhost only HTTP; no credentials in URL", async () => {
  const { c } = fixture({ settings: { token: "test" } });
  await assert.rejects(() => c.setSite("https://example.com"));
  assert.throws(() => siteOrigin("http://example.com"));
  assert.throws(() => siteOrigin("https://u:p@example.com"));
  assert.throws(() => siteOrigin("file:///tmp/test"));
  assert.equal(siteOrigin("http://127.0.0.1:3107"), "http://127.0.0.1:3107");
});
test("failed credential persistence never marks app connected or starts upload", async () => {
  const { c, calls } = fixture({
    save: async () => {
      throw new Error("Keychain locked");
    },
  });
  await c.start("My computer");
  await c.poll();
  assert.equal(c.state().linked, false);
  assert.equal(calls.filter((x) => x.path.endsWith("/sync")).length, 0);
});
test("expired/denied connection never uploads", async () => {
  const { c, calls } = fixture();
  await c.start("My computer");
  c.pending.expires_at = new Date(0).toISOString();
  await c.poll();
  assert.equal(c.pending, null);
  assert.equal(c.state().linked, false);
  assert.equal(calls.length, 1);
});
test("cancel pending approval discards concurrent poll result", async () => {
  let finish;
  const { c } = fixture({
    api: async (_site, _path, body) => {
      if (body.action === "start")
        return {
          id,
          code: "11111111",
          expires_at: new Date(Date.now() + 600000).toISOString(),
        };
      if (body.action === "poll") return new Promise((r) => (finish = r));
      return { state: "denied" };
    },
  });
  await c.start("My computer");
  const poll = c.poll();
  await c.cancel();
  finish({ state: "approved", nickname: "Wrong account" });
  await poll;
  assert.equal(c.state().linked, false);
  assert.equal(c.pending, null);
});
test("logout revokes the credential and clears the local account", async () => {
  const { c, calls, saved } = fixture({
    settings: { token: "test", nickname: "member" },
  });
  await c.disconnect();
  assert.equal(calls[0].path, "/api/token-usage/device");
  assert.equal(c.state().linked, false);
  assert.ok(!saved.at(-1).token);
});
test("Shanghai day and week use disjoint normalized counts", () => {
  const s = summary(snapshot, new Date("2026-09-15T16:01:00Z"));
  assert.equal(s.today, 130);
  assert.equal(s.week, 130);
  assert.equal(s.month, 130);
});

test("new sources are opt-in, preferences persist and only selected clients reach collector", async () => {
  let selected;
  const { c, saved, calls } = fixture({
    collect: async (clients) => {
      selected = clients;
      return snapshot;
    },
  });
  assert.equal(c.state().sources.gemini, false);
  await c.setSource({ client: "gemini", enabled: true });
  assert.equal(saved.at(-1).sources.gemini, true);
  assert.equal(c.state().sourcesChanged, true);
  await c.sync({ upload: false });
  assert.deepEqual(selected.sort(), ["claude", "codex", "gemini", "opencode"]);
  assert.equal(c.state().sourcesChanged, false);
  assert.equal(c.state().sourceStatus.codex.state, "found");
  assert.equal(c.state().sourceStatus.gemini.state, "empty");
  assert.equal(calls.length, 0);
  await assert.rejects(c.setSource({ client: "cursor", enabled: true }));
  await c.setSource({ client: "gemini", enabled: false });
  await c.setSource({ client: "claude", enabled: false });
  await c.setSource({ client: "opencode", enabled: false });
  await assert.rejects(
    c.setSource({ client: "codex", enabled: false }),
    /至少/,
  );
});

test("missing enabled source blocks a partial snapshot; deliberately disabling it permits replacement", async () => {
  const kimi = { ...snapshot.rows[0], client: "kimi" };
  const old = { rows: [...snapshot.rows, kimi] };
  const { c, calls } = fixture({
    settings: { token: "secret", snapshot: old, sources: { kimi: true } },
  });
  await c.sync();
  assert.equal(c.state().snapshot, old);
  assert.equal(c.state().sourceStatus.kimi.state, "missing");
  assert.equal(calls.length, 0);
  await c.setSource({ client: "kimi", enabled: false });
  await c.sync();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].body.rows.every((row) => row.client !== "kimi"));
});

test("source changes cannot race an active read or a pending configuration save", async () => {
  let release;
  const { c } = fixture({
    collect: () =>
      new Promise((r) => {
        release = r;
      }),
  });
  const flight = c.sync();
  await assert.rejects(c.setSource({ client: "kimi", enabled: true }), /等待/);
  release(snapshot);
  await flight;
  let finish;
  c.save = () =>
    new Promise((r) => {
      finish = r;
    });
  const setting = c.setSource({ client: "kimi", enabled: true });
  assert.equal(c.busy, true);
  await c.sync();
  assert.equal(c.state().sources.kimi, false);
  finish();
  await setting;
  assert.equal(c.state().sources.kimi, true);
});

test("device profile refresh is scoped, cached and preserves usage offline", async () => {
  let requests = 0,
    offline = false;
  const { c } = fixture({
    settings: {
      token: "private-token",
      nickname: "old",
      snapshot,
      enabled: false,
    },
    api: async (_site, path, body, token, method) => {
      requests++;
      assert.equal(path, "/api/token-usage/device");
      assert.equal(method, "GET");
      assert.equal(token, "private-token");
      if (offline) throw Error("offline");
      return { nickname: "new", avatar_url: "https://example.com/avatar.png" };
    },
  });
  await c.refreshProfile();
  assert.equal(c.state().avatarUrl, "https://example.com/avatar.png");
  assert.equal(c.state().nickname, "new");
  assert.equal(c.state().snapshot, snapshot);
  assert.equal(c.state().enabled, false);
  await c.refreshProfile();
  assert.equal(requests, 1);
  offline = true;
  c.lastProfileAttempt = 0;
  await c.refreshProfile();
  assert.equal(c.state().avatarUrl, "https://example.com/avatar.png");
  assert.ok(!JSON.stringify(c.state()).includes("private-token"));
});
test("a late profile cannot restore a logged out account", async () => {
  let finish;
  const { c } = fixture({
    settings: { token: "old-token", avatarUrl: "https://example.com/old.png" },
    api: async (_site, _path, _body, _token, method) =>
      method === "GET" ? new Promise((r) => (finish = r)) : { ok: true },
  });
  const pending = c.refreshProfile();
  await c.disconnect();
  finish({ nickname: "old", avatar_url: "https://example.com/late.png" });
  await pending;
  assert.equal(c.state().linked, false);
  assert.equal(c.state().avatarUrl, "");
  assert.equal(c.state().nickname, "");
});
