import { call, trimSlash } from "./http.js";
import { HttpError } from "../records.js";

/** The ALLGlance gateway (one MCP + REST front door for vikunja, dayGLANCE,
 *  lastGLANCE and lifeGLANCE). Orb reads dayGLANCE's day plan and inbox,
 *  lastGLANCE chores and lifeGLANCE milestones here. vikunja tasks keep
 *  coming over CalDAV, so they aren't fetched twice. */
export class AllGlance {
  constructor(private base: () => string, private token: () => string) {}
  get configured() { return !!this.base(); }
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
  /** dayGLANCE tasks (inbox and today), with priority on vikunja's scale. */
  async dayglanceTasks(owner?: string) {
    const r = await this.get(`/api/allglance/tasks${owner ? `?owner=${encodeURIComponent(owner)}` : ""}`);
    return (r?.dayglance || []).map((t: any) => ({ id: t.id, title: t.title, due: t.due_date, done: !!t.completed, owner: t.owner_id, start: t.start_time,
      priority: typeof t.priority === "number" ? t.priority : Math.max(0, Math.min(5, Number(t.extra?.priority) || 0)), source: "dayglance" }));
  }
  async chores(owner?: string) { return ((await this.get(`/api/allglance/chores${owner ? `?owner=${encodeURIComponent(owner)}` : ""}`))?.chores || []).map((c: any) => ({ id: c.id, title: c.title, owner: c.owner_id, lastDone: c.last_completed ? String(c.last_completed).slice(0, 10) : "" })); }
  async milestones() { return ((await this.get("/api/allglance/milestones"))?.milestones || []).map((m: any) => ({ id: m.id, title: m.title, date: m.date, owner: m.owner_id })); }
  async users() { return (await this.get("/api/allglance/users"))?.users || []; }
}
const clock = (v: unknown) => { const m = /(\d{1,2}):(\d{2})/.exec(String(v ?? "")); return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null; };
