/** Just enough iCalendar (RFC 5545) for VTODOs: parse one, and write one back
 *  while keeping every property Orb doesn't manage. */
export type Todo = { uid: string; summary: string; status: string; due: string; priority: number; completed: string; rrule: string; dtstart: string; raw: string };

import { localDay } from "../dates.js";

const unfold = (s: string) => s.replace(/\r?\n[ \t]/g, "");
/** One pass, so "C:\\new" reads back as a backslash and "new", not a line break. */
const unesc = (v: string) => v.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
const escv = (v: string) => v.replace(/\r\n?/g, "\n").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
/** Fold a content line at 75 octets (RFC 5545 3.1), never inside a UTF-8 character. */
function fold(line: string) {
  const out: string[] = []; let cur = "", bytes = 0, limit = 75;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > limit) { out.push(cur); cur = ""; bytes = 0; limit = 74; }
    cur += ch; bytes += b;
  }
  out.push(cur); return out.join("\r\n ");
}
/** 20261105, 20261105T120000Z, or a TZID-qualified value → YYYY-MM-DD.
 *  A UTC time is turned into the server's local day. */
export const icalDate = (v: string) => {
  const z = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(v || "");
  if (z) return localDay(Date.UTC(+z[1], +z[2] - 1, +z[3], +z[4], +z[5], +z[6]));
  const m = /(\d{4})(\d{2})(\d{2})/.exec(v || ""); return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
};

