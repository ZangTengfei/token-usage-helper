# 常州 AI Club Token 用量助手

在本机汇总 AI 编程工具记录的 Token 用量，支持 macOS Apple Silicon 和 Windows x64。开启统计来源后，可按日期、工具和模型查看近 90 天的记录。连接社区后可同步每日模型汇总。

[下载正式客户端](https://changzhouai.club/token-usage)

## 本地开发

需要 Node.js 24、Rust stable 和对应平台的 Tauri 构建工具。Windows 开发环境使用 MSVC 和 WebView2。Tauri 是桌面版本，Electron 用于共享界面和采集逻辑的验证。

```sh
npm ci
npm ci --prefix desktop/token-usage-tauri
npm run check:sources
npm run test:native
npm run test:collector
npm test
npm run build
```

构建结果在 `desktop/token-usage-tauri/src-tauri/target/release/bundle/`。本地构建生成不含应用内更新签名的测试安装包，正式下载和应用内更新由维护者通过发布流程签名。

## 参与维护

从 `main` 建分支，提交改动后发 Pull Request。GitHub Actions 会检查 macOS 和 Windows 的原生采集、共享代码和来源清单，并为 PR 构建测试安装包。PR 的 Checks 显示运行进度，运行结束后会新增一条评论，记录各平台的检查结果和测试包链接。重新运行会留下新评论。PR 阶段不会上传 COS。

- 桌面宿主和原生采集位于 `desktop/token-usage-tauri`。
- 共享界面和 JavaScript 测试位于 `desktop/token-usage`。
- 命令行采集器位于 `public/tools`。
- 新增来源时编辑 `sources.json`，再运行 `node scripts/sync-token-usage-sources.mjs`。社区同步的白名单和数据库规则由服务端维护者配套更新，服务端上线后才发布客户端。

合并和发版由维护者负责，贡献者不需要任何发布凭证。

提交采集问题时，请使用去标识的最小样本，例如来源、版本、字段名和 Token 分项。真实会话、提示词、账号及凭证留在本机。

## 发布（维护者）

正式版本只从 `main` 发布，签名密钥、对象存储和后台账号保存在 GitHub 环境 `desktop-release`，运行前需要维护者批准。

1. 提交并合并版本号改动：`npm run version:set -- 0.5.20`，它会同步 `desktop/token-usage-tauri` 的五份版本清单。
2. 在 Actions 运行「发布 Token 用量助手」，版本号与 `main` 一致，打开「立即发布」后批准环境。流程会构建并保留签名工件，然后分别执行 COS 上传校验、官网发布和应用内更新。若发版提交来自已合并的 PR，每次运行的结果会作为新评论回写到 PR。
3. 只想演练时关闭「立即发布」，后台只保存草稿，不推应用内更新。重新构建的安装包字节不同，同版本不会被覆盖：核对后在后台发布该草稿，再下载这次运行的 Artifacts，用其中的更新包执行 `npm run updater:publish -- --file <更新包> --version 0.5.20 --platform macos --notes-file notes.txt --apply`；否则改用新版本号。

本地也可运行 `npm run desktop:release -- --version 0.5.20 [--upload | --publish] --notes-file notes.txt`，凭证从 `.env.local` 读取。应用内更新地址和签名公钥写在 `tauri.conf.json`，更换会导致已安装的客户端无法自动更新。

### 与社区网站的配合

- 新增统计来源：先在网站仓库更新来源白名单与数据库迁移并上线，再在本仓库改 `sources.json` 并发版。两边的 `sources.json` 应保持一致。
- `public/tools/club-usage.mjs` 以本仓库为准，改动发版后同步一份到网站仓库的 `public/tools/`。
