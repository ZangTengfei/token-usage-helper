// Read-only metadata adapters. Conversation bodies and credentials are never selected.
import { readdir, stat, realpath, readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join, basename } from "node:path";
const FIELDS = ["input", "output", "cache_read", "cache_write", "reasoning"];
export const LOCAL_COLLECTOR = "club-usage@1";
const optional = (u, names) =>
  names.map((n) => u?.[n]).find((v) => v !== undefined && v !== null);
function number(v) {
  if (!Number.isSafeInteger(v) || v < 0 || v > 1e12)
    throw new Error("用量字段不是有效非负整数。");
  return v;
}
function counters(u, kind, legacy = false) {
  if (!u || typeof u !== "object") return null;
  const aliases =
    kind === "teleagent"
      ? [["input"], ["output"], ["cache.read"], ["cache.write"], ["reasoning"]]
      : kind === "qoder-ide"
        ? [
            ["prompt_tokens"],
            ["completion_tokens"],
            ["cached_tokens"],
            ["cache_creation_input_tokens"],
            ["reasoning_tokens"],
          ]
        : [
            ["input", "input_tokens", "prompt_tokens", "inputTokens"],
            ["output", "output_tokens", "completion_tokens", "outputTokens"],
            [
              "cache_read",
              "cache_read_input_tokens",
              "input_cache_read",
              "cache_read_tokens",
              "cacheReadTokens",
            ],
            [
              "cache_write",
              "cache_creation_input_tokens",
              "input_cache_creation",
              "cache_write_tokens",
              "cacheCreationTokens",
            ],
            ["reasoning", "reasoning_tokens", "reasoningTokens"],
          ];
  const values = aliases.map((keys) =>
    keys
      .map((k) => (k.startsWith("cache.") ? u.cache?.[k.slice(6)] : u[k]))
      .find((v) => v !== undefined && v !== null),
  );
  if (values[0] === undefined || values[1] === undefined) return null;
  const unavailable = FIELDS.filter((_, i) => values[i] === undefined);
  const counts = values.map((v) => (v === undefined ? 0 : number(v)));
  if (!counts.some((v) => v > 0)) return null; // Credits-only literal zeros are not measurements.
  const total = optional(u, [
    "computed_total_tokens",
    "total",
    "totalTokens",
    "total_tokens",
  ]);
  if (total !== undefined) number(total);
  let inclusive = kind.startsWith("qoder") || legacy;
  if (kind === "zcode" && total !== undefined) {
    const raw = counts[0] + counts[1],
      separate = counts.reduce((a, b) => a + b, 0);
    if (total === raw && separate !== raw) inclusive = true;
    else if (total === separate) inclusive = false;
    else throw new Error("ZCode 总量与分项不一致。");
  }
  if (
    kind === "zcode" &&
    !legacy &&
    total === undefined &&
    counts.slice(2).some((v) => v > 0)
  )
    throw new Error("ZCode 缺少可核验缓存口径的总量。");
  if (kind === "qoder-cli" && total !== undefined) {
    const base = counts[0] + counts[1],
      separate = counts.reduce((a, b) => a + b, 0);
    if (total === base) inclusive = true;
    else if (total === separate) inclusive = false;
    else throw new Error("Qoder 总量与分项不一致。");
  }
  if (kind === "qoder-cli" && total === undefined) {
    // Native SDK BetaUsage is Anthropic-style: input excludes cache; no total is required.
    // Credits is an independent billing field and is never evidence for token semantics.
    const native = u.input_tokens != null && u.output_tokens != null;
    const openai = u.prompt_tokens != null && u.completion_tokens != null;
    if (native) {
      inclusive = false;
      if (counts[1] < counts[4]) throw new Error("缓存或推理分项超过所属总量。");
      counts[1] -= counts[4];
    } else if (!openai && counts.slice(2).some(v => v > 0)) {
      throw new Error("Qoder CLI 的用量字段口径无法识别，已保留原统计。");
    }
  }
  if (inclusive) {
    const overlap = counts[2] + counts[3];
    if (counts[0] < overlap || counts[1] < counts[4])
      throw new Error("缓存或推理分项超过所属总量。");
    counts[0] -= overlap;
    counts[1] -= counts[4];
  }
  return {
    ...Object.fromEntries(FIELDS.map((f, i) => [f, counts[i]])),
    ...(unavailable.length ? { unavailable } : {}),
  };
}
// Kiro's recorded input is uncached; context percentages and Credits are not tokens.
function kiroCounters(meta) {
  if (!meta || typeof meta !== "object") return null;
  const nested = meta.token_usage || meta.usage || {};
  const aliases = [
    ["input_tokens", "uncached_input_tokens", "input_token_count"],
    ["output_tokens", "output_token_count"],
    ["cache_read_input_tokens", "cache_read_input_token_count", "cache_read_tokens", "cache_read"],
    ["cache_write_input_tokens", "cache_write_input_token_count", "cache_creation_input_tokens", "cache_write_tokens", "cache_write"],
    ["reasoning_tokens", "reasoning_token_count", "thinking_tokens"],
  ];
  const values = aliases.map(keys => optional(meta, keys) ?? optional(nested, keys));
  // Auto commonly stores literal zero placeholders. Never estimate from message text.
  if (!values.some(v => v !== undefined && number(v) > 0)) return null;
  const u = Object.fromEntries(FIELDS.map((f, i) => [f, values[i]]));
  // Output includes reasoning when that breakdown is reported.
  if (values[1] !== undefined && values[4] !== undefined) {
    if (values[4] > values[1]) throw new Error("Kiro 推理分项超过输出总量。");
    u.output -= u.reasoning;
  }
  // Keep partial measurements explicitly unavailable rather than dropping recorded input.
  const unavailable = FIELDS.filter((_, i) => values[i] === undefined);
  return { ...Object.fromEntries(FIELDS.map(f => [f, u[f] === undefined ? 0 : number(u[f])])),
    ...(unavailable.length ? { unavailable } : {}) };
}
async function exists(p) {
  try {
    return (await stat(p)).isFile();
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
async function dirs(p) {
  try {
    return (await readdir(p, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => join(p, e.name));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}
export async function localSourcePaths(home, env = {}, selected = null) {
  const tele = join(home, ".local/share/TeleAgent");
  const support = [
    join(home, "Library/Application Support"),
    env.APPDATA || join(home, "AppData/Roaming"),
    join(home, ".config"),
  ];
  return {
    kiro: {
      db: [join(home, "Library/Application Support/kiro-cli/data.sqlite3"), join(home, ".local/share/kiro-cli/data.sqlite3")],
      logs: [join(home, ".kiro/sessions/cli")],
    },
    zcode: {
      db: [join(home, ".zcode/cli/db/db.sqlite")],
      logs: [join(home, ".zcode/projects")],
    },
    teleagent: {
      db: [
        join(tele, "teleagent.db"),
        ...(selected && !selected.includes("teleagent")
          ? []
          : await dirs(join(tele, "users"))
        ).map((p) => join(p, "teleagent.db")),
      ],
      logs: [],
    },
    qoder: {
      db: ["Qoder", "QoderCN"].flatMap((app) =>
        support.map((p) => join(p, app, "SharedClientCache/cache/db/local.db")),
      ),
      logs: [
        join(env.QODER_CONFIG_DIR || join(home, ".qoder"), "projects"),
        join(home, ".qoder-cn/projects"),
      ],
    },
  };
}
export async function detectLocalSources(home, env = {}) {
  const paths = await localSourcePaths(home, env),
    result = {};
  for (const [id, source] of Object.entries(paths)) {
    result[id] = "absent";
    for (const p of [...source.db, ...source.logs])
      try {
        await stat(p);
        result[id] = "found";
        break;
      } catch (e) {
        if (e.code !== "ENOENT") result[id] = "unavailable";
      }
  }
  return result;
}
function epoch(value) {
  const n =
    typeof value === "string" && !/^\d+(\.\d+)?$/.test(value)
      ? Date.parse(value)
      : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n;
}
function object(v) {
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v;
}
export async function collectLocalSources(
  home,
  clients,
  since,
  until,
  env = {},
) {
  const paths = await localSourcePaths(home, env, clients),
    calls = new Map();
  const first = Date.parse(since + "T00:00:00+08:00");
  let DatabaseSync;
  const seenFiles = new Set();
  function add(
    client,
    namespace,
    id,
    session,
    stamp,
    model,
    tokens,
    updated = 0,
  ) {
    const ms = epoch(stamp);
    if (!ms || !tokens) return;
    const date = new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
    if (date < since || date > until) return;
    const key = JSON.stringify([client, namespace, session || "", id]);
    const row = {
      date,
      client,
      model:
        typeof model === "string" && model.trim() ? model.trim() : "未标注模型",
      ...tokens,
    };
    if (row.model.length > 120) throw new Error("模型名称过长。");
    const previous = calls.get(key);
    if (
      !previous ||
      updated > previous.updated ||
      (updated === previous.updated &&
        FIELDS.reduce((n, f) => n + row[f], 0) >=
          FIELDS.reduce((n, f) => n + previous.row[f], 0))
    )
      calls.set(key, { row, updated });
  }
  for (const client of clients) {
    if (!paths[client]) throw new Error("不支持的本地采集来源。");
    let hasDb = false;
    for (const path of paths[client].db) {
      if (!(await exists(path))) continue;
      const canonical = await realpath(path);
      if (seenFiles.has(canonical)) continue;
      seenFiles.add(canonical);
      hasDb = true;
      DatabaseSync ||= (await import("node:sqlite")).DatabaseSync;
      const db = new DatabaseSync(path, { readOnly: true });
      const namespace =
        client === "qoder"
          ? path.includes("QoderCN")
            ? "cn"
            : "intl"
          : client;
      try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;");
        if (client === "kiro") {
          // Extract only usage metadata; never select auth tables or message bodies.
          const query = `SELECT c.conversation_id AS session, h.key AS turn,
            json_extract(c.value,'$.model_info.model_id') AS model,
            json_extract(h.value,'$.request_metadata') AS meta
            FROM conversations_v2 c, json_each(c.value,'$.history') h
            WHERE json_type(h.value,'$.request_metadata')='object'
              AND CAST(json_extract(h.value,'$.request_metadata.stream_end_timestamp_ms') AS INTEGER)>=?`;
          for (const r of db.prepare(query).iterate(first)) {
            const m = object(r.meta);
            add(client, "kiro", r.turn, r.session, m.stream_end_timestamp_ms,
              r.model, kiroCounters(m), epoch(m.stream_end_timestamp_ms) || 0);
          }
        } else if (client === "teleagent") {
          const query = `SELECT id,session_id,time_created,time_updated,
            json_extract(data,'$.modelID') AS model,json_extract(data,'$.tokens') AS tokens,
            json_extract(data,'$.time.completed') AS completed
            FROM message WHERE json_extract(data,'$.role')='assistant' AND time_created>=?`;
          for (const r of db.prepare(query).iterate(first))
            if (epoch(r.completed))
              add(
                client,
                namespace,
                r.id,
                r.session_id,
                r.time_created,
                r.model,
                counters(object(r.tokens), "teleagent"),
                r.time_updated,
              );
        } else if (client === "qoder") {
          const query = `SELECT id,session_id,gmt_create,model_info,token_info FROM chat_message
            WHERE role='assistant' AND token_info IS NOT NULL AND gmt_create>=?`;
          for (const r of db.prepare(query).iterate(first)) {
            const info = object(r.model_info);
            add(
              client,
              namespace,
              r.id,
              r.session_id,
              r.gmt_create,
              info?.model_key || info?.modelKey,
              counters(object(r.token_info), "qoder-ide"),
              epoch(r.gmt_create),
            );
          }
        } else {
          const columns = new Set(
            db
              .prepare("PRAGMA table_info(model_usage)")
              .all()
              .map((c) => c.name),
          );
          for (const key of [
            "id",
            "input_tokens",
            "output_tokens",
            "started_at",
          ])
            if (!columns.has(key)) throw new Error("ZCode 用量表结构不兼容。");
          const names = [
            "id",
            "session_id",
            "model_id",
            "started_at",
            "completed_at",
            "duration_ms",
            "input_tokens",
            "output_tokens",
            "reasoning_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
            "computed_total_tokens",
          ];
          // ZCode's completion status is authoritative; historical completed rows may
          // lack completed_at. Keep timestamp fallback only for older schemas without status.
          const query = `SELECT ${names.map((n) => (columns.has(n) ? n : `NULL AS ${n}`)).join(",")} FROM model_usage WHERE ${columns.has("completed_at") ? "COALESCE(NULLIF(started_at,0),completed_at)" : "started_at"}>=?${columns.has("status") ? " AND status='completed'" : ""}`;
          for (const r of db.prepare(query).iterate(first)) {
            if (!columns.has("status") && columns.has("completed_at") && !epoch(r.completed_at)) continue;
            const usage = {
              input: r.input_tokens,
              output: r.output_tokens,
              reasoning: r.reasoning_tokens,
              cache_read: r.cache_read_input_tokens,
              cache_write: r.cache_creation_input_tokens,
              total: r.computed_total_tokens,
            };
            add(
              client,
              namespace,
              r.id,
              r.session_id,
              r.started_at || r.completed_at,
              r.model_id,
              counters(usage, "zcode", !columns.has("computed_total_tokens")),
              r.completed_at || r.started_at,
            );
          }
        }
      } finally {
        db.close();
      }
    }
    if (client === "kiro") {
      // A database mirrors CLI sessions. Do not combine both representations.
      if (hasDb) continue;
      for (const root of paths.kiro.logs) {
        let entries;
        try { entries = await readdir(root, { withFileTypes: true }); }
        catch (e) { if (e.code === "ENOENT") continue; throw e; }
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          const r = JSON.parse(await readFile(join(root, entry.name), "utf8"));
          const state = r.session_state;
          const turns = state?.conversation_metadata?.user_turn_metadatas;
          if (!Array.isArray(turns)) continue;
          if (!r.session_id) throw new Error("Kiro 会话缺少标识。");
          for (const [i, turn] of turns.entries())
            add(client, "kiro", `turn:${i}`, r.session_id, turn.end_timestamp,
              state.rts_model_state?.model_info?.model_id, kiroCounters(turn), epoch(turn.end_timestamp) || 0);
        }
      }
      continue;
    }
    // ZCode SQLite is authoritative. Its mirrored legacy transcripts must not be added again.
    if (client === "zcode" && hasDb) continue;
    async function walk(root) {
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (e) {
        if (e.code === "ENOENT") return;
        throw e;
      }
      for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const canonical = await realpath(path);
          if (seenFiles.has(canonical)) continue;
          seenFiles.add(canonical);
          const input = createReadStream(path, { encoding: "utf8" }),
            lines = createInterface({ input, crlfDelay: Infinity });
          input.on("error", () => lines.close());
          let model,
            session,
            index = 0;
          try {
            for await (const line of lines) {
              let r;
              try {
                r = JSON.parse(line);
              } catch {
                continue;
              }
              if (!r || typeof r !== "object") continue;
              const message = r.message || r;
              model = message.model || r.model || model;
              session =
                r.sessionId ||
                r.session_id ||
                session ||
                basename(path, ".jsonl");
              if (
                !(
                  r.role === "assistant" ||
                  r.type === "assistant" ||
                  message.role === "assistant"
                )
              )
                continue;
              const callIndex = index++;
              if (r.isSidechain === true && !message.id && !r.uuid) continue;
              const usage = message.usage || r.usage || r.token_usage;
              const tokens = counters(
                usage,
                client === "zcode" ? "zcode" : "qoder-cli",
              );
              add(
                client,
                path.includes(".qoder-cn")
                  ? "cn"
                  : client === "qoder"
                    ? "intl"
                    : "zcode",
                message.id || r.uuid || r.id || `turn:${callIndex}`,
                session,
                r.timestamp || message.timestamp,
                model,
                tokens,
                epoch(r.timestamp) || 0,
              );
            }
            if (input.errored) throw input.errored;
          } finally {
            lines.close();
            input.destroy();
          }
        }
      }
    }
    for (const root of paths[client].logs) await walk(root);
  }
  const merged = new Map();
  for (const { row } of calls.values()) {
    const key = JSON.stringify([row.date, row.client, row.model]),
      old = merged.get(key);
    if (old) {
      for (const f of FIELDS) old[f] = number(old[f] + row[f]);
      old.unavailable = [
        ...new Set([...(old.unavailable || []), ...(row.unavailable || [])]),
      ].sort();
      if (!old.unavailable.length) delete old.unavailable;
    } else merged.set(key, { ...row });
  }
  if (merged.size > 5000) throw new Error("统计条目超出范围。");
  return [...merged.values()];
}
