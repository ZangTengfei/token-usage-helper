import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

export async function verify({ debugPort, output, report }) {
  let browser;
  const errors = [];
  try {
    const deadline = Date.now() + 30_000;
    while (!browser) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 1000 });
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    const context = browser.contexts()[0];
    let page;
    while (!page && Date.now() < deadline) {
      page = context.pages().find((p) => p.url().endsWith("/renderer/index.html"));
      if (!page) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(page, "main WebView loaded the bundled application");
    page.on("pageerror", (error) => errors.push(error.message));
    await page.locator("#heatmap button").first().waitFor();
    assert.equal(await page.locator("#heatmap button").count(), 90);
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");
    const state = () => page.evaluate(() => window.clubUsage.state());
    async function waitState(predicate) {
      const until = Date.now() + 30_000;
      let latest;
      while (Date.now() < until) {
        latest = await state();
        if (predicate(latest)) return latest;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`Native state timed out: ${latest?.message}`);
    }
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal((await state()).version, manifest.version);
    assert.equal((await state()).linked, false);
    for (const range of ["7", "30", "90"]) {
      const label = await page.locator(`#range option[value="${range}"]`).textContent();
      await page.getByRole("combobox", { name: "查看范围", exact: true }).click();
      await page.getByRole("option", { name: label, exact: true }).click();
      assert.equal(await page.locator("#heatmap button").count(), Number(range));
      assert.equal(await page.locator('#daily-stack svg g[role="button"]').count(), Number(range));
    }
    await page.locator('[data-stack="client"]').click();
    assert.match(await page.locator("#daily-stack-legend").innerText(), /Codex/);
    await page.locator('[data-stack="model"]').click();
    assert.match(await page.locator("#daily-stack-legend").innerText(), /smoke-fixture/);
    await page.screenshot({ path: join(output, "windows-overview.png"), fullPage: true });
    await page.locator('nav [data-view="sources"]').click();
    assert.equal(await page.locator('#sources-view input[role="switch"]').count(), 23);
    assert.equal(await page.locator("#source-antigravity").isChecked(), false);
    const csv = {
      name: "usage.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens\n" +
        new Date().toISOString() + ",cursor-test,4,3,2,1"),
    };
    for (const expected of ["新增 1 条", "新增 0 条，重复 1 条"]) {
      const choosing = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "导入 Cursor CSV" }).click();
      await (await choosing).setFiles(csv);
      const imported = await waitState((s) => !s.busy && s.message.includes(expected));
      assert.equal(imported.sources.cursor, true);
      assert.equal(imported.snapshot.rows.filter(r => r.client === "cursor").length, 1);
    }
    await page.locator("#source-claude").check();
    await waitState((s) => s.sources.claude === true);
    assert.equal((await state()).sources.claude, true);
    await page.locator("#source-claude").uncheck();
    await waitState((s) => s.sources.claude === false);
    assert.equal((await state()).sources.claude, false);
    await page.screenshot({ path: join(output, "windows-sources.png"), fullPage: true });
    await page.getByRole("button", { name: "小时趋势", exact: true }).click();
    await page.locator("#hourly-plot svg").waitFor();
    assert.equal(await page.locator('#hourly-plot svg rect[tabindex="0"]').count(), 24);
    assert.match(await page.locator("#hourly-status").innerText(), /北京时间/);
    const hourly = await page.evaluate(() => window.clubUsage.action("hourly"));
    assert.equal(hourly.ok, true);
    assert.deepEqual(hourly.sources, ["codex"]);
    assert.equal(hourly.hours.length, 24);
    assert.equal(hourly.hours.reduce((sum, row) => sum + row.total, 0), 130);
    assert.equal(hourly.hours.find((row) => row.total > 0).rate, 0.2);
    assert.ok(!JSON.stringify(hourly).includes("PRIVATE"));
    await page.screenshot({ path: join(output, "windows-hourly.png"), fullPage: true });
    await page.locator('nav [data-view="leaderboard"]').click();
    for (const period of ["today", "7d", "30d", "all"]) {
      await page.locator(`[data-period="${period}"]`).click();
      await page.waitForFunction(() => document.querySelector(".board-panel").getAttribute("aria-busy") === "false");
      assert.match(await page.locator("#board-rows").innerText(), /Windows 测试成员/);
    }
    assert.equal(report.board, 4);
    await page.locator('nav [data-view="settings"]').click();
    await page.locator("#collect").click();
    const collected = await waitState((s) => !s.busy && s.snapshot?.rows.some((r) => r.model === "fixture-gpt"));
    assert.equal(collected.snapshot.rows.length, 3);
    assert.equal(collected.snapshot.rows.reduce((sum, row) => sum + row.input + row.output + row.cache_read + row.cache_write + row.reasoning, 0), 270);
    assert.ok(!JSON.stringify(collected).includes("PRIVATE"));
    assert.equal(report.sync, 0);
    const tray = context.pages().find((p) => p.url().endsWith("/renderer/tray.html"));
    assert.ok(tray, "native tray WebView exists");
    assert.equal((await tray.evaluate(() => window.clubUsage.state())).snapshot.rows.length, 3);
    assert.equal((await tray.evaluate(() => window.clubUsage.action("open", "tools"))).ok, true);
    await page.waitForFunction(() => !document.querySelector("#tools-view").hidden);
    assert.deepEqual(errors, []);
    console.log("PASS Windows WebView2: IPC, 7/30/90-day heatmaps and daily stacks, model/client dimensions, 24-hour native totals/cache rate, 22 sources, public boards, native collector, tray navigation; no community uploads.");
  } finally {
    await browser?.close();
  }
}
