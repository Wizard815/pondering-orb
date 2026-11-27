import { call, trimSlash } from "./http.js";
import { secret } from "../config.js";
import { HttpError } from "../records.js";
import type { WidgetCfg } from "./widgets.js";

/** Sonarr, Radarr, Tautulli and Seerr (Jellyseerr / Overseerr): read-only
 *  panels. Every call is a GET made by Orb's server with the key from the
 *  widget's key_env, so the key never reaches the browser. */

const NAMES: Record<string, string> = { sonarr: "Sonarr", radarr: "Radarr", tautulli: "Tautulli", seerr: "Seerr" };
const WHERE: Record<string, string> = {
  sonarr: "Sonarr → Settings → General → API Key", radarr: "Radarr → Settings → General → API Key",
  tautulli: "Tautulli → Settings → Web Interface → API Key", seerr: "Seerr → Settings → General → API Key",
};

function keyFor(type: string, w: WidgetCfg) {
  const key = secret(w.keyEnv);
  if (!key) throw new HttpError(400, `The ${NAMES[type]} widget needs key_env naming a variable that holds its API key (${WHERE[type]})${w.keyEnv ? `, and ${w.keyEnv} is empty` : ""}.`);
  return key;
}
function baseOf(type: string, w: WidgetCfg) {
  const b = trimSlash(w.url); if (!b) throw new HttpError(400, `The ${NAMES[type]} widget has no url.`);
  return b;
}
/** A plain-words error for an answer that isn't a success. */
function check(type: string, w: WidgetCfg, r: { status: number; ok: boolean; body: any }, what: string) {
  const n = NAMES[type];
  if (r.status === 401 || r.status === 403) throw new HttpError(502, `${n} refused the API key${w.keyEnv ? ` in ${w.keyEnv}` : ""}. Copy it again from ${WHERE[type]}.`);
  if (r.status === 404) throw new HttpError(502, `${n} has no ${what} at that address (404). Check the widget's url, including any URL base.`);
  if (r.status >= 500) throw new HttpError(502, `${n} is up but failing (answered ${r.status} for ${what}).`);
  if (!r.ok) throw new HttpError(502, `${n} answered ${r.status} for ${what}${r.body?.message ? `: ${String(r.body.message).slice(0, 200)}` : ""}.`);
  if (typeof r.body === "string" && /<html/i.test(r.body)) throw new HttpError(502, `That address answered with a web page, not ${n}'s API. Check the widget's url.`);
}

const pct = (size: number, left: number) => (size > 0 ? Math.max(0, Math.min(100, Math.round(((size - left) / size) * 100))) : 0);
const ep = (s: any, e: any) => `S${String(s ?? "").padStart(2, "0")}E${String(e ?? "").padStart(2, "0")}`;

