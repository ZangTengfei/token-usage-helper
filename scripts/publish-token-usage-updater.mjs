// Explicit publication of signed updater artifacts, separate from the download catalog.
import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import COS from 'cos-nodejs-sdk-v5';
import { prepareUpdate, assertForwardRelease } from './desktop-release/updater.mjs';
const { values: args } = parseArgs({ options: {
  file: { type: 'string' }, version: { type: 'string' }, platform: { type: 'string' },
  'signature-file': { type: 'string' }, 'notes-file': { type: 'string' }, apply: { type: 'boolean', default: false },
} });
async function main() {
  const config = JSON.parse(await readFile(new URL('../desktop/token-usage-tauri/src-tauri/tauri.conf.json', import.meta.url)));
  const prepared = await prepareUpdate({ file: args.file, version: args.version, platform: args.platform,
    signatureFile: args['signature-file'], notes: args['notes-file'] ? await readFile(args['notes-file'], 'utf8') : '', publicKey: config.plugins.updater.pubkey });
  const { body, signature, manifest, objectKey, manifestKey, sha256 } = prepared;
  await mkdir('output/desktop-releases', { recursive: true });
  await writeFile(`output/desktop-releases/${args.version}-${args.platform}-updater.json`, JSON.stringify(manifest, null, 2) + '\n');
  if (!args.apply) { console.log(JSON.stringify({ dryRun: true, signatureVerified: true, objectKey, manifestKey, sha256 })); return; }
  const required = name => { if (!process.env[name]) throw new Error(`缺少 ${name}`); return process.env[name]; };
  const cos = new COS({ SecretId: required('TENCENT_COS_SECRET_ID'), SecretKey: required('TENCENT_COS_SECRET_KEY') });
  const storage = { Bucket: required('TENCENT_COS_BUCKET'), Region: required('TENCENT_COS_REGION') };
  const get = async Key => { try { return Buffer.from((await cos.getObject({ ...storage, Key })).Body); } catch (e) { if (e.statusCode === 404) return null; throw e; } };
  const currentBytes = await get(manifestKey);
  if (currentBytes) {
    const current = JSON.parse(currentBytes);
    assertForwardRelease(current.version, manifest.version);
    if (current.version === manifest.version && JSON.stringify(current) !== JSON.stringify(manifest)) throw new Error('同版本更新清单不同，禁止覆盖');
  }
  // Artifacts are immutable. The small per-platform pointer is switched only after CDN verification.
  for (const [Key, Body, ContentType] of [[objectKey, body, 'application/octet-stream'], [objectKey + '.sig', Buffer.from(signature + '\n'), 'text/plain']]) {
    const old = await get(Key);
    if (old && !old.equals(Body)) throw new Error('同版本更新文件不同，禁止覆盖');
    if (!old) await cos.putObject({ ...storage, Key, Body, ContentLength: Body.length, ContentType,
      CacheControl: 'public, max-age=31536000, immutable', Headers: { 'x-cos-forbid-overwrite': 'true' } });
  }
  const response = await fetch(Object.values(manifest.platforms)[0].url, { redirect: 'error', signal: AbortSignal.timeout(300000) });
  if (!response.ok || !Buffer.from(await response.arrayBuffer()).equals(body)) throw new Error('CDN 更新包校验失败，未切换更新清单');
  const latest = await get(manifestKey);
  if (String(latest) !== String(currentBytes)) throw new Error('更新清单已被其他发布修改，请重新执行');
  const Body = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await cos.putObject({ ...storage, Key: manifestKey, Body, ContentLength: Body.length, ContentType: 'application/json', CacheControl: 'no-cache, max-age=0, must-revalidate' });
  const pointer = await fetch(`https://assets.changzhouai.club/${manifestKey}`, { redirect: 'error', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(30000) });
  if (!pointer.ok || JSON.stringify(await pointer.json()) !== JSON.stringify(manifest)) throw new Error('更新清单已写入，CDN尚未一致；请稍后用同一工件重试');
  console.log(JSON.stringify({ published: true, signatureVerified: true, publicManifestVerified: true, manifestKey, sha256 }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