export function parseTodo(ics: string): Todo | null {
  const text = unfold(ics);
  // The master VTODO (no RECURRENCE-ID) when a file also holds exceptions.
  const all = [...text.matchAll(/BEGIN:VTODO\r?\n([\s\S]*?)END:VTODO/g)];
  const m = all.find(x => !/^RECURRENCE-ID[:;]/m.test(x[1])) || all[0]; if (!m) return null;
  const props: Record<string, string> = {};
  let sub = 0;
  for (const line of m[1].split(/\r?\n/)) {
    if (/^BEGIN:/.test(line)) { sub++; continue; }
    if (/^END:/.test(line)) { sub--; continue; }
    if (sub) continue;
    const i = line.indexOf(":"); if (i < 0) continue;
    const name = line.slice(0, i).split(";")[0].toUpperCase(); if (!(name in props)) props[name] = line.slice(i + 1);
  }
  return { uid: props.UID || "", summary: unesc(props.SUMMARY || ""), status: (props.STATUS || "NEEDS-ACTION").toUpperCase(), due: icalDate(props.DUE || ""), priority: Number(props.PRIORITY) || 0,
    completed: icalDate(props.COMPLETED || ""), rrule: props.RRULE || "", dtstart: icalDate(props.DTSTART || ""), raw: text };
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const dateVal = (iso: string) => iso.replace(/-/g, "");
/** A DUE/DTSTART line for a day, keeping the old line's type (date or
 *  date-time), parameters and time of day when there was one. */
function dayLine(name: string, iso: string, old?: string) {
  if (old) {
    const i = old.indexOf(":"), params = old.slice(0, i), v = old.slice(i + 1);
    if (icalDate(v) === iso) return old; // same day: leave it exactly as it was
    const t = /T\d{6}Z?$/.exec(v);
    if (t && !/VALUE=DATE(?!-)/i.test(params)) return `${params}:${dateVal(iso)}${t[0]}`;
  }
  return `${name};VALUE=DATE:${dateVal(iso)}`;
}

/** Change the managed properties inside an existing VTODO (or build a new one),
 *  leaving everything else (alarms, categories, other apps' X- fields) alone.
 *  Only the master VTODO is edited; recurrence exceptions stay as they are. */
export function writeTodo(base: string | null, t: { uid: string; summary: string; done: boolean; due: string; priority: number; rrule?: string; dtstart?: string }) {
  const managed = (old: Record<string, string>): Record<string, string | null> => ({
    SUMMARY: `SUMMARY:${escv(t.summary)}`,
    STATUS: `STATUS:${t.done ? "COMPLETED" : "NEEDS-ACTION"}`,
    "PERCENT-COMPLETE": t.done ? "PERCENT-COMPLETE:100" : null,
    // Keep the time it was finished when it was already done.
    COMPLETED: t.done ? (old.COMPLETED && /COMPLETED/i.test(old.STATUS || "") ? old.COMPLETED : `COMPLETED:${stamp()}`) : null,
    DUE: t.due ? dayLine("DUE", t.due, old.DUE) : null,
    DURATION: t.due ? null : old.DURATION ?? null, // DUE and DURATION can't both be set
    PRIORITY: t.priority ? `PRIORITY:${t.priority}` : null,
    "LAST-MODIFIED": `LAST-MODIFIED:${stamp()}`, DTSTAMP: `DTSTAMP:${stamp()}`,
    ...(t.rrule !== undefined ? { RRULE: t.rrule ? `RRULE:${t.rrule}` : null } : {}),
    ...(t.dtstart !== undefined ? { DTSTART: t.dtstart ? dayLine("DTSTART", t.dtstart, old.DTSTART) : null } : {}),
  });
  if (!base) {
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Pondering Orb//EN", "BEGIN:VTODO", `UID:${t.uid}`, ...Object.values(managed({})).filter(Boolean) as string[], "END:VTODO", "END:VCALENDAR"];
    return lines.map(fold).join("\r\n") + "\r\n";
  }
  const lines = unfold(base).split(/\r?\n/), out: string[] = [];
  let edited = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "BEGIN:VTODO") { if (lines[i]) out.push(lines[i]); continue; }
    let j = i + 1; while (j < lines.length && lines[j] !== "END:VTODO") j++;
    const body = lines.slice(i + 1, j);
    // Top-level properties of this VTODO (not inside VALARM).
    const top: Record<string, string> = {}; let sub = 0;
    for (const l of body) { if (/^BEGIN:/.test(l)) sub++; else if (/^END:/.test(l)) sub--; else if (!sub && l.includes(":")) { const n = l.split(/[:;]/)[0].toUpperCase(); top[n] ??= l; } }
    if (edited || "RECURRENCE-ID" in top) { out.push(lines[i], ...body.filter(Boolean), "END:VTODO"); i = j; continue; }
    const set = managed(top), seen = new Set<string>(); sub = 0;
    out.push("BEGIN:VTODO");
    for (const l of body) {
      if (/^BEGIN:/.test(l)) sub++;
      if (!sub && l) { const n = l.split(/[:;]/)[0].toUpperCase(); if (n in set) { if (!seen.has(n)) { seen.add(n); if (set[n]) out.push(set[n]!); } continue; } }
      if (/^END:/.test(l)) sub--;
      if (l) out.push(l);
    }
    for (const [k, v] of Object.entries(set)) if (!seen.has(k) && v) out.push(v);
    out.push("END:VTODO"); edited = true; i = j;
  }
  return out.map(fold).join("\r\n") + "\r\n";
}

/** The fields Orb manages, to tell whether a write would change anything. */
export const managedOf = (ics: string) => { const t = parseTodo(ics); return t && JSON.stringify([t.summary, t.status === "COMPLETED", t.due, t.priority, t.rrule]); };

/** RRULE → interval in days, for chores (DAILY, WEEKLY, MONTHLY, YEARLY). */
export function rruleDays(rrule: string) {
  const p = Object.fromEntries(rrule.split(";").map(x => x.split("=")));
  const n = Math.max(1, Number(p.INTERVAL) || 1);
  return ({ DAILY: 1, WEEKLY: 7, MONTHLY: 30, YEARLY: 365 } as Record<string, number>)[p.FREQ] * n || 7;
}
export const daysRrule = (days: number) => days % 7 === 0 ? `FREQ=WEEKLY;INTERVAL=${days / 7}` : days % 30 === 0 ? `FREQ=MONTHLY;INTERVAL=${days / 30}` : `FREQ=DAILY;INTERVAL=${days}`;
