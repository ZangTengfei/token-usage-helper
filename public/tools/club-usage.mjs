#!/usr/bin/env node
// AI Club usage helper. Only aggregate statistics leave the computer.
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rm,
  chmod,
  access,
  stat,
  readdir,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { spawn } from "node:child_process";

export const COLLECTOR = "tokscale@4.23.1";
const configDir =
  process.env.CLUB_USAGE_CONFIG_DIR ||
  join(homedir(), ".config", "aiclub-usage");
const configFile = join(configDir, "config.json");
// BEGIN GENERATED USAGE SOURCES
// prettier-ignore
export const SUPPORTED_CLIENTS = ["codex","claude","opencode","gemini","kimi","qwen","openclaw","dsh","cline","roocode","kilocode","copilot","hermes","pi","goose","droid","workbuddy","zcode","teleagent","qoder","kiro","antigravity"];
// prettier-ignore
export const DEFAULT_CLIENTS = ["codex","claude","opencode"];
// prettier-ignore
const LOCAL_CLIENTS = ["zcode","teleagent","qoder","kiro"];
// END GENERATED USAGE SOURCES
const allowedClients = new Set(SUPPORTED_CLIENTS);
const antigravityClients = ["antigravity", "antigravity-cli", "antigravity-extension"];
function editorRoots(home) {
  return [
    join(home, "Library/Application Support/Code/User/globalStorage"),
    join(home, ".config/Code/User/globalStorage"),
    join(home, "AppData/Roaming/Code/User/globalStorage"),
    join(home, ".vscode-server/data/User/globalStorage"),
  ];
}
// Directory hints only: presence does not prove that any logs are parseable.
export async function detectSources(home = homedir(), env = process.env) {
  const tokscaleConfig = env.TOKSCALE_CONFIG_DIR || join(
    process.platform === "win32"
      ? env.APPDATA || join(home, "AppData/Roaming")
      : process.platform === "linux" && env.XDG_CONFIG_HOME || join(home, ".config"),
    "tokscale",
  );
  const roots = {
    claude: ["projects", "transcripts"].map((p) =>
      join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), p),
    ),
    codex: ["sessions", "archived_sessions"].map((p) =>
      join(env.CODEX_HOME || join(home, ".codex"), p),
    ),
    opencode: [
      join(env.XDG_DATA_HOME || join(home, ".local/share"), "opencode"),
    ],
    gemini: [join(env.GEMINI_CLI_HOME || join(home, ".gemini"), "tmp")],
    antigravity: [
      join(home, ".gemini/antigravity/conversations"),
      join(env.GEMINI_CLI_HOME || join(home, ".gemini"), "antigravity-cli/conversations"),
      join(tokscaleConfig, "antigravity-cache/sessions"),
    ],
    kimi: [join(home, ".kimi/sessions"), join(home, ".kimi-code/sessions")],
    qwen: [join(home, ".qwen/projects")],
    cline: editorRoots(home).map((p) =>
      join(p, "saoudrizwan.claude-dev/tasks"),
    ),
    roocode: editorRoots(home).map((p) =>
      join(p, "rooveterinaryinc.roo-cline/tasks"),
    ),
    kilocode: editorRoots(home).map((p) => join(p, "kilocode.kilo-code/tasks")),
    copilot: [join(home, ".copilot")],
    hermes: [env.HERMES_HOME || join(home, ".hermes")],
    pi: [env.PI_CODING_AGENT_DIR || join(home, ".pi/agent")],
    goose: [
      env.GOOSE_PATH_ROOT || join(home, ".local/share/goose"),
      join(home, "Library/Application Support/goose"),
      join(home, ".local/share/Block/goose"),
      join(home, "Library/Application Support/Block/goose"),
      join(home, "AppData/Roaming/Block/goose/data"),
    ],
    droid: [env.DROID_SESSIONS_DIR || join(home, ".factory/sessions")],
    workbuddy: [".workbuddy", ".workbuddy-ai"].map((p) =>
      join(home, p, "projects"),
    ),
    dsh: [env.DSH_HOME || join(home, ".dsh")],
    openclaw: [".openclaw", ".clawdbot", ".moltbot", ".moldbot"].map((p) =>
      join(home, p, "agents"),
    ),
  };
  const native = Object.fromEntries(
    await Promise.all(
      Object.entries(roots).map(async ([id, paths]) => {
        const results = await Promise.all(
          paths.map(async (path) => {
            try {
              return (await stat(path)).isDirectory() ? "found" : "absent";
            } catch (error) {
              return error.code === "ENOENT" ? "absent" : "unavailable";
            }
          }),
        );
        return [
          id,
          results.includes("found")
            ? "found"
            : results.includes("unavailable")
              ? "unavailable"
              : "absent",
        ];
      }),
    ),
  );
  const { detectLocalSources } = await import("./local-usage-adapters.mjs");
  return { ...native, ...(await detectLocalSources(home, env)) };
}
export function dateWindow(now = new Date()) {
  const until = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const first = new Date(`${until}T00:00:00Z`);
  first.setUTCDate(first.getUTCDate() - 89);
  return { since: first.toISOString().slice(0, 10), until };
}
export function normalizeGraph(graph, now = new Date()) {
  if (graph?.meta?.version !== "4.23.1" || !Array.isArray(graph.contributions))
    throw new Error("采集器格式已改变，请更新社区助手。");
  const { since, until } = dateWindow(now);
  // dateRange describes days with records, not the requested window. A new
  // member may have only one day of logs; validate each day below instead.
  const merged = new Map();
  for (const day of graph.contributions) {
    if (
      typeof day.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day.date) ||
      day.date < since ||
      day.date > until ||
      !Array.isArray(day.clients)
    )
      throw new Error("采集日期或数据格式不正确。");
    for (const source of day.clients) {
      const client = antigravityClients.includes(source.client)
        ? "antigravity"
        : source.client;
      if (
        !allowedClients.has(client) ||
        typeof source.modelId !== "string" ||
        !source.modelId.trim() ||
        source.modelId.length > 120
      )
        throw new Error("采集器返回了不支持的工具或模型。");
      // Tokscale 4.23.1 normalizes these into disjoint buckets, including Codex reasoning.
      const row = {
        date: day.date,
        client,
        model: source.modelId.trim(),
        input: source.tokens?.input,
        output: source.tokens?.output,
        cache_read: source.tokens?.cacheRead,
        cache_write: source.tokens?.cacheWrite,
        reasoning: source.tokens?.reasoning,
      };
      const fields = [
        "input",
        "output",
        "cache_read",
        "cache_write",
        "reasoning",
      ];
      for (const key of fields)
        if (!Number.isSafeInteger(row[key]) || row[key] < 0 || row[key] > 1e12)
          throw new Error("采集器返回了异常 Token 数量。");
      const key = JSON.stringify([row.date, row.client, row.model]);
      const previous = merged.get(key);
      if (previous) {
        for (const field of fields) {
          previous[field] += row[field];
          if (previous[field] > 1e12) throw new Error("单日用量超出限制。");
        }
      } else merged.set(key, row);
    }
  }
  if (merged.size > 5000) throw new Error("统计条目超出内测限制。");
  return {
    version: 1,
    collector: COLLECTOR,
    captured_at: now.toISOString(),
    rows: [...merged.values()],
  };
}
export function validateSite(raw) {
  const url = new URL(raw);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/", ""].includes(url.pathname)
  )
    throw new Error("请输入网站根地址。");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("社区地址必须使用 HTTPS（本机测试除外）。");
  return url.origin;
}
async function config() {
  let data;
  try {
    data = JSON.parse(await readFile(configFile, "utf8"));
  } catch {
    throw new Error("请先运行 setup 绑定社区账号。");
  }
  if (!/^club_usage_[A-Za-z0-9_-]{43}$/.test(data.token))
    throw new Error("凭证格式不正确，请重新 setup。");
  return { ...data, site: validateSite(data.site) };
}
async function ask(text, secret = false) {
  process.stdout.write(text);
  const output = secret
    ? new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      })
    : process.stdout;
  const rl = createInterface({
    input: process.stdin,
    output,
    terminal: Boolean(process.stdin.isTTY),
  });
  try {
    return (await rl.question("")).trim();
  } finally {
    rl.close();
    if (secret) process.stdout.write("\n");
  }
}
async function setup(args) {
  const siteFlag = args.indexOf("--site");
  const site = validateSite(
    siteFlag >= 0 ? args[siteFlag + 1] : "https://changzhouai.club",
  );
  console.log(`请在 ${site}/token-usage#connect 登录并生成专用上传凭证。`);
  console.log("每个账号仅保留一个数据源，首次同步会替换原统计。");
  const token = await ask("粘贴上传凭证（输入不显示）：", true);
  if (!/^club_usage_[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error("凭证格式不正确。");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(configFile, JSON.stringify({ site, token }) + "\n", {
    mode: 0o600,
  });
  await chmod(configFile, 0o600);
  console.log("已保存到本机。运行 preview 预览统计，运行 sync 上传。");
}
// Stage only usage metadata. Never expose session_usage.used (context occupancy)
// to Tokscale's WorkBuddy SQLite fallback, or copy conversation text to temp files.
export async function stageWorkBuddy(home, target) {
  const usageKeys = [
    "cachedMissTokens",
    "cacheMissTokens",
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
    "total_tokens",
    "totalTokens",
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "cache_read_input_tokens",
    "cacheReadInputTokens",
    "cacheTokens",
    "prompt_cache_hit_tokens",
    "cached_tokens",
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "cachedWriteTokens",
    "prompt_cache_write_tokens",
    "completion_thinking_tokens",
    "completionThinkingTokens",
    "reasoningTokens",
  ];
  const pick = (value, keys) =>
    Object.fromEntries(
      keys
        .filter((key) => value?.[key] !== undefined)
        .map((key) => [key, value[key]]),
    );
  const usage = (value) =>
    pick(
      value,
      usageKeys.filter((key) => Number.isSafeInteger(value?.[key])),
    );
  let records = 0;
  async function walk(source, destination) {
    let entries;
    try {
      entries = await readdir(source, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(source, entry.name),
        out = join(destination, entry.name);
      if (entry.isDirectory()) await walk(path, out);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const fallback = Math.trunc((await stat(path)).mtimeMs);
        const input = createReadStream(path, { encoding: "utf8" });
        const lines = createInterface({ input, crlfDelay: Infinity });
        input.on("error", () => lines.close());
        const rows = [];
        try {
          for await (const line of lines) {
            let row;
            try {
              row = JSON.parse(line);
            } catch {
              continue;
            }
            if (
              !row ||
              !(
                row.type === "function_call" ||
                (row.type === "message" && row.role === "assistant")
              )
            )
              continue;
            const clean = pick(row, [
              "id",
              "type",
              "role",
              "status",
              "sessionId",
            ]);
            clean.timestamp = row.timestamp ?? fallback;
            if (row.message)
              clean.message = {
                ...pick(row.message, ["model"]),
                usage: usage(row.message.usage),
              };
            if (row.providerData)
              clean.providerData = {
                ...pick(row.providerData, [
                  "model",
                  "requestModelId",
                  "messageId",
                  "traceId",
                ]),
                ...(row.providerData.usage
                  ? { usage: usage(row.providerData.usage) }
                  : {}),
                ...(row.providerData.rawUsage
                  ? { rawUsage: usage(row.providerData.rawUsage) }
                  : {}),
              };
            // Preserve usage precedence: an absent message.usage must stay absent.
            if (clean.message && !row.message.usage) delete clean.message.usage;
            rows.push(JSON.stringify(clean));
          }
          if (input.errored) throw input.errored;
        } finally {
          lines.close();
          input.destroy();
        }
        if (rows.length) {
          await mkdir(destination, { recursive: true, mode: 0o700 });
          await writeFile(out, rows.join("\n") + "\n", { mode: 0o600 });
          records += rows.length;
        }
      }
    }
  }
  try {
    for (const root of [".workbuddy", ".workbuddy-ai"])
      await walk(join(home, root, "projects"), join(target, root, "projects"));
  } catch {
    throw new Error("WorkBuddy 调用记录读取失败，已保留原统计。");
  }
  return records;
}
export async function collect(executable, clients = DEFAULT_CLIENTS, home) {
  if (
    !Array.isArray(clients) ||
    !clients.length ||
    clients.some((c) => !allowedClients.has(c)) ||
    new Set(clients).size !== clients.length
  )
    throw new Error("请选择至少一个受支持的统计来源。");
  const directory = await mkdtemp(join(tmpdir(), "aiclub-usage-"));
  try {
    const groups = [];
    const regular = clients.filter(
      (client) => client !== "workbuddy" && !LOCAL_CLIENTS.includes(client),
    );
    if (regular.length) groups.push({ clients: regular, home });
    if (clients.includes("workbuddy")) {
      const staged = join(directory, "workbuddy-home");
      if (await stageWorkBuddy(home || homedir(), staged))
        groups.push({ clients: ["workbuddy"], home: staged });
    }
    const local = clients.filter((client) => LOCAL_CLIENTS.includes(client));
    const { since, until } = dateWindow();
    const rows = [];
    let provenance = COLLECTOR;
    if (local.length) {
      const adapter = await import("./local-usage-adapters.mjs");
      rows.push(...await adapter.collectLocalSources(home || homedir(), local, since, until, home ? {} : process.env));
      provenance = adapter.LOCAL_COLLECTOR;
    }
    for (const group of groups) {
      const path = join(directory, "graph.json");
      const { since, until } = dateWindow();
      // No login, submit, task summary, or external-account adapters are invoked.
      const args = [
        ...(executable ? [] : ["--yes", COLLECTOR]),
        "graph",
        "--client",
        group.clients
          .flatMap((client) => client === "antigravity" ? antigravityClients : [client])
          .join(","),
        "--since",
        since,
        "--until",
        until,
        "--no-spinner",
        "--offline",
        "--output",
        path,
      ];
      if (group.home) args.push("--home", group.home);
      // Run npm's JS entry point directly on Windows, avoiding cmd.exe quoting
      // and shell interpretation of temporary directories containing spaces.
      const windowsNpx = join(
        dirname(process.execPath),
        "node_modules",
        "npm",
        "bin",
        "npx-cli.js",
      );
      if (!executable && process.platform === "win32") {
        try {
          await access(windowsNpx);
        } catch {
          throw new Error("未找到 npm，请使用包含 npm 的 Node.js 官方安装包。");
        }
      }
      await new Promise((accept, reject) => {
        const child = spawn(
          executable ||
            (process.platform === "win32" ? process.execPath : "npx"),
          !executable && process.platform === "win32"
            ? [windowsNpx, ...args]
            : args,
          {
            env: { ...process.env, TZ: "Asia/Shanghai" },
            stdio: ["ignore", "ignore", "pipe"],
            windowsHide: true,
          },
        );
        let error = "";
        child.stderr.on("data", (data) => {
          error = (error + data.toString()).slice(-2000);
        });
        const timer = setTimeout(() => child.kill(), 180_000);
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          code === 0
            ? accept()
            : reject(
                new Error(
                  `采集失败（${code ?? "超时"}），请稍后重试。${error ? "\n" + error : ""}`,
                ),
              );
        });
      });
      const snapshot = normalizeGraph(JSON.parse(await readFile(path, "utf8")));
      if (snapshot.rows.some((row) => !group.clients.includes(row.client)))
        throw new Error("采集器返回了未开启来源的数据，已停止同步。");
      rows.push(...snapshot.rows);
    }
    return {
      version: 1,
      collector: provenance,
      captured_at: new Date().toISOString(),
      rows,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function upload(cfg, snapshot) {
  const response = await fetch(
    `${validateSite(cfg.site)}/api/token-usage/sync`,
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify(snapshot),
    },
  );
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`网站没有返回有效数据（HTTP ${response.status}）。`);
  }
  if (!response.ok)
    throw new Error(data.message || `上传失败（HTTP ${response.status}）。`);
  if (data.ok !== true) throw new Error("网站没有确认同步成功，请稍后重试。");
  return data;
}
async function sync() {
  const cfg = await config();
  const snapshot = await collect();
  // Protect an existing snapshot from accidental deletion when logs are unavailable.
  if (!snapshot.rows.length)
    throw new Error(
      "未找到可上传的用量，已保留服务器原统计。请确认在使用 AI 工具的电脑上运行。",
    );
  const result = await upload(cfg, snapshot);
  console.log(
    `${new Date().toLocaleString("zh-CN")} ${result.unchanged ? "快照已存在" : "同步成功"} · ${snapshot.rows.length} 条统计 · ${cfg.site}/token-usage`,
  );
}
async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "setup") return setup(args);
  if (command === "preview") {
    console.log(JSON.stringify(await collect(), null, 2));
    return;
  }
  if (command === "sync") return sync();
  if (command === "watch") {
    console.log("每小时同步；按 Ctrl+C 停止。电脑休眠期间暂停，恢复后继续。");
    while (true) {
      try {
        await sync();
      } catch (e) {
        console.error(e.message);
      }
      await new Promise((r) => setTimeout(r, 3_600_000));
    }
  }
  if (command === "status") {
    const cfg = await config();
    console.log(
      `已配置社区：${cfg.site}\n凭证保存在本机。服务端有效性在 sync 时检查。`,
    );
    return;
  }
  if (command === "logout") {
    await rm(configFile, { force: true });
    console.log("已删除本机凭证。请在网站点击“停止设备上传”撤销服务器凭证。");
    return;
  }
  if (command !== "help") throw new Error("未知命令，请运行 help 查看帮助。");
  console.log(
    `AI Club Token 用量助手（内测）\n\nnode club-usage.mjs setup [--site https://changzhouai.club]\nnode club-usage.mjs preview   只预览白名单统计，不上传\nnode club-usage.mjs sync      同步一次最近 90 天快照\nnode club-usage.mjs watch     每小时同步，需保持运行\nnode club-usage.mjs status    查看已配置的网站\nnode club-usage.mjs logout    删除本机凭证\n\n采集器固定为 ${COLLECTOR}。默认采集 Claude Code、Codex、OpenCode；桌面版可另行开启 Gemini CLI、Kimi CLI、Qwen CLI、OpenClaw、DeepSeek Harness。\n上传不含对话、代码、项目路径或其他平台凭证。\n可用系统计划任务每小时执行 sync，实现后台运行。`,
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
