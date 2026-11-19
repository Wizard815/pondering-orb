import type { Store } from "./db.js";

/** Scripts: jobs built into Orb that you can run from Settings → Scripts or
 *  on a cron schedule. Only these built-in jobs run; there is no way to add
 *  shell commands from the web page. */

export type ScriptOption = { key: string; label: string; placeholder?: string };
export type ScriptRun = { at: string; ok: boolean; by: "you" | "cron"; summary: string; details: string[]; ms: number };
export type ScriptDef = {
  id: string; name: string; description: string;
  /** A schedule offered when you turn it on. */
  defaultCron: string;
  options?: ScriptOption[];
  run: (options: Record<string, string>) => Promise<{ summary: string; details?: string[] }>;
};
export type ScriptSetting = { on?: boolean; cron?: string; options?: Record<string, string> };

// ---- cron ----
/** Five fields: minute hour day-of-month month day-of-week, in the server's time zone.
 *  Each takes *, a number, a-b, lists (1,15) and steps (*\/15, 8-18/2). Sunday is 0 or 7. */
const FIELDS: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
function parseField(f: string, [lo, hi]: [number, number]): Set<number> | null {
  const out = new Set<number>();
  for (const part of f.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    let a = lo, b = hi;
    if (m[2] !== undefined) { a = Number(m[2]); b = m[3] !== undefined ? Number(m[3]) : (m[4] ? hi : a); }
    const step = m[4] ? Number(m[4]) : 1;
    if (a < lo || b > hi || a > b || step < 1) return null;
    for (let i = a; i <= b; i += step) out.add(i);
  }
  return out;
}
export type Cron = { sets: Set<number>[]; domAny: boolean; dowAny: boolean };
export function parseCron(expr: string): Cron | null {
  const parts = String(expr || "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (sets.some(s => !s)) return null;
  if (sets[4]!.has(7)) sets[4]!.add(0);
  return { sets: sets as Set<number>[], domAny: parts[2] === "*", dowAny: parts[4] === "*" };
}
/** Whether a cron fires in the minute of `d` (local time). Like cron, a day matches
 *  on day-of-month OR day-of-week when both are restricted. */
export function cronMatches(c: Cron, d: Date): boolean {
  const [mi, h, dom, mo, dow] = c.sets;
  if (!mi.has(d.getMinutes()) || !h.has(d.getHours()) || !mo.has(d.getMonth() + 1)) return false;
  const a = dom.has(d.getDate()), b = dow.has(d.getDay());
  return c.domAny && c.dowAny ? true : c.domAny ? b : c.dowAny ? a : a || b;
}
/** Next minute the cron fires after `from`, within a year. */
export function nextRun(c: Cron, from = new Date()): Date | null {
  const d = new Date(from); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++, d.setMinutes(d.getMinutes() + 1)) if (cronMatches(c, d)) return new Date(d);
  return null;
}

// ---- runner ----
export class Scripts {
  private running = new Set<string>();
  private lastMinute = "";
  constructor(private store: Store, private defs: ScriptDef[], private settings: () => Record<string, ScriptSetting>, private log: (msg: string, extra?: unknown) => void = () => {}) {}

  get(id: string) { return this.defs.find(d => d.id === id); }
  history(id: string): ScriptRun[] { return ((this.store.get("scriptruns", id) as any)?.runs as ScriptRun[]) || []; }

  list() {
    const st = this.settings();
    return this.defs.map(d => {
      const s = st[d.id] || {}, cron = s.cron || d.defaultCron, c = parseCron(cron);
      return { id: d.id, name: d.name, description: d.description, options: d.options || [], on: !!s.on, cron, defaultCron: d.defaultCron, values: s.options || {},
        cronOk: !!c, next: s.on && c ? nextRun(c)?.toISOString() ?? null : null, running: this.running.has(d.id), runs: this.history(d.id).slice(0, 10) };
    });
  }

  async run(id: string, by: "you" | "cron"): Promise<ScriptRun> {
    const d = this.get(id);
    if (!d) throw new Error(`No script ${id}.`);
    if (this.running.has(id)) throw new Error(`${d.name} is already running.`);
    this.running.add(id);
    const t0 = Date.now();
    let run: ScriptRun;
    try {
      const r = await d.run(this.settings()[id]?.options || {});
      run = { at: new Date().toISOString(), ok: true, by, summary: r.summary, details: (r.details || []).slice(0, 200), ms: Date.now() - t0 };
    } catch (e: any) {
      run = { at: new Date().toISOString(), ok: false, by, summary: String(e?.message || e).slice(0, 500), details: [], ms: Date.now() - t0 };
    } finally { this.running.delete(id); }
    this.store.set("scriptruns", id, { runs: [run, ...this.history(id)].slice(0, 20) });
    this.log(`script ${id}: ${run.summary}`, { ok: run.ok, by });
    return run;
  }

  /** Call every minute or so: starts each turned-on script whose cron matches this minute, once. */
  async tick(now = new Date()) {
    const minute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;
    if (minute === this.lastMinute) return;
    this.lastMinute = minute;
    const st = this.settings();
    await Promise.all(this.defs.map(async d => {
      const s = st[d.id];
      const c = s?.on ? parseCron(s.cron || d.defaultCron) : null;
      if (c && cronMatches(c, now) && !this.running.has(d.id)) await this.run(d.id, "cron").catch(() => {});
    }));
  }
}
