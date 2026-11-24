import { CLIENTS } from "./source-catalog.mjs";
export { CLIENTS };
export const FIELDS = [
  "input",
  "output",
  "cache_read",
  "cache_write",
  "reasoning",
];
export function todayISO(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function shiftDate(date, delta) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
export function tokenTotal(row, includeCache = true) {
  return (
    row.input +
    row.output +
    row.reasoning +
    (includeCache ? row.cache_read + row.cache_write : 0)
  );
}
export function normalizeLocalSnapshot(value, now = new Date()) {
  if (!value || !Array.isArray(value.rows) || value.rows.length > 5000)
    throw new Error("本机统计格式不正确，请重新读取。");
  const today = todayISO(now),
    start = shiftDate(today, -89),
    keys = new Set();
  const rows = value.rows.map((row) => {
    if (
      typeof row.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !Number.isFinite(Date.parse(row.date)) ||
      new Date(row.date).toISOString().slice(0, 10) !== row.date ||
      row.date < start ||
      row.date > today ||
      !Object.hasOwn(CLIENTS, row.client) ||
      typeof row.model !== "string" ||
      !row.model.trim() ||
      row.model.length > 120
    )
      throw new Error("本机统计包含无效日期、工具或模型。");
    const clean = { date: row.date, client: row.client, model: row.model };
    for (const f of FIELDS) {
      if (!Number.isSafeInteger(row[f]) || row[f] < 0 || row[f] > 1e12)
        throw new Error("本机统计包含异常用量。");
      clean[f] = row[f];
    }
    if (row.unavailable !== undefined) {
      if (!Array.isArray(row.unavailable) || row.unavailable.length > FIELDS.length || row.unavailable.some(f => !FIELDS.includes(f)) || new Set(row.unavailable).size !== row.unavailable.length)
        throw new Error("缺失分项标记无效。");
      if (row.unavailable.length) clean.unavailable = [...row.unavailable];
    }
    const key = JSON.stringify([clean.date, clean.client, clean.model]);
    if (keys.has(key)) throw new Error("本机统计包含重复记录。");
    keys.add(key);
    return clean;
  });
  if (rows.reduce((n, r) => n + tokenTotal(r), 0) > 1e12)
    throw new Error("用量超出当前统计范围。");
  const captured = value.captured_at || now.toISOString();
  if (!Number.isFinite(Date.parse(captured)))
    throw new Error("本机统计时间不正确。");
  return {
    version: 1,
    collector: value.collector || "tokscale@4.17.0",
    captured_at: captured,
    rows,
  };
}
export function aggregate(rows, includeCache = true) {
  const buckets = Object.fromEntries(FIELDS.map((f) => [f, 0])),
    tools = new Map(),
    models = new Map();
  for (const r of rows) {
    for (const f of FIELDS) buckets[f] += r[f];
    const n = tokenTotal(r, includeCache);
    tools.set(r.client, (tools.get(r.client) || 0) + n);
    models.set(r.model, (models.get(r.model) || 0) + n);
  }
  const total = rows.reduce((n, r) => n + tokenTotal(r, includeCache), 0),
    all = rows.reduce((n, r) => n + tokenTotal(r), 0);
  const rank = (map) =>
    [...map]
      .map(([name, tokens]) => ({
        name,
        tokens,
        share: total ? tokens / total : 0,
      }))
      .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
  return {
    total,
    buckets,
    unavailable: [...new Set(rows.flatMap(r => r.unavailable || []))],
    cacheRatio: rows.some(r => r.unavailable?.some(f => f.startsWith("cache_"))) ? null : all ? (buckets.cache_read + buckets.cache_write) / all : null,
    tools: rank(tools),
    models: rank(models),
    recordCount: rows.length,
  };
}
export function dashboard(
  snapshot,
  { client = "all", includeCache = true, range = 90, now = new Date() } = {},
) {
  const today = todayISO(now),
    count = [7, 30, 90].includes(Number(range)) ? Number(range) : 90,
    start = shiftDate(today, 1 - count);
  const rows = (snapshot?.rows || []).filter(
    (r) =>
      r.date >= shiftDate(today, -89) &&
      r.date <= today &&
      (client === "all" || r.client === client),
  );
  const daily = new Map();
  for (const row of rows) {
    if (!daily.has(row.date)) daily.set(row.date, []);
    daily.get(row.date).push(row);
  }
  const days = Array.from({ length: count }, (_, i) => {
    const date = shiftDate(start, i),
      records = daily.get(date) || [];
    return {
      date,
      known: records.length > 0,
      ...aggregate(records, includeCache),
    };
  });
  // Relative rank bands keep both ordinary variation and extreme outliers visible.
  const values = [
    ...new Set(days.filter((d) => d.known && d.total > 0).map((d) => d.total)),
  ].sort((a, b) => a - b);
  for (const d of days)
    d.level = !d.known
      ? -1
      : d.total === 0
        ? 0
        : values.length === 1
          ? 3
          : 1 + Math.round((values.indexOf(d.total) / (values.length - 1)) * 4);
  const metric = (length) => {
    const first = shiftDate(today, 1 - length),
      r = rows.filter((r) => r.date >= first);
    return {
      ...aggregate(r, includeCache),
      days: new Set(r.map((x) => x.date)).size,
      length,
    };
  };
  return {
    today,
    start,
    days,
    includeCache,
    client,
    range: count,
    metrics: { today: metric(1), week: metric(7), month: metric(30) },
    ...aggregate(
      rows.filter((r) => r.date >= start),
      includeCache,
    ),
  };
}
export function heatCells(days) {
  if (!days.length) return [];
  const leading = (new Date(`${days[0].date}T00:00:00Z`).getUTCDay() + 6) % 7;
  const result = [...Array(leading).fill(null), ...days];
  while (result.length % 7) result.push(null);
  return result;
}

export function syncStatus(state) {
  if (state.busy)
    return state.stage === "reading" ? "正在读取本机" : "正在上传社区";
  if (!state.linked) return "仅本机记录";
  if (!state.enabled)
    return state.pendingUpload ? "同步已暂停 · 待上传" : "自动同步已暂停";
  return state.pendingUpload ? "本机有待上传记录" : "每小时自动同步";
}
