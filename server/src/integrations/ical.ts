/** Just enough iCalendar (RFC 5545) for VTODOs: parse one, and write one back
 *  while keeping every property Orb doesn't manage. */
export type Todo = { uid: string; summary: string; status: string; due: string; priority: number; completed: string; rrule: string; dtstart: string; raw: string };

const unfold = (s: string) => s.replace(/\r?\n[ \t]/g, "");
const unesc = (v: string) => v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
const escv = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
/** 20261105, 20261105T120000Z, or a TZID-qualified value → YYYY-MM-DD. */
export const icalDate = (v: string) => { const m = /(\d{4})(\d{2})(\d{2})/.exec(v || ""); return m ? `${m[1]}-${m[2]}-${m[3]}` : ""; };

export function parseTodo(ics: string): Todo | null {
  const text = unfold(ics), m = /BEGIN:VTODO\r?\n([\s\S]*?)END:VTODO/.exec(text); if (!m) return null;
  const props: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (/^BEGIN:VALARM/.test(line)) break;
    const i = line.indexOf(":"); if (i < 0) continue;
    const name = line.slice(0, i).split(";")[0].toUpperCase(); if (!(name in props)) props[name] = line.slice(i + 1);
  }
  return { uid: props.UID || "", summary: unesc(props.SUMMARY || ""), status: (props.STATUS || "NEEDS-ACTION").toUpperCase(), due: icalDate(props.DUE || ""), priority: Number(props.PRIORITY) || 0,
    completed: icalDate(props.COMPLETED || ""), rrule: props.RRULE || "", dtstart: icalDate(props.DTSTART || ""), raw: text };
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const dateVal = (iso: string) => iso.replace(/-/g, "");

/** Change the managed properties inside an existing VTODO (or build a new one),
 *  leaving everything else (alarms, categories, other apps' X- fields) alone. */
export function writeTodo(base: string | null, t: { uid: string; summary: string; done: boolean; due: string; priority: number; rrule?: string; dtstart?: string }) {
  const set: Record<string, string | null> = {
    SUMMARY: `SUMMARY:${escv(t.summary)}`,
    STATUS: `STATUS:${t.done ? "COMPLETED" : "NEEDS-ACTION"}`,
    "PERCENT-COMPLETE": t.done ? "PERCENT-COMPLETE:100" : null,
    COMPLETED: t.done ? `COMPLETED:${stamp()}` : null,
    DUE: t.due ? `DUE;VALUE=DATE:${dateVal(t.due)}` : null,
    PRIORITY: t.priority ? `PRIORITY:${t.priority}` : null,
    "LAST-MODIFIED": `LAST-MODIFIED:${stamp()}`, DTSTAMP: `DTSTAMP:${stamp()}`,
    ...(t.rrule !== undefined ? { RRULE: t.rrule ? `RRULE:${t.rrule}` : null } : {}),
    ...(t.dtstart !== undefined ? { DTSTART: t.dtstart ? `DTSTART;VALUE=DATE:${dateVal(t.dtstart)}` : null } : {}),
  };
  if (!base) {
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Pondering Orb//EN", "BEGIN:VTODO", `UID:${t.uid}`, ...Object.values(set).filter(Boolean) as string[], "END:VTODO", "END:VCALENDAR"];
    return lines.join("\r\n") + "\r\n";
  }
  const text = unfold(base), out: string[] = [], seen = new Set<string>();
  let inTodo = false, inSub = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line === "BEGIN:VTODO") { inTodo = true; out.push(line); continue; }
    if (inTodo && /^BEGIN:/.test(line)) inSub++;
    if (inTodo && /^END:/.test(line) && line !== "END:VTODO") inSub--;
    if (line === "END:VTODO") { for (const [k, v] of Object.entries(set)) if (!seen.has(k) && v) out.push(v); inTodo = false; out.push(line); continue; }
    if (inTodo && !inSub) {
      const name = line.split(/[:;]/)[0].toUpperCase();
      if (name in set) { if (!seen.has(name)) { seen.add(name); if (set[name]) out.push(set[name]!); } continue; }
    }
    if (line) out.push(line);
  }
  return out.join("\r\n") + "\r\n";
}

/** RRULE → interval in days, for chores (DAILY, WEEKLY, MONTHLY, YEARLY). */
export function rruleDays(rrule: string) {
  const p = Object.fromEntries(rrule.split(";").map(x => x.split("=")));
  const n = Math.max(1, Number(p.INTERVAL) || 1);
  return ({ DAILY: 1, WEEKLY: 7, MONTHLY: 30, YEARLY: 365 } as Record<string, number>)[p.FREQ] * n || 7;
}
export const daysRrule = (days: number) => days % 7 === 0 ? `FREQ=WEEKLY;INTERVAL=${days / 7}` : days % 30 === 0 ? `FREQ=MONTHLY;INTERVAL=${days / 30}` : `FREQ=DAILY;INTERVAL=${days}`;
