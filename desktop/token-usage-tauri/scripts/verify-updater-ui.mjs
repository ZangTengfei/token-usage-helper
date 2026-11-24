// Shared renderer integration in a fresh Chrome profile; no real logs, account or installation.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const renderer = resolve(repo, 'desktop/token-usage/renderer');
const output = resolve(repo, 'output/token-usage-updater-20261104');
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  const path = resolve(renderer, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!path.startsWith(renderer + sep)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(path === resolve(renderer, 'vendor/icon.png') ? resolve(repo, 'desktop/token-usage-tauri/dist/vendor/icon.png') : path);
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' })[extname(path)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    let listener, finish;
    const status = { phase: 'current', version: null, message: '已是最新版本', downloaded: 0, total: null };
    window.updateFixture = (state) => { Object.assign(status, state); listener?.({ ...status }); };
    window.finishFixture = () => finish?.();
    window.updateCalls = [];
    window.clubUsage = {
      state: async () => ({ site: 'https://changzhouai.club', version: '0.5.9', packaged: true, message: '', sources: {}, sourceStatus: {}, detectedSources: {}, enabled: false, busy: false }),
      subscribe: () => {}, navigate: () => {}, action: async () => ({ ok: true }),
      updateState: async () => ({ ...status }), updateSubscribe: cb => { listener = cb; },
      updateAction: async action => {
        window.updateCalls.push(action);
        if (action === 'check') window.updateFixture({ phase: 'available', version: '0.6.0', message: '有新版本可用' });
        else {
          window.updateFixture({ phase: 'downloading', downloaded: 25, total: 100, message: '正在下载更新…' });
          await new Promise(r => { finish = r; });
          window.updateFixture({ phase: 'error', message: '更新未完成，请重试；本机统计已保留。' });
        }
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  const dot = page.locator('#update-dot');
  const available = version => page.evaluate(v => window.updateFixture({ phase: 'available', version: v }), version);
  await available('0.6.0');
  assert.equal(await dot.isVisible(), true);
  await page.locator('nav [data-view="settings"]').click();
  assert.equal(await dot.isVisible(), false);
  await page.reload();
  await available('0.6.0');
  assert.equal(await dot.isVisible(), false);
  await available('0.6.1');
  assert.equal(await dot.isVisible(), true);
  await page.locator('nav [data-view="settings"]').click();
  await page.locator('#update-check').click();
  await page.locator('#update-install').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#update-install').textContent(), '更新并重启');
  for (const width of [820, 1080, 1440]) {
    await page.setViewportSize({ width, height: 860 });
    await page.locator('#app-update').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${output}/settings-${width}.png`, fullPage: true });
  }
  await page.locator('#update-install').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#update-check').isDisabled(), true);
  assert.equal(await page.locator('#update-progress').getAttribute('value'), '25');
  await page.evaluate(() => window.updateFixture({ phase: 'installing', message: '正在安装，完成后自动重启…' }));
  assert.equal(await page.locator('#update-install').textContent(), '正在安装…');
  await page.evaluate(() => window.finishFixture());
  await page.waitForFunction(() => !document.getElementById('update-install').disabled);
  assert.match(await page.locator('#update-status').textContent(), /本机统计已保留/);
  await page.locator('nav [data-view="overview"]').click();
  await page.locator('#update-notice').click();
  assert.equal(await page.locator('#settings-view').isVisible(), true);
  assert.equal(await page.locator('#update-install').evaluate(el => el === document.activeElement), true);
  assert.deepEqual(await page.evaluate(() => window.updateCalls), ['check', 'install']);
  assert.deepEqual(errors, []);
  console.log('PASS Chrome: settings/footer, keyboard install, progress, busy/failed retry, 820/1080/1440 layout; fixture only.');
} finally {
  await browser?.close();
  await new Promise(r => server.close(r));
}
