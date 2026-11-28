import type { FastifyInstance } from "fastify";
import type { Auth } from "./auth.js";
import type { Records } from "./records.js";
import { HttpError } from "./records.js";
import type { OrbConfig } from "./config.js";
import type { Notifier, MediaLook } from "./notify.js";
import type { CalEvent } from "./integrations/ical.js";
import { uptime } from "./integrations/uptime.js";
import { widgetsFrom, widgetData, type WidgetCfg } from "./integrations/widgets.js";
import { today, localClock } from "./dates.js";

/** What Orb's own apps (desktop and Android, see docs/apps.md) need beyond
 *  the web page they show:
 *   - POST /api/devices: sign a device in with ORB_PASSWORD and get its key
 *   - POST /api/devices/session: a key buys the device's web view a session cookie
 *   - GET/DELETE /api/devices: Settings → Devices
 *   - GET /api/glance: one small summary for widgets, the tray and the offline view
 *   - GET /api/alerts?since=: the alerts ntfy gets, for notifications
 *   - POST /api/glance/tasks/:id/done: tick a task off from a widget */
export interface AppsDeps {
  auth: Auth; records: Records; notifier: Notifier; cfg: () => OrbConfig; guard: any;
  who: (req: any) => string; appsYaml: () => string;
  events: (from: string, days: number) => Promise<(CalEvent & { day: string })[]>;
  sessionCookie: (reply: any, req: any, token: string) => void;
}

const MEDIA = ["plex", "tautulli", "sabnzbd", "sonarr", "radarr", "seerr", "jellyseerr", "overseerr"];

export function appsApi(app: FastifyInstance, d: AppsDeps) {
  const { auth, records, notifier, cfg, guard, who } = d;
  const you = (req: any) => { if (who(req) !== "you") throw new HttpError(403, "Only you (signed in, or one of your devices) can do this."); };

  app.post("/api/devices", async (req: any, reply) => {
    const b = req.body || {};
    const wait = auth.lockedFor(req.ip);
    if (wait) return reply.code(429).send({ error: `Too many wrong passwords. Try again in ${wait} min.` });
    // Open mode (no password at all) lets any device in, like the web page.
    if (!auth.open) {
      if (!auth.checkPassword(String(b.password || ""))) { auth.noteFail(req.ip); return reply.code(401).send({ error: "That password isn't right." }); }
      auth.clearFails(req.ip);
    }
    const dev = auth.devices.add(String(b.name || ""), String(b.platform || ""));
    return { id: dev.id, name: dev.name, platform: dev.platform, token: dev.token };
  });
  // The app's web view can't add a header to every request the page makes, so
  // it trades its key for an ordinary session cookie, kept in the app.
  app.post("/api/devices/session", async (req: any, reply) => {
    const h = String(req.headers.authorization || ""), t = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    if (!t || !auth.devices.check(t)) return reply.code(401).send({ error: "This device was signed out of Orb. Sign in again." });
    const s = auth.newSession();
    d.sessionCookie(reply, req, s);
    return { ok: true, cookie: "orb_session", session: s, maxAge: 60 * 60 * 24 * 30 };
  });
  app.get("/api/devices", { preHandler: guard }, async (req: any) => { you(req); return auth.devices.list(); });
  app.delete("/api/devices/:id", { preHandler: guard }, async (req: any, reply) => {
    you(req);
    if (!auth.devices.remove(req.params.id)) throw new HttpError(404, "No such device. It may already be signed out.");
    reply.code(204).send();
  });

  app.get("/api/alerts", { preHandler: guard }, async (req: any) => {
    const since = Number(req.query.since) || 0;
    return { now: Date.now(), alerts: notifier.alerts(since) };
  });

  app.post("/api/glance/tasks/:id/done", { preHandler: guard }, async (req: any) => {
    you(req);
    const t: any = records.get("tasks", req.params.id);
    if (!t) throw new HttpError(404, "That task is gone. Pull to refresh.");
    if (t.done) return { ok: true, already: true };
    records.patch("tasks", t.id, { done: true, doneAt: today(), doneBy: "you" });
    return { ok: true };
  });

  const media = () => Object.entries(widgetsFrom(d.appsYaml())).filter(([, w]) => MEDIA.includes(w.type));
  const look = async (name: string, w: WidgetCfg) => {
    try { return { name, type: w.type, data: await widgetData(name, w) as any }; } catch (e: any) { return { name, type: w.type, data: null, error: String(e.message || e) }; }
  };

  app.get("/api/glance", { preHandler: guard }, async () => glance());

  /** Each part is optional: a part that isn't set up is left out, and one that
   *  fails says so in `errors` instead of failing the whole glance. */
  async function glance() {
    const c = cfg(), day = today(), errors: string[] = [];
    const [up, cal, looks] = await Promise.all([
      c.uptime.baseUrl ? uptime(c.uptime.baseUrl, c.uptime.statusPage, c.uptime.ignore).catch((e: any) => { errors.push(`Uptime Kuma: ${e.message}`); return null; }) : Promise.resolve(null),
      d.events(day, 1).catch((e: any) => { errors.push(`Calendar: ${e.message}`); return []; }),
      Promise.all(media().map(([n, w]) => look(n, w))),
    ]);
    const tasks = (records.list("tasks") as any[]).filter(t => !t.done)
      .sort((a, b) => (a.priority || 10) - (b.priority || 10) || String(a.due || "9").localeCompare(String(b.due || "9")))
      .slice(0, 8).map(t => ({ id: t.id, title: String(t.title || ""), list: t.list || "", due: t.due || "", overdue: !!t.due && t.due < day, priority: Number(t.priority) || 0 }));
    const chores = (records.list("chores") as any[]).map(ch => ({ id: ch.id, name: String(ch.name || ""), due: ch.lastDone ? addDays(ch.lastDone, Number(ch.everyDays) || 7) : day }))
      .filter(ch => ch.due <= day).slice(0, 6);
    const b: any = records.get("daily", day);
    for (const l of looks) if ((l as any).error) errors.push(`${l.name}: ${(l as any).error}`);
    return {
      at: Date.now(), day,
      uptime: up && { total: up.monitors.filter(m => !m.ignored).length, down: up.monitors.filter(m => !m.ignored && m.status === "down").map(m => m.name) },
      events: cal.filter(e => e.day === day).map(e => ({ time: e.allDay ? "" : localClock(e.start), title: e.title, calendar: e.calendar })).slice(0, 10),
      tasks, chores,
      brief: b?.brief ? { day, headline: headline(String(b.brief)) } : null,
      media: looks.filter(l => l.data).map(l => ({ name: l.name, type: l.type, line: mediaLine(l.type, l.data) })),
      alerts: notifier.alerts(Date.now() - 864e5).length,
      errors,
    };
  }

  /** For the background check: the media widgets' data, for mediaAlerts. */
  const mediaLooks = async (): Promise<MediaLook[]> => (await Promise.all(media().filter(([, w]) => w.type !== "plex" && w.type !== "tautulli" && w.type !== "sabnzbd").map(([n, w]) => look(n, w)))).filter(l => l.data);
  return { glance, mediaLooks };
}

