import { DEFAULT_CLIENTS } from "./renderer/source-catalog.mjs";
import { safeAvatarUrl } from "./renderer/profile.mjs";
import {
  CLIENTS,
  todayISO,
  shiftDate,
  normalizeLocalSnapshot,
} from "./renderer/analytics.mjs";
import { randomBytes, createHash } from "node:crypto";
export const DEFAULT_SITE = "https://changzhouai.club";
export function siteOrigin(raw) {
  const u = new URL(raw);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/" ||
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))
    )
  )
    throw new Error("请输入 HTTPS 社区地址，或本机测试地址。");
  return u.origin;
}
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export function summary(snapshot, now = new Date()) {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const monday = new Date(`${date}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const weekStart = monday.toISOString().slice(0, 10),
    monthStart = date.slice(0, 8) + "01";
  const result = {
    today: 0,
    week: 0,
    month: 0,
    total: 0,
    tools: { claude: 0, codex: 0, opencode: 0 },
  };
  for (const r of snapshot.rows) {
    const total =
      r.input + r.output + r.cache_read + r.cache_write + r.reasoning;
    result.total += total;
    result.tools[r.client] = (result.tools[r.client] || 0) + total;
    if (r.date === date) result.today += total;
    if (r.date >= weekStart) result.week += total;
    if (r.date >= monthStart) result.month += total;
  }
  return result;
}
export async function request(site, path, body, token, method = "POST") {
  const response = await fetch(siteOrigin(site) + path, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("社区服务暂未就绪，请稍后重试。");
  }
  if (!response.ok)
    throw Object.assign(
      new Error(data.message || "暂时无法连接社区，请稍后重试。"),
      { status: response.status },
    );
  return data;
}
export class UsageController {
  constructor({
    settings = {},
    detectedSources = {},
    save,
    collect,
    api = request,
    open,
    changed = () => {},
  }) {
    this.settings = { site: DEFAULT_SITE, enabled: true, ...settings };
    this.settings.site = siteOrigin(this.settings.site);
    this.settings.sources = Object.fromEntries(
      Object.keys(CLIENTS).map((id) => [
        id,
        typeof settings.sources?.[id] === "boolean"
          ? settings.sources[id]
          : DEFAULT_CLIENTS.includes(id),
      ]),
    );
    this.detectedSources = detectedSources;
    this.save = save;
    this.collect = collect;
    this.api = api;
    this.open = open;
    this.changed = changed;
    this.pending = null;
    this.busy = false;
    this.polling = false;
    this.message = "";
    this.generation = 0;
    this.lastAttempt = 0;
    this.resumeRequested = false;
  }
  state() {
    return {
      site: this.settings.site,
      linked: Boolean(this.settings.token),
      nickname: this.settings.nickname || "",
      avatarUrl: safeAvatarUrl(this.settings.avatarUrl),
      enabled: this.settings.enabled,
      busy: this.busy,
      message: this.message,
      lastSyncedAt: this.settings.lastSyncedAt || null,
      summary: this.settings.summary || null,
      snapshot: this.settings.snapshot || null,
      lastCollectedAt: this.settings.lastCollectedAt || null,
      pendingUpload: Boolean(this.settings.pendingUpload),
      sources: { ...this.settings.sources },
      detectedSources: { ...this.detectedSources },
      sourceStatus: this.settings.sourceStatus || {},
      sourcesChanged: Boolean(this.settings.sourcesChanged),
      stage: this.stage || "idle",
      connection: this.pending
        ? { code: this.pending.code, expiresAt: this.pending.expires_at }
        : null,
    };
  }
  emit() {
    this.changed(this.state());
  }
  async persist() {
    await this.save({ ...this.settings });
    this.emit();
  }
  async leaderboard(period) {
    if (!["today", "7d", "30d", "all"].includes(period))
      throw new Error("无效的榜单周期。");
    const site = this.settings.site;
    const data = await this.api(site, `/api/token-usage/leaderboard?period=${period}`, null, undefined, "GET");
    return { ok: true, site, data };
  }
  async refreshProfile(force = false) {
    const token = this.settings.token,
      site = this.settings.site;
    const interval = force ? 60_000 : 3_600_000;
    if (
      !token ||
      this.busy ||
      this.profileRefreshing ||
      (this.lastProfileAttempt &&
        Date.now() - this.lastProfileAttempt < interval)
    )
      return;
    this.profileRefreshing = true;
    this.lastProfileAttempt = Date.now();
    try {
      const result = await this.api(
        site,
        "/api/token-usage/device",
        null,
        token,
        "GET",
      );
      if (token !== this.settings.token || site !== this.settings.site) return;
      if (this.busy) {
        this.lastProfileAttempt = 0;
        return;
      }
      if (typeof result.nickname !== "string" || !("avatar_url" in result))
        return;
      this.settings.nickname = result.nickname || "社区成员";
      this.settings.avatarUrl = safeAvatarUrl(result.avatar_url);
      await this.persist();
    } catch {
      /* Cached identity and local usage remain available offline. */
    } finally {
      this.profileRefreshing = false;
    }
  }
  async start(name) {
    if (this.settings.token) throw new Error("请先退出当前账号再重新连接。");
    if (this.pending) {
      await this.open(
        `${this.settings.site}/token-usage/connect?id=${this.pending.id}`,
      );
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.message = "正在打开社区登录…";
    this.emit();
    try {
      const token = `club_usage_${randomBytes(32).toString("base64url")}`,
        secret = randomBytes(32).toString("base64url");
      const result = await this.api(
        this.settings.site,
        "/api/token-usage/connect",
        {
          action: "start",
          name: name.slice(0, 60),
          token_hash: digest(token),
          poll_hash: digest(secret),
        },
      );
      if (
        !/^[a-f0-9-]{36}$/.test(result.id) ||
        typeof result.code !== "string" ||
        !Number.isFinite(Date.parse(result.expires_at))
      )
        throw new Error("社区返回了无效的连接，请重试。");
      this.pending = { ...result, token, secret };
      this.message = "在浏览器中确认连接，完成后这里会自动更新。";
      this.emit();
      await this.open(
        `${this.settings.site}/token-usage/connect?id=${result.id}`,
      );
    } finally {
      this.busy = false;
      this.emit();
    }
  }
  async cancel() {
    if (!this.pending) return;
    const p = this.pending;
    this.pending = null;
    this.busy = true;
    this.emit();
    try {
      await this.api(this.settings.site, "/api/token-usage/connect", {
        action: "cancel",
        id: p.id,
        secret: p.secret,
      });
      this.message = "已取消连接。";
    } catch (e) {
      this.message = "网络暂不可用，连接会在十分钟内自动过期。";
      throw e;
    } finally {
      this.busy = false;
      this.emit();
    }
  }
  async poll() {
    if (!this.pending || this.polling) return;
    const pending = this.pending;
    if (Date.parse(pending.expires_at) <= Date.now()) {
      this.pending = null;
      this.message = "连接已过期，请重新登录。";
      this.emit();
      return;
    }
    this.polling = true;
    try {
      const result = await this.api(
        this.settings.site,
        "/api/token-usage/connect",
        { action: "poll", id: pending.id, secret: pending.secret },
      );
      if (this.pending !== pending) return;
      if (result.state === "approved") {
        const next = {
          ...this.settings,
          token: pending.token,
          nickname: result.nickname || "社区成员",
          enabled: true,
        };
        // Save encrypted credentials before marking the login complete.
        await this.save(next);
        this.settings = next;
        this.settings.avatarUrl = "";
        this.lastProfileAttempt = 0;
        this.pending = null;
        this.message = "已连接，正在同步你的用量。";
        this.generation++;
        this.emit();
        await this.sync();
      } else if (["denied", "expired", "superseded"].includes(result.state)) {
        this.pending = null;
        this.message =
          result.state === "denied"
            ? "你已取消连接。"
            : "连接已失效，请重新登录。";
        this.emit();
      }
    } catch (e) {
      if (e.status !== 429) {
        this.message = e.message;
        this.emit();
      }
    } finally {
      this.polling = false;
    }
  }
  async sync({ upload = true } = {}) {
    if (this.busy) return;
    const generation = this.generation,
      token = this.settings.token;
    this.busy = true;
    this.lastAttempt = Date.now();
    this.stage = "reading";
    this.message = "正在读取本机记录…";
    this.emit();
    let sourceReadComplete = false;
    try {
      const clients = Object.keys(CLIENTS).filter(
        (id) => this.settings.sources[id],
      );
      const snapshot = normalizeLocalSnapshot(await this.collect(clients));
      if (generation !== this.generation) return;
      if (snapshot.rows.some((row) => !clients.includes(row.client)))
        throw new Error("采集结果含未开启的来源，已保留原统计。");
      const checkedAt = new Date().toISOString();
      this.settings.sourceStatus = Object.fromEntries(
        clients.map((id) => [
          id,
          {
            state: snapshot.rows.some((row) => row.client === id)
              ? "found"
              : "empty",
            checkedAt,
            rows: snapshot.rows.filter((row) => row.client === id).length,
          },
        ]),
      );
      sourceReadComplete = true;
      // A previously present source disappearing can mean inaccessible or moved logs.
      // Do not replace the full server snapshot with this partial scan.
      const missing = clients.filter(
        (id) =>
          this.settings.snapshot?.rows?.some(
            (row) =>
              row.client === id && row.date >= shiftDate(todayISO(), -89),
          ) && !snapshot.rows.some((row) => row.client === id),
      );
      if (missing.length) {
        for (const id of missing)
          this.settings.sourceStatus[id].state = "missing";
        throw new Error(
          `${missing.map((id) => CLIENTS[id]).join("、")} 未发现既有记录；已保留上次统计，请检查日志或关闭该来源后重试。`,
        );
      }
      if (!snapshot.rows.length)
        throw new Error(
          "未发现可用记录，已保留上次统计。使用 AI 工具后再读取。",
        );
      // Local statistics are useful even when offline or not logged in.
      const next = {
        ...this.settings,
        snapshot,
        summary: summary(snapshot),
        lastCollectedAt: new Date().toISOString(),
        pendingUpload: true,
        sourcesChanged: false,
      };
      await this.save(next);
      if (generation !== this.generation) return;
      this.settings = {
        ...this.settings,
        sourcesChanged: false,
        snapshot: next.snapshot,
        summary: next.summary,
        lastCollectedAt: next.lastCollectedAt,
        pendingUpload: true,
      };
      this.emit();
      if (!upload || !token) {
        this.message = "本机统计已更新；尚未上传社区。";
        return;
      }
      this.stage = "uploading";
      this.message = "本机统计已保存，正在上传社区…";
      this.emit();
      const result = await this.api(
        this.settings.site,
        "/api/token-usage/sync",
        snapshot,
        token,
      );
      if (result.ok !== true)
        throw new Error("社区尚未确认同步成功，请稍后重试。");
      if (generation !== this.generation) return;
      this.settings.lastSyncedAt = new Date().toISOString();
      this.settings.pendingUpload = false;
      this.stage = "saving-upload";
      this.message = "读取与上传均已完成。";
      await this.persist();
    } catch (e) {
      if (generation === this.generation) {
        if (this.stage === "reading") {
          const checkedAt = new Date().toISOString();
          this.settings.sourceStatus ||= {};
          if (!sourceReadComplete)
            for (const id of Object.keys(CLIENTS).filter(
              (id) => this.settings.sources[id],
            ))
              this.settings.sourceStatus[id] = { state: "error", checkedAt };
          try {
            await this.save({ ...this.settings });
          } catch {
            /* Retain the original read/save error. */
          }
        }
        if (e.status === 401) {
          this.settings.enabled = false;
          this.message =
            "社区连接已失效，本机统计已保留。请退出账号后重新登录。";
          await this.persist();
        } else
          this.message =
            this.stage === "saving-upload"
              ? `社区已接收用量，但本机上传状态未保存：${e.message}`
              : this.stage === "uploading"
                ? `本机统计可查看，上传未完成：${e.message}`
                : `本机读取未完成：${e.message}`;
      }
    } finally {
      this.busy = false;
      this.stage = "idle";
      this.emit();
      if (
        this.resumeRequested &&
        this.settings.enabled &&
        this.settings.token
      ) {
        this.resumeRequested = false;
        await this.sync();
      }
    }
  }
  async setSource(value) {
    if (this.busy) throw new Error("请等待读取或同步完成后再修改来源。");
    if (
      !value ||
      value.client === "cursor" ||
      !Object.hasOwn(CLIENTS, value.client) ||
      typeof value.enabled !== "boolean"
    )
      throw new Error("无效的统计来源设置。");
    const sources = { ...this.settings.sources, [value.client]: value.enabled };
    if (!Object.values(sources).some(Boolean))
      throw new Error("请至少保留一个统计来源；如需停止上传，请暂停自动同步。");
    const next = { ...this.settings, sources, sourcesChanged: true };
    const generation = this.generation;
    this.busy = true;
    this.emit();
    try {
      await this.save(next);
      if (generation !== this.generation)
        throw new Error("同步状态已改变，请重新设置来源。");
      this.generation++;
      this.settings = next;
      this.message = "来源设置已保存，下次成功读取和同步后生效。";
    } finally {
      this.busy = false;
      this.emit();
    }
  }
  async pause() {
    this.generation++;
    this.settings.enabled = !this.settings.enabled;
    this.message = this.settings.enabled
      ? "已恢复自动同步。"
      : "自动同步已暂停。";
    await this.persist();
    if (!this.settings.enabled) this.resumeRequested = false;
    else if (this.busy) this.resumeRequested = true;
    else await this.sync();
  }
  async tick() {
    await this.poll();
    if (
      this.settings.token &&
      this.settings.enabled &&
      Date.now() -
        Math.max(
          this.lastAttempt,
          Date.parse(this.settings.lastSyncedAt || "") || 0,
        ) >=
        3_600_000
    )
      await this.sync();
  }
  async disconnect() {
    if (!this.settings.token) return;
    this.generation++;
    this.settings.enabled = false;
    this.resumeRequested = false;
    await this.persist();
    try {
      await this.api(
        this.settings.site,
        "/api/token-usage/device",
        null,
        this.settings.token,
        "DELETE",
      );
    } catch (e) {
      if (e.status !== 401)
        throw new Error("暂时无法撤销连接，已暂停同步。联网后请重试退出。");
    }
    delete this.settings.token;
    delete this.settings.nickname;
    delete this.settings.avatarUrl;
    delete this.settings.lastSyncedAt;
    this.settings.pendingUpload = Boolean(this.settings.snapshot);
    this.message = "已退出账号，并停止这台电脑上传。";
    await this.persist();
  }
  async setSite(value) {
    if (this.settings.token || this.pending || this.busy)
      throw new Error("请先退出或取消连接，再修改社区地址。");
    this.settings.site = siteOrigin(value);
    delete this.settings.lastSyncedAt;
    this.settings.pendingUpload = Boolean(this.settings.snapshot);
    await this.persist();
  }
}
