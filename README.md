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

构建结果在 `desktop/token-usage-tauri/src-tauri/target/release/bundle/`。本地构建生成测试安装包，正式下载和应用内更新由常州 AI Club 发布流程签名。

## 参与维护

从 `main` 建分支，提交改动后发 Pull Request。GitHub Actions 会检查 macOS 和 Windows 的原生采集，以及共享代码和来源清单。

- 桌面宿主和原生采集位于 `desktop/token-usage-tauri`。
- 共享界面和 JavaScript 测试位于 `desktop/token-usage`。
- 命令行采集器位于 `public/tools`。
- 新增来源时编辑 `sources.json`，再运行 `node scripts/sync-token-usage-sources.mjs`。社区同步的白名单和数据库规则由服务端维护者配套更新。

提交采集问题时，请使用去标识的最小样本，例如来源、版本、字段名和 Token 分项。真实会话、提示词、账号及凭证留在本机。
