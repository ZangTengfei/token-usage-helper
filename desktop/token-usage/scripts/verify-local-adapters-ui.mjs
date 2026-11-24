import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { _electron } from "playwright-core";
import { buildLocalFixture } from "../tests/fixtures/build-local-fixture.mjs";
import { CLIENTS } from "../renderer/analytics.mjs";
const root = resolve(import.meta.dirname, ".."),
  profile = await mkdtemp(join(tmpdir(), "club-adapters-ui-"));
const home = join(profile, "fixture-home");
await buildLocalFixture(home);
const output = resolve(root, "../../output/playwright/token-usage-sources-0519");
await mkdir(output, { recursive: true });
let app;
const errors = [];
try {
  await writeFile(
    join(profile, "settings.json"),
    JSON.stringify({
      site: "http://127.0.0.1:3107",
      enabled: false,
      sources: Object.fromEntries(
        Object.keys(CLIENTS).map((id) => [
          id,
          ["zcode", "teleagent", "qoder", "kiro"].includes(id),
        ]),
      ),
    }),
  );
  app = await _electron.launch({
    executablePath: join(
      root,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [root],
    env: {
      ...process.env,
      CLUB_USAGE_APP_DATA: profile,
      CLUB_USAGE_TEST_HOME: home,
    },
  });
  const page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  // Exercise the actual main-process SQLite adapter through the existing local-only action.
  await page.evaluate(() => window.clubUsage.action("collect"));
  const state = await page.evaluate(() => window.clubUsage.state());
  assert.ok(state.snapshot, state.message);
  assert.equal(state.snapshot.collector, "club-usage@1");
  assert.equal(state.snapshot.rows.length, 7);
  const sdk = state.snapshot.rows.find(row => row.model === "qoder-sdk");
  assert.equal(sdk.input, 10);
  assert.equal(sdk.cache_read, 200);
  const view = page;
  await view.locator("nav button[data-view=sources]").click();
  for (const id of ["zcode", "teleagent", "qoder", "kiro"]) {
    assert.equal(await view.locator("#source-" + id).isChecked(), true);
    await view.locator("#source-" + id).press("Space");
    assert.equal(
      (await view.evaluate(() => window.clubUsage.state())).sources[id],
      false,
    );
    await view.locator("#source-" + id).press("Space");
  }
  assert.equal(await view.locator("#sources-list input").count(), Object.keys(CLIENTS).length - 1);
  const antigravity = view.getByRole("switch", { name: "采集 Antigravity", exact: true });
  assert.equal(await antigravity.isChecked(), false);
  await antigravity.press("Space");
  assert.equal((await view.evaluate(() => window.clubUsage.state())).sources.antigravity, true);
  await antigravity.press("Space");
  await view.waitForFunction(() =>
    [...document.querySelectorAll("#sources-list img")].every(
      (i) => i.complete && i.naturalWidth > 0,
    ),
  );
  const sourceIds = Object.keys(CLIENTS).filter((id) => id !== "cursor");
  const nativeWindow = await app.browserWindow(view);
  for (const width of [820, 1080, 1440]) {
    await nativeWindow.evaluate((win, width) => win.setSize(width, 800), width);
    await view.waitForFunction((width) => innerWidth === width, width);
    const items = await view.locator("#sources-list > label").evaluateAll((labels) =>
      labels.map((label) => {
        const { x, y, height } = label.getBoundingClientRect();
        return { id: label.querySelector("input").id, x, y, height };
      }),
    );
    assert.deepEqual(items.map(({ id }) => id), sourceIds.map((id) => "source-" + id));
    if (width === 820) {
      assert.equal(new Set(items.map(({ x }) => x)).size, 1);
      assert.equal(new Set(items.map(({ y }) => y)).size, items.length);
    } else {
      for (let i = 0; i + 1 < items.length; i += 2) {
        assert.ok(items[i].x < items[i + 1].x, "sources flow across the row");
        assert.equal(items[i].y, items[i + 1].y);
        assert.equal(items[i].height, items[i + 1].height);
      }
      assert.equal(new Set(items.map(({ y }) => y)).size, Math.ceil(items.length / 2));
    }
    assert.ok(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await view.locator("#sources-list").screenshot({ path: join(output, `sources-${width}.png`) });
  }
  await view.locator("nav button[data-view=tools]").click();
  await view.getByRole("combobox", { name: "工具", exact: true }).click();
  await view.getByRole("option", { name: "Qoder", exact: true }).click();
  assert.equal(await view.locator("#client").inputValue(), "qoder");
  assert.match(await view.locator("#buckets").innerText(), /未完整提供/);
  assert.doesNotMatch(
    await view.locator("#buckets").innerText(),
    /NaN|undefined/,
  );
  await view.screenshot({ path: join(output, "qoder.png"), fullPage: true });
  await view.getByRole("combobox", { name: "工具", exact: true }).click();
  await view.getByRole("option", { name: "Kiro CLI", exact: true }).click();
  assert.equal(await view.locator("#client").inputValue(), "kiro");
  assert.match(await view.locator("#buckets").innerText(), /20\*/);
  assert.equal(await view.locator('#buckets [title*="部分调用未提供此分项"]').count(), 3);
  assert.match(await view.locator("#counting-note").innerText(), /部分调用未提供完整分项/);
  for (const width of [820, 1080, 1440]) {
    await app
      .browserWindow(view)
      .then((win) => win.evaluate((w, width) => w.setSize(width, 800), width));
    assert.equal(
      await view.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await view.screenshot({
      path: join(output, `kiro-${width}.png`),
      fullPage: true,
    });
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS source grid at 820/1080/1440, keyboard persistence, Electron SQLite adapters and Qoder/Kiro partial buckets",
  );
} finally {
  if (app) await app.close();
  await rm(profile, { recursive: true, force: true });
}
