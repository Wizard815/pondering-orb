export const DAY = 864e5;
export const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
export const isoOf = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
export const fmtDate = (iso?: string) => { if (!iso) return ""; const d = new Date(iso.length === 10 ? iso + "T12:00:00" : iso); return isNaN(+d) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); };
export function ago(t?: string | number) { if (!t) return ""; const ms = Date.now() - new Date(t).getTime(); if (isNaN(ms)) return ""; const m = Math.round(ms / 6e4); if (m < 60) return `${m} min ago`; const h = Math.round(m / 60); if (h < 48) return `${h} h ago`; return `${Math.round(h / 24)} days ago`; }
export const isUrl = (u?: string) => /^https?:\/\//.test(u || "");
export const clip = (t: string, n: number) => { t = String(t || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; };

export const STATUSES = ["next", "active", "blocked", "paused", "shipped"] as const;
export const STATUS_LABEL: Record<string, string> = { next: "Up next", active: "Active", blocked: "Blocked", paused: "Paused", shipped: "Shipped" };
export const listOf = (t: any) => t.list || t.project || "Inbox";
/** Task priority. Stored as CalDAV's PRIORITY (0 none, 1 highest .. 9 lowest)
 *  and shown as vikunja's five levels, using the same mapping vikunja's CalDAV
 *  server uses, so a level set here is the level vikunja and ALLGlance show. */
export const PRIO_LEVELS = [
  { level: 0, name: "None", cal: 0 }, { level: 1, name: "Low", cal: 9 }, { level: 2, name: "Medium", cal: 5 },
  { level: 3, name: "High", cal: 3 }, { level: 4, name: "Urgent", cal: 2 }, { level: 5, name: "Do now", cal: 1 },
] as const;
const CAL_TO_LEVEL = [0, 5, 4, 3, 3, 2, 1, 1, 1, 1];
/** 0 none, 1 low, 2 medium, 3 high, 4 urgent, 5 do now. */
export const prioOf = (t: any) => CAL_TO_LEVEL[Math.max(0, Math.min(9, Math.round(Number(t?.priority) || 0)))];
export const prioName = (level: number) => PRIO_LEVELS[level]?.name ?? "None";
export const prioCal = (level: number) => PRIO_LEVELS[level]?.cal ?? 0;
const prioRank = (t: any) => -prioOf(t);
export const sortTasks = <T extends any>(l: T[]) => [...l].sort((a: any, b: any) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || prioRank(a) - prioRank(b) || String(a.due || "9999").localeCompare(String(b.due || "9999")));
export function choreState(c: any) {
  const last = c.lastDone ? new Date(c.lastDone + "T12:00:00").getTime() : 0;
  const due = last + (Number(c.everyDays) || 7) * DAY, left = Math.floor((due - Date.now()) / DAY);
  return { due, left, cls: left < 0 ? "over" : left <= 1 ? "soon" : "ok" };
}
export const logSorted = (logs: any[]) => [...logs].sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.created || 0) - (a.created || 0));
