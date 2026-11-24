import { safeAvatarUrl } from "./profile.mjs";

export const PERIODS = { today: "今日", "7d": "近 7 天", "30d": "近 30 天", all: "最近 90 天" };

export function normalizeBoard(data, period) {
  if (!Object.hasOwn(PERIODS, period) || data?.period !== period ||
      !Array.isArray(data.rows) || data.rows.length > 100)
    throw new Error("榜单数据暂不可用，请重试。");
  return data.rows.map((row) => {
    if (typeof row.nickname !== "string" || !Number.isSafeInteger(row.tokens) ||
        row.tokens < 0 || !Number.isInteger(row.active_days) || row.active_days < 0 ||
        !Array.isArray(row.clients) || !row.clients.every((c) => typeof c === "string") ||
        !Number.isFinite(Date.parse(row.last_synced_at)))
      throw new Error("榜单数据暂不可用，请重试。");
    return {
      nickname: row.nickname.slice(0, 120) || "社区成员",
      avatar_url: safeAvatarUrl(row.avatar_url), tokens: row.tokens,
      active_days: row.active_days, clients: row.clients.slice(0, 16),
      last_synced_at: row.last_synced_at,
    };
  });
}

// Memory only: no persisted public identities and no background polling.
export class CommunityBoard {
  constructor(request, now = Date.now) {
    this.request = request;
    this.now = now;
    this.site = "";
    this.entries = new Map();
  }
  useSite(site) {
    if (site === this.site) return;
    this.site = site;
    this.entries.clear();
  }
  entry(period) {
    if (!Object.hasOwn(PERIODS, period)) throw new Error("无效的榜单周期。");
    if (!this.entries.has(period)) this.entries.set(period, {});
    return this.entries.get(period);
  }
  async load(period, force = false) {
    const entry = this.entry(period), site = this.site;
    if (entry.pending) return entry.pending;
    if (!force && entry.fetchedAt && this.now() - entry.fetchedAt < 60_000) return;
    entry.error = "";
    entry.pending = (async () => {
      try {
        const result = await this.request(period);
        if (site !== this.site) return;
        if (!result.ok) throw new Error();
        if (result.site !== site) return;
        entry.rows = normalizeBoard(result.data, period);
        entry.fetchedAt = this.now();
      } catch {
        if (site === this.site)
          entry.error = entry.rows
            ? "刷新失败，显示上次读取的榜单。请检查网络后重试。"
            : "暂时无法读取社区榜单，请检查网络后重试。";
      } finally {
        entry.pending = null;
      }
    })();
    return entry.pending;
  }
}
