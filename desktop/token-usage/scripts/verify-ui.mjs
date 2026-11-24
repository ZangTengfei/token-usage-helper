import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { _electron } from "playwright-core";
import { todayISO, shiftDate, dashboard, CLIENTS } from "../renderer/analytics.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  repo = resolve(root, "../..");
const output = join(repo, "output/playwright/token-usage-workbuddy");
await mkdir(output, { recursive: true });
const today = todayISO(),
  rows = [];
for (let i = 0; i < 90; i++) {
  if (i % 11 === 0 && i !== 0) continue;
  for (const client of ["codex", "claude", "opencode"]) {
    if (client === "opencode" && i % 3 !== 0) continue;
    const seed = 90 - i,
      n =
        client === "codex"
          ? seed * 19000
          : client === "claude"
            ? seed * 3300
            : seed * 400;
    const zero = i === 2;
    rows.push({
      date: shiftDate(today, -i),
      client,
      model:
        client === "codex"
          ? "codex-fixture"
          : client === "claude"
            ? "claude-fixture"
            : "open-fixture",
      input: zero ? 0 : n,
      output: zero ? 0 : seed * 120,
      cache_read: zero ? 0 : n * 8,
      cache_write: zero ? 0 : n,
      reasoning: zero ? 0 : seed * 50,
    });
  }
}
const snapshot = {
  version: 1,
  collector: "tokscale@4.20.1",
  captured_at: new Date().toISOString(),
  rows,
};
const profile = await mkdtemp(join(tmpdir(), "club-usage-ui-"));
await writeFile(
  join(profile, "settings.json"),
  JSON.stringify({
    site: "http://127.0.0.1:3107",
    enabled: false,
    snapshot,
    lastCollectedAt: snapshot.captured_at,
    pendingUpload: true,
  }),
  { mode: 0o600 },
);
const executable =
  process.env.CLUB_USAGE_TEST_EXECUTABLE ||
  join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const args = process.env.CLUB_USAGE_TEST_EXECUTABLE ? [] : [root];