/** Sonarr and Radarr: the next 7 days of the calendar and the download queue. */
export async function arrWidget(type: "sonarr" | "radarr", w: WidgetCfg, now = new Date()) {
  const base = baseOf(type, w), h = { "X-Api-Key": keyFor(type, w), Accept: "application/json" };
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()), end = new Date(start.getTime() + 7 * 864e5);
  const span = `start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;
  const inc = type === "sonarr" ? "includeSeries=true" : "includeMovie=true";
  const [cal, q] = await Promise.all([
    call(`${base}/api/v3/calendar?${span}&${type === "sonarr" ? "includeSeries=true" : "unmonitored=false"}`, { headers: h }),
    call(`${base}/api/v3/queue?page=1&pageSize=20&${inc}`, { headers: h }),
  ]);
  check(type, w, cal, "calendar"); check(type, w, q, "queue");
  const from = start.toISOString(), to = end.toISOString();
  const upcoming = (Array.isArray(cal.body) ? cal.body : []).map((x: any) => {
    if (type === "sonarr") return { title: String(x.series?.title || x.seriesTitle || "Unknown series"), detail: `${ep(x.seasonNumber, x.episodeNumber)}${x.title ? " " + x.title : ""}`,
      at: String(x.airDateUtc || x.airDate || ""), hasFile: !!x.hasFile };
    // Radarr lists a movie when any of its release dates falls in the range: show that one.
    const dates = ([["In cinemas", x.inCinemas], ["Digital", x.digitalRelease], ["Physical", x.physicalRelease]] as [string, string][])
      .filter(([, d]) => d && d >= from.slice(0, 10) && d <= to).sort((a, b) => a[1].localeCompare(b[1]));
    const [kind, at] = dates[0] || ["", x.digitalRelease || x.physicalRelease || x.inCinemas || ""];
    return { title: `${x.title || "Unknown movie"}${x.year ? ` (${x.year})` : ""}`, detail: kind, at: String(at), hasFile: !!x.hasFile };
  }).sort((a: any, b: any) => a.at.localeCompare(b.at)).slice(0, 12);
  const recs: any[] = Array.isArray(q.body?.records) ? q.body.records : Array.isArray(q.body) ? q.body : [];
  const queue = recs.slice(0, 8).map((r: any) => ({
    title: String(r.title || r.series?.title || r.movie?.title || "Download"),
    pct: pct(Number(r.size) || 0, Number(r.sizeleft) || 0),
    status: String(r.trackedDownloadState && r.trackedDownloadState !== "downloading" ? r.trackedDownloadState : r.status || ""),
    timeleft: String(r.timeleft || ""),
    warning: r.trackedDownloadStatus === "warning" || r.trackedDownloadStatus === "error" || (Array.isArray(r.statusMessages) && r.statusMessages.length > 0 && r.trackedDownloadStatus !== "ok"),
  }));
  return { type, link: trimSlash(w.link || w.url), upcoming, queue, queueTotal: Number(q.body?.totalRecords ?? recs.length) || 0 };
}

/** Tautulli: who is watching what right now (direct or transcoding), and recent plays. */
export async function tautulliWidget(w: WidgetCfg) {
  const base = baseOf("tautulli", w), key = encodeURIComponent(keyFor("tautulli", w));
  const [act, hist] = await Promise.all([
    call(`${base}/api/v2?apikey=${key}&cmd=get_activity`, { headers: { Accept: "application/json" } }),
    call(`${base}/api/v2?apikey=${key}&cmd=get_history&length=5`, { headers: { Accept: "application/json" } }),
  ]);
  for (const [r, what] of [[act, "activity"], [hist, "history"]] as const) {
    check("tautulli", w, r, what);
    const resp = r.body?.response;
    if (!resp) throw new HttpError(502, "That address didn't answer like Tautulli's API. Check the widget's url.");
    if (resp.result !== "success") throw new HttpError(502, /api ?key/i.test(String(resp.message || "")) ? `Tautulli refused the API key${w.keyEnv ? ` in ${w.keyEnv}` : ""}. Copy it again from ${WHERE.tautulli}.` : `Tautulli said: ${String(resp.message || "error").slice(0, 200)}.`);
  }
  const a = act.body.response.data || {}, h = hist.body.response.data || {};
  const title = (s: any) => s.media_type === "episode" ? `${s.grandparent_title} · ${ep(s.parent_media_index, s.media_index)} ${s.title}` : String(s.full_title || s.title || "");
  const sessions = (Array.isArray(a.sessions) ? a.sessions : []).map((s: any) => ({
    title: title(s), user: String(s.friendly_name || s.user || ""), player: String(s.player || s.platform || ""), state: String(s.state || ""),
    progress: Number(s.progress_percent) || 0,
    // transcode_decision: "transcode", "copy" (direct stream) or "direct play".
    transcode: s.transcode_decision === "transcode", decision: String(s.transcode_decision || ""),
  }));
  const rows: any[] = Array.isArray(h.data) ? h.data : [];
  return {
    type: "tautulli", link: trimSlash(w.link || w.url),
    streams: Number(a.stream_count) || sessions.length, transcodes: Number(a.stream_count_transcode) || sessions.filter((s: any) => s.transcode).length, sessions,
    plays: { total: Number(h.recordsTotal ?? h.recordsFiltered) || 0,
      recent: rows.slice(0, 5).map(r => ({ title: String(r.full_title || r.title || ""), user: String(r.friendly_name || r.user || ""), at: r.date ? new Date(Number(r.date) * 1000).toISOString() : "" })) },
  };
}

// Seerr's request list carries only TMDB ids, so titles are looked up once and kept.
const seerrTitles = new Map<string, string>();
const REQ_STATUS: Record<number, string> = { 1: "pending", 2: "approved", 3: "declined", 4: "failed", 5: "completed" };
const MEDIA_STATUS: Record<number, string> = { 2: "pending", 3: "processing", 4: "partly available", 5: "available", 6: "blocklisted", 7: "deleted" };

/** Seerr (Jellyseerr / Overseerr): requests waiting for approval and the last five requests. */
export async function seerrWidget(w: WidgetCfg) {
  const base = baseOf("seerr", w), h = { "X-Api-Key": keyFor("seerr", w), Accept: "application/json" };
  const [list, count] = await Promise.all([
    call(`${base}/api/v1/request?take=5&skip=0&sort=added&filter=all`, { headers: h }),
    call(`${base}/api/v1/request/count`, { headers: h }),
  ]);
  check("seerr", w, list, "requests"); check("seerr", w, count, "request counts");
  const results: any[] = Array.isArray(list.body?.results) ? list.body.results : [];
  const titleOf = async (r: any) => {
    const kind = r.type === "tv" || r.media?.mediaType === "tv" ? "tv" : "movie", id = Number(r.media?.tmdbId);
    if (!id) return "Unknown";
    const k = `${base}|${kind}|${id}`; if (seerrTitles.has(k)) return seerrTitles.get(k)!;
    const t = await call(`${base}/api/v1/${kind}/${id}`, { headers: h }).catch(() => null);
    const name = t?.ok ? String(kind === "tv" ? t.body?.name || "" : t.body?.title || "") : "";
    if (name) { if (seerrTitles.size > 500) seerrTitles.clear(); seerrTitles.set(k, name); }
    return name || `TMDB ${id}`;
  };
  const requests = await Promise.all(results.slice(0, 5).map(async r => ({
    id: Number(r.id) || 0, title: await titleOf(r), kind: r.type === "tv" ? "tv" : "movie",
    status: REQ_STATUS[Number(r.status)] || "unknown", media: MEDIA_STATUS[Number(r.media?.status)] || "",
    user: String(r.requestedBy?.displayName || r.requestedBy?.username || ""), at: String(r.createdAt || ""),
  })));
  const c = count.body || {};
  return { type: "seerr", link: trimSlash(w.link || w.url), pending: Number(c.pending) || 0, processing: Number(c.processing) || 0, total: Number(c.total) || 0, requests };
}
