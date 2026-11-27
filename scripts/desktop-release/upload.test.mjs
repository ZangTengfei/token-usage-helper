import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishPackage, digest, secureOrigin, apiClient } from './upload.mjs';
const metadata = { version: '0.4.1', platform: 'macos', arch: 'arm64' };
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'release-test-'));
  const file = join(dir, 'test.zip');
  const body = Buffer.from('fake package for orchestration tests only');
  await writeFile(file, body);
  try { await fn(file, body); } finally { await rm(dir, { recursive: true, force: true }); }
}
test('upload → server hash verification → publish, retaining server revisions', () => fixture(async (file, body) => {
  const actions = [];
  let row = { ...metadata, id: 'fixture', byte_size: body.length, canUpload: true, file_state: 'pending', status: 'draft', revision: 1 };
  const api = async (path, data) => {
    if (!data) return { releases: [] };
    actions.push(data.action || 'create');
    if (!path) return { release: row };
    if (data.action === 'authorize') return { credentials: {} };
    if (data.action === 'complete') { assert.equal(data.revision, 1); row = { ...row, file_state: 'ready', sha256: digest(body), revision: 3 }; }
    if (data.action === 'publish') { assert.equal(data.revision, 3); row = { ...row, status: 'published' }; }
    return { release: row };
  };
  const result = await publishPackage({ file, metadata, api, put: async () => actions.push('upload'), publish: true });
  assert.deepEqual(actions, ['create', 'authorize', 'upload', 'complete', 'publish']);
  assert.equal(result.status, 'published');
}));
test('matching ready draft can resume; mismatched package cannot replace version', () => fixture(async (file, body) => {
  const row = { ...metadata, id: 'draft', status: 'draft', file_state: 'ready', sha256: digest(body), byte_size: body.length };
  let calls = 0;
  const api = async () => { calls++; return { releases: [row] }; };
  assert.equal((await publishPackage({ file, metadata, api })).status, 'draft');
  assert.equal(calls, 1);
  row.sha256 = 'wrong';
  await assert.rejects(publishPackage({ file, metadata, api, publish: true }), /禁止覆盖/);
  assert.equal(calls, 2);
}));
test('server checksum mismatch never reaches publish', () => fixture(async (file, body) => {
  let row = { ...metadata, id: 'x', status: 'draft', file_state: 'pending', canUpload: true, byte_size: body.length };
  const actions = [];
  const api = async (path, data) => {
    if (!data) return { releases: [row] };
    actions.push(data.action);
    if (data.action === 'complete') return { release: { ...row, sha256: 'mismatch', file_state: 'ready' } };
    return {};
  };
  await assert.rejects(publishPackage({ file, metadata, api, put: async () => {}, publish: true }), /SHA-256/);
  assert.deepEqual(actions, ['authorize', 'complete']);
}));
test('HTTPS only; API errors do not disclose sensitive response data', async () => {
  assert.throws(() => secureOrigin('http://example.com'));
  assert.throws(() => secureOrigin('https://user:pass@example.com'));
  const api = apiClient('https://example.com', () => 'secret', async (url, opts) => {
    assert.equal(opts.redirect, 'error');
    assert.equal(opts.headers.Origin, 'https://example.com');
    return new Response('SECRET', { status: 403 });
  });
  await assert.rejects(api(), e => e.message.includes('403') && !e.message.includes('SECRET'));
});
test('published retry is a no-op; archived retry cannot roll back current release', () => fixture(async (file, body) => {
  const row = { ...metadata, id: 'immutable', byte_size: body.length, sha256: digest(body), file_state: 'ready', status: 'published' };
  const api = async (path, data) => { assert.equal(data, undefined); return { releases: [row] }; };
  assert.equal((await publishPackage({ file, metadata, api, publish: true })).status, 'published');
  row.status = 'archived';
  await assert.rejects(publishPackage({ file, metadata, api, publish: true }), /回退/);
}));
test('another administrator draft cannot be uploaded', () => fixture(async (file, body) => {
  const api = async () => ({ releases: [{ ...metadata, byte_size: body.length, file_state: 'pending', status: 'draft', canUpload: false }] });
  await assert.rejects(publishPackage({ file, metadata, api, put: () => assert.fail('must not upload') }), /不属于/);
}));
