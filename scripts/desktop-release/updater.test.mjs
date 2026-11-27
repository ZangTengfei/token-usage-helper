import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyUpdaterSignature, assertForwardRelease } from './updater.mjs';
const base = new URL('../../desktop/token-usage-tauri/src-tauri/tests/fixtures/', import.meta.url);
const body = await readFile(new URL('update.bin', base));
const sig = (await readFile(new URL('update.bin.sig', base), 'utf8')).trim();
const key = (await readFile(new URL('update.pub', base), 'utf8')).trim();
test('accepts real Tauri signature and rejects corrupt bytes, key, signature and trusted comment', () => {
  verifyUpdaterSignature(body, sig, key);
  assert.throws(() => verifyUpdaterSignature(Buffer.concat([body, Buffer.from('x')]), sig, key));
  assert.throws(() => verifyUpdaterSignature(body, sig, 'invalid'));
  assert.throws(() => verifyUpdaterSignature(body, 'invalid', key));
  const lines = Buffer.from(sig, 'base64').toString().split('\n');
  lines[2] += ' altered';
  const changed = Buffer.from(lines.join('\n')).toString('base64');
  assert.throws(() => verifyUpdaterSignature(body, changed, key));
});
test('forward-only publication uses numeric semver and permits identical retries', () => {
  for (const next of ['0.5.9', '0.5.10', '0.6.0', '1.0.0']) assertForwardRelease('0.5.9', next);
  for (const next of ['0.5.8', '0.4.99']) assert.throws(() => assertForwardRelease('0.5.9', next));
  assert.throws(() => assertForwardRelease('garbage', '0.5.9'));
});
