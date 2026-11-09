import { call, trimSlash } from "./http.js";
import { HttpError } from "../records.js";

/** The ALLGlance gateway (one MCP + REST front door for vikunja, dayGLANCE,
 *  lastGLANCE and lifeGLANCE). Orb reads dayGLANCE's day plan (the family
 *  calendar) and tasks, lastGLANCE chores and lifeGLANCE milestones here, and
 *  can add an event to the family calendar. Vikunja tasks come over CalDAV,
 *  through the gateway's /dav, so they aren't fetched twice. */
export class AllGlance {
  constructor(private base: () => string, private token: () => string) {}
  get configured() { return !!this.base(); }
  private async send(p: string, body: unknown) {
    const b = trimSlash(this.base());
    if (!b) throw new HttpError(503, "The ALLGlance gateway isn't set up. Add its address in Settings → Connections.");
    const t = this.token();
    const r = await call(b + p, { method: "POST", headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(body) });
    if (r.status === 401) throw new HttpError(502, "The ALLGlance gateway wants a token. Set GATEWAY_TOKEN there and the same value in Orb's token variable.");
    if (r.status === 503) throw new HttpError(503, r.body?.error || "dayGLANCE is off on the gateway (ENABLE_DAYGLANCE).");
    if (!r.ok) throw new HttpError(502, r.body?.error || `The ALLGlance gateway answered ${r.status}.`);
    return r.body;
  }
  private async get(p: string) {
    const b = trimSlash(this.base());
    if (!b) throw new HttpError(503, "The ALLGlance gateway isn't set up. Add its address in Settings → Connections.");
    const t = this.token();
    const r = await call(b + p, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
    if (r.status === 401) throw new HttpError(502, "The ALLGlance gateway wants a token. Set GATEWAY_TOKEN there and the same value in Orb's token variable.");
    if (!r.ok) throw new HttpError(502, r.body?.error || `The ALLGlance gateway answered ${r.status}.`);
    return r.body;
  }
  health() { return this.get("/health"); }
  /** dayGLANCE time blocks for one date, plus its tasks for that day. */
  async day(date: string, owner?: string) {
    const r = await this.get(`/api/allglance/days/${encodeURIComponent(date)}${owner ? `?owner=${encodeURIComponent(owner)}` : ""}`);
    const blocks = (r?.blocks || []).map((b: any) => ({
      id: String(b.id ?? ""), title: String(b.title ?? b.name ?? "(block)"), start: clock(b.start_time ?? b.startTime ?? b.start),
      minutes: Number(b.duration_minutes ?? b.duration ?? 0) || null, type: b.type || "", owner: b.owner_id ?? null,
      done: Boolean(b.completed ?? b.done ?? false), color: b.color || "",
    })).sort((a: any, b: any) => String(a.start || "99").localeCompare(String(b.start || "99")));
    return { date: r?.date || date, blocks };
  }
  /** dayGLANCE tasks (the inbox and every scheduled day), with priority on vikunja's scale. */
  async dayglanceTasks(owner?: string) {
    const r = await this.get(`/api/allglance/tasks${owner ? `?owner=${encodeURIComponent(owner)}` : ""}`);
    return (r?.dayglance || []).map((t: any) => ({ id: t.id, title: t.title, due: t.due_date, done: !!t.completed, owner: t.owner_id, start: t.start_time,
      priority: typeof t.priority === "number" ? t.priority : Math.max(0, Math.min(5, Number(t.extra?.priority) || 0)), source: "dayglance" }));
  }
  async chores(owner?: string) { return ((await this.get(`/api/allglance/chores${owner ? `?owner=${encodeURIComponent(owner)}` : ""}`))?.chores || []).map((c: any) => ({ id: c.id, title: c.title, owner: c.owner_id, lastDone: c.last_completed ? String(c.last_completed).slice(0, 10) : "" })); }
  async milestones() { return ((await this.get("/api/allglance/milestones"))?.milestones || []).map((m: any) => ({ id: m.id, title: m.title, date: m.date, owner: m.owner_id })); }
  private roster: { at: number; users: { id: string; name: string }[] } | null = null;
  async users(): Promise<{ id: string; name: string }[]> {
    if (this.roster && Date.now() - this.roster.at < 10 * 60000) return this.roster.users;
    const users = ((await this.get("/api/allglance/users"))?.users || []).map((u: any) => ({ id: String(u.id ?? ""), name: String(u.name ?? u.username ?? u.id ?? "") })).filter((u: any) => u.id);
    this.roster = { at: Date.now(), users }; return users;
  }
  /** An event on the family calendar: a dayGLANCE block. A time puts it on
   *  the calendar ("YYYY-MM-DD HH:MM", the household's local time); without
   *  one it is an all-day task for that date. owner is a member id from users(). */
  async addEvent(e: { title: string; date: string; time?: string; minutes?: number; owner?: string }) {
    const body: Record<string, unknown> = { source: "dayglance", title: e.title };
    if (e.time) { body.start = `${e.date} ${e.time}`; if (e.minutes) body.duration_minutes = e.minutes; }
    else { body.due_date = e.date; body.all_day = true; }
    if (e.owner) body.owner_id = e.owner;
    return this.send("/api/allglance/tasks", body);
  }
}
const clock = (v: unknown) => { const m = /(\d{1,2}):(\d{2})/.exec(String(v ?? "")); return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null; };
