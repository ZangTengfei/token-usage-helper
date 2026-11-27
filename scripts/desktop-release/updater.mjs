// Tauri/minisign Ed25519 verification using Node's native crypto, including trusted comment.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
export const UPDATE_BASE = 'https://assets.changzhouai.club/downloads/token-usage';
export const TARGETS = { macos: 'darwin-aarch64', windows: 'windows-x86_64' };
export function verifyUpdaterSignature(body, signature, publicKey) {
  try {
    const key = Buffer.from(Buffer.from(publicKey, 'base64').toString().trim().split(/\r?\n/)[1], 'base64');
    const lines = Buffer.from(signature, 'base64').toString().trim().split(/\r?\n/);
    const sig = Buffer.from(lines[1], 'base64');
    const global = Buffer.from(lines[3], 'base64');
    if (key.length !== 42 || key.subarray(0, 2).toString() !== 'Ed' || sig.length !== 74 || global.length !== 64 ||
        !sig.subarray(2, 10).equals(key.subarray(2, 10)) || !lines[2].startsWith('trusted comment: ')) throw Error();
    const algorithm = sig.subarray(0, 2).toString();
    if (!['ED', 'Ed'].includes(algorithm)) throw Error();
    const publicObject = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
    const data = algorithm === 'ED' ? createHash('blake2b512').update(body).digest() : body;
    if (!verify(null, data, publicObject, sig.subarray(10)) ||
        !verify(null, Buffer.concat([sig.subarray(10), Buffer.from(lines[2].slice(17))]), publicObject, global)) throw Error();
  } catch { throw new Error('更新包签名无效或与客户端公钥不匹配'); }
}
export async function prepareUpdate({ file, signatureFile = file + '.sig', version, platform, notes = '', publicKey }) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '') || !TARGETS[platform]) throw new Error('无效更新版本或平台');
  if (notes.length > 4000) throw new Error('更新说明过长');
  if (!(platform === 'macos' ? /\.app\.tar\.gz$/ : /\.exe$/).test(file)) throw new Error('Mac 更新必须是 .app.tar.gz，Windows 必须是 NSIS .exe');
  const body = await readFile(file);
  if (!body.length || body.length > 512 * 1024 ** 2) throw new Error('无效更新包大小');
  if (platform === 'windows' && body.subarray(0, 2).toString() !== 'MZ') throw new Error('不是 Windows 可执行文件');
  if (platform === 'macos' && body.readUInt16BE(0) !== 0x1f8b) throw new Error('不是 gzip 更新包');
  const signature = (await readFile(signatureFile, 'utf8')).trim();
  verifyUpdaterSignature(body, signature, publicKey);
  const target = TARGETS[platform];
  const filename = `AI-Club-Token-Usage-Helper-${version}-${target}${platform === 'macos' ? '.app.tar.gz' : '-setup.exe'}`;
  const objectKey = `downloads/token-usage/${version}/${target}/${filename}`;
  const manifest = { version, notes, platforms: { [target]: { url: `${UPDATE_BASE.slice(0, -'/downloads/token-usage'.length)}/${objectKey}`, signature } } };
  return { body, signature, manifest, objectKey, manifestKey: `downloads/token-usage/updates/stable/${target}.json`, sha256: createHash('sha256').update(body).digest('hex') };
}
export function assertForwardRelease(current, next) {
  if (!/^\d+\.\d+\.\d+$/.test(current) || !/^\d+\.\d+\.\d+$/.test(next)) throw new Error('更新清单版本无效');
  const a = current.split('.').map(Number), b = next.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return;
    if (b[i] < a[i]) throw new Error('禁止降低应用内更新版本');
  }
}
