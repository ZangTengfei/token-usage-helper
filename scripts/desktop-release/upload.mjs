import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import COS from 'cos-nodejs-sdk-v5';
import { createServerClient } from '@supabase/ssr';

export const digest = body => createHash('sha256').update(body).digest('hex');
export function secureOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('发布服务必须是 HTTPS 根地址');
  return url.origin;
}
export async function login(env = process.env) {
  for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'DESKTOP_RELEASE_EMAIL', 'DESKTOP_RELEASE_PASSWORD'])
    if (!env[key]) throw new Error(`缺少 ${key}`);
  secureOrigin(env.NEXT_PUBLIC_SUPABASE_URL);
  const jar = new Map();
  const auth = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: values => values.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const { error } = await auth.auth.signInWithPassword({ email: env.DESKTOP_RELEASE_EMAIL, password: env.DESKTOP_RELEASE_PASSWORD });
  if (error) throw new Error('发布账号登录失败，请检查凭证');
  return {
    cookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    close: () => auth.auth.signOut({ scope: 'local' }),
  };
}
export function apiClient(site, cookie, transport = fetch) {
  const origin = secureOrigin(site);
  return async (path = '', body) => {
    const response = await transport(`${origin}/api/admin/client-releases${path}`, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(300000),
      headers: { Cookie: cookie(), Origin: origin, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    // Never include response bodies (which can contain temporary credentials) in errors.
    if (!response.ok) throw new Error(`后台操作失败 HTTP ${response.status}，可在后台检查草稿后重试`);
    return response.json();
  };
}
export async function uploadObject(upload, file, bytes) {
  const c = upload.credentials;
  const cos = new COS({ SecretId: c.TmpSecretId, SecretKey: c.TmpSecretKey, SecurityToken: c.SecurityToken });
  try {
    await cos.putObject({ Bucket: upload.bucket, Region: upload.region, Key: upload.key,
      Body: createReadStream(file), ContentLength: bytes, ContentType: 'application/octet-stream' });
  } catch { throw new Error('COS 上传失败，可使用相同安装包重试'); }
}
// Restartable: reuse an existing matching draft; immutable published versions are never replaced.
export async function publishPackage({ api, put = uploadObject, file, metadata, publish = false }) {
  const bytes = (await stat(file)).size;
  if (!bytes || bytes > 512 * 1024 ** 2) throw new Error('安装包大小须在 1 字节至 512 MB 之间');
  const hash = digest(await readFile(file));
  let row = (await api()).releases.find(r => r.version === metadata.version && r.platform === metadata.platform && r.arch === metadata.arch);
  if (row && (Number(row.byte_size) !== bytes || (row.sha256 && row.sha256 !== hash)))
    throw new Error('同版本安装包不同，禁止覆盖；请使用新版本号');
  if (!row) row = (await api('', { ...metadata, byte_size: bytes, original_name: basename(file) })).release;
  if (row.file_state !== 'ready') {
    if (!row.canUpload || row.status !== 'draft') throw new Error('草稿不属于发布账号或状态不可上传');
    if (row.file_state === 'verifying') throw new Error('后台仍在校验，请稍后重试');
    const upload = await api(`/${row.id}`, { action: 'authorize' });
    await put(upload, file, bytes);
    row = (await api(`/${row.id}`, { action: 'complete', revision: row.revision })).release;
  }
  if (row.sha256 !== hash) throw new Error('后台 SHA-256 与本地不一致，停止发布');
  if (publish && row.status !== 'published') {
    if (row.status !== 'draft') throw new Error('已归档版本请在后台明确执行回退');
    row = (await api(`/${row.id}`, { action: 'publish', revision: row.revision })).release;
  }
  return { id: row.id, version: row.version, status: row.status, sha256: hash, url: row.url };
}
