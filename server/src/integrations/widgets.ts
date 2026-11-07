import { parse } from "yaml";
import { call, trimSlash } from "./http.js";
import { secret } from "../config.js";
import { HttpError } from "../records.js";
import { goblinSummary, omiDays, omiConversations } from "./companions.js";

/** Live app panels. Each app in the apps YAML may have
 *    widget: { type: plex | sabnzbd, url: http://..., key_env: NAME }
 *  The server calls the app with the key from the named environment variable
 *  and hands the browser a small JSON shape; the key never reaches the page. */
export type WidgetCfg = { type: string; url: string; keyEnv?: string };
export function widgetsFrom(yaml: string): Record<string, WidgetCfg> {
  const out: Record<string, WidgetCfg> = {};
  let c: any = {}; try { c = parse(yaml || "") || {}; } catch { return out; }
  for (const g of Array.isArray(c.groups) ? c.groups : []) for (const a of Array.isArray(g?.apps) ? g.apps : []) {
    const w = a?.widget; if (!a?.name || !w || typeof w !== "object" || !w.type) continue;
    out[String(a.name)] = { type: String(w.type), url: String(w.url || a.url || ""), keyEnv: w.key_env || w.keyEnv };
  }
  return out;
}

const cache = new Map<string, { at: number; data: unknown }>();
export async function widgetData(name: string, w: WidgetCfg) {
  const hit = cache.get(name); if (hit && Date.now() - hit.at < 10000) return hit.data;
  const base = trimSlash(w.url); if (!base) throw new HttpError(400, `${name}'s widget has no url.`);
  const key = secret(w.keyEnv);
  let data: unknown;
  if (w.type === "plex") {
    const r = await call(`${base}/status/sessions`, { headers: { Accept: "application/json", ...(key ? { "X-Plex-Token": key } : {}) } });
    if (r.status === 401) throw new HttpError(502, `Plex refused the token${w.keyEnv ? ` in ${w.keyEnv}` : ""}.`);
    if (!r.ok) throw new HttpError(502, `Plex answered ${r.status}.`);
    const md: any[] = r.body?.MediaContainer?.Metadata || [];
    data = { type: "plex", sessions: md.map(m => ({
      title: m.type === "episode" ? `${m.grandparentTitle} · S${String(m.parentIndex ?? "").padStart(2, "0")}E${String(m.index ?? "").padStart(2, "0")} ${m.title}` : m.title,
      user: m.User?.title || "", player: m.Player?.title || m.Player?.product || "", state: m.Player?.state || "",
      progress: m.duration ? Math.round(((m.viewOffset || 0) / m.duration) * 100) : 0,
      transcode: !!m.TranscodeSession, })) };
  } else if (w.type === "sabnzbd") {
    const r = await call(`${base}/api?mode=queue&output=json&apikey=${encodeURIComponent(key)}`);
    if (!r.ok || r.body?.status === false) throw new HttpError(502, `SABnzbd answered ${r.status}${r.body?.error ? ": " + r.body.error : ""}.`);
    const q = r.body?.queue || {};
    data = { type: "sabnzbd", speed: q.speed ? `${q.speed}B/s` : "", timeleft: q.timeleft || "", paused: !!q.paused, sizeLeft: q.sizeleft || "",
      queue: (q.slots || []).slice(0, 8).map((s: any) => ({ name: s.filename, pct: Number(s.percentage) || 0, size: s.size || "", status: s.status || "" })) };
  } else if (w.type === "goblinbank") {
    data = { type: "goblinbank", ...(await goblinSummary({ name, url: w.url, keyEnv: w.keyEnv })) };
  } else if (w.type === "omi") {
    const c = { name, url: w.url, keyEnv: w.keyEnv };
    const [days, convs] = await Promise.all([omiDays(c, 2), omiConversations(c, 5)]);
    data = { type: "omi", day: days[0] || null, conversations: convs };
  } else throw new HttpError(400, `No live view for widget type ${w.type}.`);
  cache.set(name, { at: Date.now(), data }); return data;
}
