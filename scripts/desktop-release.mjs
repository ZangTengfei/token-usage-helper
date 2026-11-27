import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, rm, readdir, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { prepareUpdate } from './desktop-release/updater.mjs';
import { apiClient, digest, login, publishPackage } from './desktop-release/upload.mjs';
import { readVersion } from './desktop-release/version.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const { values: args } = parseArgs({ options: {
  version: { type: 'string' }, file: { type: 'string' }, platform: { type: 'string', default: 'macos' },
  arch: { type: 'string', default: 'arm64' }, 'notes-file': { type: 'string' },
  upload: { type: 'boolean', default: false }, publish: { type: 'boolean', default: false },
  'reuse-build': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} });
const run = (cmd, argv) => cmd === 'npm' ? execFileSync(process.execPath, [process.env.npm_execpath, ...argv], { stdio: 'inherit', cwd: root }) : execFileSync(cmd, argv, { stdio: 'inherit', cwd: root });
async function main() {
  if (args.help) { console.log('npm run desktop:release -- --version 0.4.2 [--upload | --publish] [--notes-file path]\n已有安装包：--file path --platform windows --arch x64 --version 0.4.2 --upload\n用 --reuse-build 上传本次源代码生成的签名工件。\n默认只构建；--upload 上传后台草稿；--publish 上传并切换当前下载。'); return; }
  if (!/^\d+\.\d+\.\d+$/.test(args.version || '')) throw new Error('需要 --version，如 0.4.2');
  if (!['macos', 'windows'].includes(args.platform) || !['arm64', 'x64'].includes(args.arch)) throw new Error('不支持的平台或架构');
  if (args.file && !(args.platform === 'macos' ? /\.(zip|dmg)$/i : /\.(zip|exe|msi)$/i).test(args.file)) throw new Error('安装包扩展名与平台不匹配');
  if (args['reuse-build'] && (args.file || !(args.upload || args.publish))) throw new Error('--reuse-build 需要 --upload 或 --publish，且不能与 --file 同用');
  const notes = args['notes-file'] ? await readFile(args['notes-file'], 'utf8') : '';
  if (notes.length > 4000) throw new Error('更新说明不能超过 4000 字符');
  if (args.publish && !notes.trim()) throw new Error('发布需要 --notes-file 更新说明');
  await mkdir("output", { recursive: true });
  const lockDir = "output/desktop-release-running.lock";
  try { await mkdir(lockDir); } catch { throw new Error("已有本地发布任务运行；若上次被强制终止，请确认进程结束后移除 output/desktop-release-running.lock"); }
  let session;
  try {
    let api;
    if (args.upload || args.publish) {
      session = await login();
      api = apiClient(process.env.DESKTOP_RELEASE_SITE || 'https://changzhouai.club', session.cookie);
      await api(); // Permission/config preflight before an expensive build.
    }
    const resultFile = `output/desktop-releases/${args.version}-${args.platform}-${args.arch}-result.json`;
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    let updater;
    let file = args.file && resolve(args.file);
    if (args['reuse-build']) {
      const build = JSON.parse(await readFile(resultFile, 'utf8'));
      if (build.version !== args.version || build.sourceCommit !== sourceCommit || !build.updater?.signatureVerified)
        throw new Error('找不到当前提交对应的已签名工件');
      file = build.file;
      updater = build.updater;
      if (digest(await readFile(file)) !== build.installerSha256)
        throw new Error('安装包和构建结果的 SHA-256 不一致');
    }
    if (!file) {
      if (!((process.platform === 'darwin' && process.arch === 'arm64' && args.platform === 'macos' && args.arch === 'arm64') || (process.platform === 'win32' && process.arch === 'x64' && args.platform === 'windows' && args.arch === 'x64')))
        throw new Error('自动构建支持 macOS ARM64 / Windows x64，需在对应系统运行');
      const base = 'desktop/token-usage-tauri/';
      // Versions are bumped in a reviewed commit (npm run version:set), never inside the release job.
      const current = await readVersion();
      if (current !== args.version) throw new Error(`仓库中的客户端版本是 ${current}，与发布版本 ${args.version} 不一致；先运行 npm run version:set -- ${args.version} 并合并到 main`);
      run('npm', ['test', '--prefix', 'desktop/token-usage-tauri']);
      run('npm', ['run', 'test:collector']);
      run('npm', ['test']);
      run('npm', ['run', 'build', '--prefix', 'desktop/token-usage-tauri', '--', '--release']);
      if (args.platform === 'windows') {
        const bundle = base + 'src-tauri/target/release/bundle/nsis';
        const installers = (await readdir(bundle)).filter(n => n.endsWith('.exe') && n.includes('_' + args.version + '_'));
        if (installers.length !== 1) throw new Error('未发现唯一匹配版本的 NSIS 安装包');
        await mkdir('output/desktop-releases', { recursive: true });
        file = resolve(`output/desktop-releases/AI-Club-Token-Usage-Helper-${args.version}-windows-x64.exe`);
        await copyFile(resolve(bundle, installers[0]), file);
        await copyFile(resolve(bundle, installers[0] + '.sig'), file + '.sig');
      } else {
        const app = base + 'src-tauri/target/release/bundle/macos/AI Club Token 用量助手.app';
        run('codesign', ['--verify', '--deep', '--strict', app]);
        const version = execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', app + '/Contents/Info.plist'], { encoding: 'utf8' }).trim();
        if (version !== args.version) throw new Error('构建产物版本不一致');
        await mkdir('output/desktop-releases', { recursive: true });
        file = resolve(`output/desktop-releases/AI-Club-Token-Usage-Helper-${args.version}-macos-arm64.zip`);
        run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, file]);
      }
      const updateSource = args.platform === 'windows' ? file : resolve(base + 'src-tauri/target/release/bundle/macos/AI Club Token 用量助手.app.tar.gz');
      const updateFile = args.platform === 'windows' ? file : resolve(`output/desktop-releases/AI-Club-Token-Usage-Helper-${args.version}-macos-arm64.app.tar.gz`);
      const signatureSource = args.platform === 'windows'
        ? file + '.sig'
        : updateSource + '.sig';
      if (updateSource !== updateFile) await copyFile(updateSource, updateFile);
      if (signatureSource !== updateFile + '.sig') await copyFile(signatureSource, updateFile + '.sig');
      const config = JSON.parse(await readFile(base + 'src-tauri/tauri.conf.json'));
      const prepared = await prepareUpdate({ file: updateFile, version: args.version, platform: args.platform, notes, publicKey: config.plugins.updater.pubkey });
      const manifestFile = `output/desktop-releases/${args.version}-${args.platform}-updater.json`;
      await writeFile(manifestFile, JSON.stringify(prepared.manifest, null, 2) + '\n');
      updater = { file: updateFile, signatureFile: updateFile + '.sig', manifestFile, signatureVerified: true };
    }
    let result = { version: args.version, file, updater, uploaded: false, sourceCommit, installerSha256: digest(await readFile(file)) };
    if (api) {
      result = { ...result, ...await publishPackage({ api, file, publish: args.publish, metadata: {
        version: args.version, platform: args.platform, arch: args.arch, notes,
        channel: 'trial', signing_status: args.platform === 'macos' && !args.file ? 'adhoc' : 'unsigned',
        minimum_os: args.platform === 'macos' ? 'macOS 13（旧系统需实测）' : '',
      } }), uploaded: true };
    }
    await mkdir('output/desktop-releases', { recursive: true });
    await writeFile(resultFile, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (session) await session.close().catch(() => {});
    await rm(lockDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
