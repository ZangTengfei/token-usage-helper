// Client version lives in five manifests; releases require them to agree.
import { readFile, writeFile } from 'node:fs/promises';
const base = new URL('../../desktop/token-usage-tauri/', import.meta.url);
const jsonNames = ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json'];
const crate = v => `name = "aiclub-usage-tauri"\nversion = "${v}"`;
async function load() {
  const docs = await Promise.all(jsonNames.map(async n => JSON.parse(await readFile(new URL(n, base), 'utf8'))));
  const cargo = (await readFile(new URL('src-tauri/Cargo.toml', base), 'utf8')).replaceAll('\r\n', '\n');
  const lock = (await readFile(new URL('src-tauri/Cargo.lock', base), 'utf8')).replaceAll('\r\n', '\n');
  return { docs, cargo, lock };
}
export async function readVersion() {
  const { docs, cargo, lock } = await load();
  const version = docs[0].version;
  if (docs.some(d => d.version !== version) || docs[1].packages[''].version !== version ||
      !cargo.includes(`version = "${version}"`) || !lock.includes(crate(version))) throw new Error('客户端版本清单不一致');
  return version;
}
export async function setVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('版本号格式应为 0.5.20');
  const old = await readVersion();
  if (old === version) return old;
  const { docs, cargo, lock } = await load();
  for (let i = 0; i < jsonNames.length; i++) {
    docs[i].version = version;
    if (docs[i].packages) docs[i].packages[''].version = version;
    await writeFile(new URL(jsonNames[i], base), JSON.stringify(docs[i], null, 2) + '\n');
  }
  await writeFile(new URL('src-tauri/Cargo.toml', base), cargo.replace(`version = "${old}"`, `version = "${version}"`));
  await writeFile(new URL('src-tauri/Cargo.lock', base), lock.replace(crate(old), crate(version)));
  return old;
}