async function chooseSelect(page, id, value) {
  const name = id === "client" ? "工具" : "查看范围";
  const label = await page.locator(`#${id} option[value="${value}"]`).textContent();
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}
let app;
const errors = [];
try {
  app = await _electron.launch({
    executablePath: executable,
    args,
    env: { ...process.env, CLUB_USAGE_APP_DATA: profile },
    timeout: 30000,
  });
  const page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.locator("#heatmap button").first().waitFor();
  assert.equal(await page.locator("#heatmap button").count(), 90);
  assert.equal(await page.locator("#heatmap .unknown").count(), 8);
  assert.equal(await page.locator("#heatmap .zero").count(), 1);
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  const supportsCursor = await page.evaluate(() => !!window.clubUsage.importCursor);
  const sourceCount = Object.keys(CLIENTS).length - (supportsCursor ? 0 : 1);
  const toolSelect = page.getByRole("combobox", { name: "工具", exact: true });
  await toolSelect.click();
  assert.equal(await page.getByRole("option").count(), sourceCount + 1);
  await toolSelect.press("Escape");
  assert.equal(await toolSelect.getAttribute("aria-expanded"), "false");
  await toolSelect.press("g");
  await toolSelect.press("o");
  await toolSelect.press("Enter");
  assert.equal(await page.locator("#client").inputValue(), "goose");
  await chooseSelect(page, "client", "all");
  await toolSelect.click();
  await page.locator("#page-title").click();
  assert.equal(await toolSelect.getAttribute("aria-expanded"), "false");
  const rangeSelect = page.getByRole("combobox", { name: "查看范围", exact: true });
  await rangeSelect.press("ArrowDown");
  await rangeSelect.press("End");
  await rangeSelect.press("Enter");
  assert.equal(await page.locator("#heatmap button").count(), 7);
  await chooseSelect(page, "range", "90");
  await page.screenshot({
    path: join(output, "01-overview.png"),
    fullPage: true,
  });
  await page
    .locator(`#heatmap button[data-date="${shiftDate(today, -2)}"]`)
    .click();
  assert.match(await page.locator("#day-detail").innerText(), /0/);
  await page.locator("#heatmap button[aria-pressed=true]").press("ArrowLeft");
  assert.equal(
    await page
      .locator("#heatmap button[aria-pressed=true]")
      .getAttribute("data-date"),
    shiftDate(today, -9),
  );
  await page.locator("#heatmap button[aria-pressed=true]").press("End");
  assert.equal(
    await page
      .locator("#heatmap button[aria-pressed=true]")
      .getAttribute("data-date"),
    today,
  );
  await chooseSelect(page, "client", "claude");
  await page.uncheck("#cache");
  await chooseSelect(page, "range", "7");
  assert.equal(await page.locator("#heatmap button").count(), 7);
  assert.equal(
    await page.locator("#heatmap").getAttribute("data-mode"),
    "bars",
  );
  assert.equal(await page.locator(".daily-column").count(), 7);
  assert.ok(
    await page
      .locator("#heatmap")
      .evaluate((e) => e.getBoundingClientRect().width > 300),
    "weekly bars fill the available chart width",
  );
  await page.locator("#heatmap button[aria-pressed=true]").press("ArrowLeft");
  assert.equal(
    await page
      .locator("#heatmap button[aria-pressed=true]")
      .getAttribute("data-date"),
    shiftDate(today, -1),
  );
  await page.screenshot({
    path: join(output, "07-weekly-bars.png"),
    fullPage: true,
  });
  await chooseSelect(page, "range", "30");
  assert.equal(
    await page.locator("#heatmap").getAttribute("data-mode"),
    "month",
  );
  assert.equal(await page.locator("#heatmap button").count(), 30);
  await page.screenshot({
    path: join(output, "08-month-calendar.png"),
    fullPage: true,
  });
  await chooseSelect(page, "range", "7");
  assert.equal(
    await page.getByRole("switch", { name: "总量包含缓存" }).isChecked(),
    false,
  );

  await page.locator("nav button[data-view=tools]").click();
  const expected = dashboard(snapshot, {
    client: "claude",
    includeCache: false,
    range: 7,
  });
  assert.equal(await page.locator("#models tr").count(), 1);
  assert.equal(
    await page.locator("#models td").nth(0).innerText(),
    "claude-fixture",
  );
  assert.equal(
    await page.locator("#models td").nth(1).getAttribute("title"),
    expected.total.toLocaleString("zh-CN") + " Token",
  );
  assert.equal(await page.locator("#buckets .excluded").count(), 2);
  assert.equal(await page.locator("#tools-composition .segment").count(), 3);
  assert.doesNotMatch(
    await page.locator("#tools-composition").getAttribute("aria-label"),
    /缓存读取|缓存写入/,
  );
  await page.screenshot({ path: join(output, "02-tools.png"), fullPage: true });
  await page.locator("nav button[data-view=sources]").click();
  assert.equal(await page.locator("#sources-list input").count(), sourceCount);
  assert.equal(await page.locator("#sources-list .tool-mark img").count(), sourceCount);
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#sources-list .tool-mark img")].every(
      (i) => i.complete && i.naturalWidth > 0,
    ),
  );
  assert.equal(await page.locator("#source-gemini").isChecked(), false);
  await page.locator("#source-gemini").focus();
  await page.locator("#source-gemini").press("Space");
  await page.waitForFunction(
    () => !document.getElementById("sources-pending").hidden,
  );
  const sourceState = await page.evaluate(() => window.clubUsage.state());
  assert.equal(sourceState.sources.gemini, true);
  assert.equal(sourceState.sources.codex, true);
  assert.equal(sourceState.sourcesChanged, true);
  assert.match(await page.locator("#sources-count").innerText(), new RegExp(`4 / ${sourceCount}`));

  const persisted = JSON.parse(
    await readFile(join(profile, "settings.json"), "utf8"),
  );
  assert.equal(persisted.sources.gemini, true);
  assert.equal(persisted.sources.workbuddy, false);
  await page.locator("#source-workbuddy").focus();
  await page.locator("#source-workbuddy").press("Space");
  assert.equal((await page.evaluate(() => window.clubUsage.state())).sources.workbuddy, true);
  await page.locator("nav button[data-view=tools]").click();
  await chooseSelect(page, "client", "workbuddy");
  assert.equal(await page.locator("#client").inputValue(), "workbuddy");
  assert.equal(JSON.parse(await readFile(join(profile, "settings.json"), "utf8")).sources.workbuddy, true);
  await chooseSelect(page, "client", "all");
  await page.locator("nav button[data-view=sources]").click();
  assert.equal(await page.locator("#data-controls").isVisible(), false);
  await page.screenshot({
    path: join(output, "04-sources.png"),
    fullPage: true,
  });
  await page.locator("nav button[data-view=settings]").click();
  assert.equal(await page.locator("#overview-view").isVisible(), false);
  assert.equal(await page.locator("#last-upload").innerText(), "尚未完成");
  assert.notEqual(await page.locator("#last-read").innerText(), "尚未完成");
  await page.screenshot({
    path: join(output, "03-settings.png"),
    fullPage: true,
  });
  assert.equal(
    await page
      .getByRole("switch", { name: "每小时自动同步", exact: true })
      .isEnabled(),
    false,
  );
  assert.equal(
    await page
      .getByRole("switch", { name: "每小时自动同步", exact: true })
      .getAttribute("aria-checked"),
    "false",
  );
  await page.locator(".advanced summary").click();
  assert.equal(await page.locator("#site").isVisible(), true);
  await page.locator(".advanced summary").click();
  assert.equal(await page.locator("#site").isVisible(), false);
  const cleanState = await page.evaluate(() => window.clubUsage.state());
  const avatarFixture = await readFile(
    join(repo, "public/logo-header-dark.png"),
  );
  await page.route("https://avatars.example.test/photo.png", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: avatarFixture,
    }),
  );
  await app.evaluate(
    ({ BrowserWindow }, state) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().endsWith("/index.html"))
        .webContents.send("usage:changed", state),
    {
      ...cleanState,
      linked: true,
      nickname: "头像测试",
      avatarUrl: "https://avatars.example.test/photo.png",
    },
  );
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".avatar img")].length === 2 &&
      [...document.querySelectorAll(".avatar img")].every(
        (i) => i.complete && i.naturalWidth > 0,
      ),
  );
  assert.equal(
    await page.locator("#account-initial > span").isVisible(),
    false,
  );
  await page.screenshot({
    path: join(output, "09-profile-avatar.png"),
    fullPage: true,
  });
  await page.route("https://avatars.example.test/broken.png", (route) =>
    route.fulfill({ status: 404, body: "missing" }),
  );
  await app.evaluate(
    ({ BrowserWindow }, state) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().endsWith("/index.html"))
        .webContents.send("usage:changed", state),
    {
      ...cleanState,
      linked: true,
      nickname: "头像测试",
      avatarUrl: "https://avatars.example.test/broken.png",
    },
  );
  await page.waitForFunction(
    () => document.querySelectorAll(".avatar img").length === 0,
  );
  assert.equal(await page.locator("#account-initial > span").innerText(), "头");
  await app.evaluate(
    ({ BrowserWindow }, state) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().endsWith("/index.html"))
        .webContents.send("usage:changed", state),
    cleanState,
  );
  assert.equal(await page.locator("#account-initial").innerText(), "本");
  const trayAsset = await app.evaluate(({ nativeImage, app }) => {
    const icon = nativeImage.createFromPath(
      app.getAppPath() + "/vendor/tray.png",
    );
    return { size: icon.getSize(), scales: icon.getScaleFactors() };
  });
  assert.deepEqual(trayAsset.size, { width: 22, height: 22 });
  assert.ok(trayAsset.scales.includes(2), "Retina representation included");
  const trayPage = app.windows().find((p) => p.url().endsWith("/tray.html"));
  assert.ok(trayPage, "native tray BrowserWindow created");
  trayPage.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().endsWith("/tray.html"),
    );
    w.show();
    w.focus();
  });
  await trayPage.locator("#bars .bar").first().waitFor();
  assert.equal(await trayPage.locator("#bars .bar").count(), 7);
  assert.equal(await trayPage.locator("#bars .bar-value").count(), 7);
  assert.notEqual(await trayPage.locator("#tray-week-total").innerText(), "—");
  await trayPage.waitForFunction(
    () =>
      Math.abs(
        innerHeight -
          document.querySelector(".tray-shell").getBoundingClientRect().height,
      ) <= 1,
  );
  assert.equal(
    await trayPage.evaluate(
      () => document.documentElement.scrollHeight > innerHeight,
    ),
    false,
    "popover fits without clipping",
  );
  await trayPage.waitForFunction(
    () =>
      Math.abs(
        innerHeight -
          document.querySelector(".tray-shell").getBoundingClientRect().height,
      ) <= 1,
  );
  // Status messages grow/shrink the window without leaving a fixed empty footer.
  for (const message of [
    "",
    "来源设置已保存，下次成功读取和同步后生效。".repeat(8),
    "",
  ]) {
    await trayPage.evaluate((message) => {
      const node = document.getElementById("tray-message");
      node.textContent = message;
      node.hidden = !message;
    }, message);
    await trayPage.waitForFunction(
      () =>
        Math.abs(
          innerHeight -
            document.querySelector(".tray-shell").getBoundingClientRect()
              .height,
        ) <= 1,
    );
  }
  const labels = await trayPage.locator("#bars .bar-value").allTextContents();
  assert.ok(
    labels.some((value) => value === "0"),
    "zero token days show a literal zero",
  );
  assert.ok(
    labels.some((value) => /[KMB]/.test(value)),
    "daily token amounts visible without hover",
  );
  assert.equal(
    await trayPage.evaluate(() =>
      [...document.querySelectorAll(".bar-value")].some(
        (e) => e.scrollWidth > e.clientWidth,
      ),
    ),
    false,
    "daily labels do not overlap",
  );
  await trayPage.screenshot({ path: join(output, "04-tray.png") });
  await trayPage.locator("#tray-settings").click();
  assert.equal(await page.locator("#settings-view").isVisible(), true);
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().endsWith("/tray.html"))
        .isVisible(),
    ),
    false,
  );
  await page.locator("nav button[data-view=overview]").click();
  await chooseSelect(page, "client", "all");
  await page.check("#cache");
  await chooseSelect(page, "range", "90");
  for (const width of [820, 1080, 1440]) {
    await app.evaluate(({ BrowserWindow }, width) => {
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().endsWith("/index.html"))
        .setSize(width, 860);
    }, width);
    await page.waitForFunction((width) => innerWidth === width, width);
    for (const view of ["overview", "tools", "sources", "settings"]) {
      await page.locator(`nav button[data-view=${view}]`).click();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `${view} at ${width}`,
      );
      assert.equal(
        await page.locator("#page-title").innerText(),
        {
          overview: "总览",
          tools: "工具与模型",
          sources: "统计来源",
          settings: "设置",
        }[view],
      );
    }
    await page.locator("nav button[data-view=overview]").click();
    if (width === 1440)
      await page.screenshot({
        path: join(output, "06-wide-overview.png"),
        fullPage: true,
      });
  }
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().endsWith("/index.html"))
      .setSize(820, 650);
  });
  await page.screenshot({
    path: join(output, "05-minimum-window.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().endsWith("/index.html"))
      .close();
  });
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().endsWith("/index.html"))
        .isVisible(),
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS real Electron overview/filter/cache/date keyboard/model totals/settings/tray actions/minimum size/window residency; screenshots " +
      output,
  );
} finally {
  if (app) await app.close();
  app = null;
  await rm(profile, { recursive: true, force: true });
}
// Old configuration must show an honest migration state, then an actual local read.
const legacy = await mkdtemp(join(tmpdir(), "club-usage-legacy-"));
await writeFile(
  join(legacy, "settings.json"),
  JSON.stringify({
    site: "http://127.0.0.1:3107",
    enabled: false,
    summary: { total: 123, tools: { codex: 123 } },
  }),
  { mode: 0o600 },
);
try {
  app = await _electron.launch({
    executablePath: executable,
    args,
    env: { ...process.env, CLUB_USAGE_APP_DATA: legacy },
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await page.locator("#legacy").waitFor();
  assert.equal(await page.locator("#heatmap .unknown").count(), 90);
  await page.locator("#sync").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#message").textContent.includes("本机统计已更新"),
    {},
    { timeout: 180000 },
  );
  const saved = JSON.parse(
    await readFile(join(legacy, "settings.json"), "utf8"),
  );
  assert.ok(saved.snapshot.rows.length > 0);
  assert.ok(saved.lastCollectedAt);
  assert.ok(!saved.lastSyncedAt);
  assert.equal(saved.pendingUpload, true);
  assert.ok(!saved.token);
  assert.ok(!JSON.stringify(saved.snapshot).includes("prompt"));
  assert.equal(await page.locator("#legacy").isVisible(), false);
  await page.screenshot({
    path: join(output, "06-real-local-scan.png"),
    fullPage: true,
  });
  console.log(
    "PASS legacy migration -> actual bundled collector -> offline/local-only history, with no credential or community upload",
  );
} finally {
  if (app) await app.close();
  app = null;
  await rm(legacy, { recursive: true, force: true });
}

if (process.env.CLUB_USAGE_LEGACY_FIXTURE) {
  const migrated = await mkdtemp(join(tmpdir(), "club-usage-encrypted-"));
  const old = JSON.parse(
    await readFile(process.env.CLUB_USAGE_LEGACY_FIXTURE, "utf8"),
  );
  assert.equal(typeof old.credential, "string");
  old.enabled = false;
  delete old.snapshot;
  await writeFile(join(migrated, "settings.json"), JSON.stringify(old), {
    mode: 0o600,
  });
  try {
    app = await _electron.launch({
      executablePath: executable,
      args,
      env: { ...process.env, CLUB_USAGE_APP_DATA: migrated },
      timeout: 30000,
    });
    const page = await app.firstWindow();
    await page.waitForFunction(
      () =>
        document.querySelector("#legacy").hidden &&
        document.querySelector("#last-read").textContent !== "尚未完成" &&
        !document.querySelector("#sync").disabled,

      {},
      { timeout: 180000 },
    );
    const state = await page.evaluate(() => window.clubUsage.state());
    assert.equal(state.enabled, false);
    assert.equal(state.lastSyncedAt, old.lastSyncedAt);
    assert.ok(state.lastCollectedAt);
    assert.equal(state.pendingUpload, true);
    const saved = JSON.parse(
      await readFile(join(migrated, "settings.json"), "utf8"),
    );
    assert.ok(saved.credential);
    assert.ok(!Object.hasOwn(saved, "token"));
    console.log(
      "PASS old encrypted credentials and paused state preserved; legacy history rebuilt locally without upload",
    );
  } finally {
    if (app) await app.close();
    app = null;
    await rm(migrated, { recursive: true, force: true });
  }
}