/** The brief's first real line (its greeting), without Markdown. */
export function headline(md: string): string {
  const line = md.split("\n").map(l => l.replace(/^[#>*\-\s_]+|[*_`]+/g, "").trim()).find(l => l.length > 3) || "";
  return line.length > 140 ? line.slice(0, 139).trimEnd() + "…" : line;
}

/** One short line per media widget, for a home-screen widget or the tray. */
export function mediaLine(type: string, x: any): string {
  if (type === "plex" || type === "tautulli") {
    const s: any[] = x.sessions || [];
    if (!s.length) return "Nothing playing";
    const first = s[0], who = first.user || first.friendly_name || "";
    return `${s.length === 1 ? "Playing" : `${s.length} playing`}: ${first.title || first.full_title || "something"}${who ? ` (${who})` : ""}`;
  }
  if (type === "sabnzbd") return x.queue?.length ? `${x.paused ? "Paused" : x.speed || "Downloading"} · ${x.queue.length} in queue${x.timeleft ? ` · ${x.timeleft} left` : ""}` : "Queue empty";
  if (type === "sonarr" || type === "radarr") {
    const q: any[] = x.queue || [], stuck = q.filter(i => i.warning).length;
    const next = (x.upcoming || [])[0];
    return [q.length ? `${x.queueTotal || q.length} downloading${stuck ? ` (${stuck} stuck)` : ""}` : "Nothing downloading", next ? `next: ${next.title}` : ""].filter(Boolean).join(" · ");
  }
  if (type === "seerr" || type === "jellyseerr" || type === "overseerr") return x.pending ? `${x.pending} ${x.pending === 1 ? "request" : "requests"} waiting` : "No requests waiting";
  return "";
}

function addDays(day: string, n: number) { const t = new Date(day + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
