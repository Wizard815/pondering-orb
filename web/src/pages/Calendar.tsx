import { useState } from "react";
import type { PageDef } from "./types";
import { create, useColl, Doc } from "../lib/store";
import { useUi } from "../lib/ui";
import { removeWithUndo } from "../components/Common";
import { DayPlan, Milestones } from "../components/Glance";
import { DAY, choreState, fmtDate, isoOf, oneAtATime, todayISO, zoneOpt } from "../lib/util";
import { useFetch } from "../lib/useFetch";
import { post } from "../lib/api";

type Item = { date: string; time: string; title: string; kind: "ev" | "uk" | "fam"; over?: boolean; cal?: string };

/** Events, open task due dates and chores' next due date between two days (inclusive). */
function agendaBetween(events: Doc[], tasks: Doc[], chores: Doc[], from: string, to: string): Item[] {
  const items: Item[] = events.filter(e => e.date >= from && e.date <= to).map(e => ({ date: e.date, time: e.time || "", title: e.title, kind: "ev" }));
  for (const t of tasks) if (!t.done && t.due && t.due >= from && t.due <= to) items.push({ date: t.due, time: "", title: "☐ " + t.title, kind: "ev" });
  for (const c of chores) {
    const s = choreState(c), d = isoOf(new Date(Math.max(s.due, Date.now())));
    if (d >= from && d <= to) items.push({ date: d, time: "", title: c.name, kind: "uk", over: s.left < 0 });
  }
  return items.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
}
const useAgenda = () => { const e = useColl("events"), t = useColl("tasks"), c = useColl("chores"); return (from: string, to: string) => agendaBetween(e, t, c, from, to); };
/** Events Orb doesn't own: the family calendar (dayGLANCE through ALLGlance) and any CalDAV calendars. */
function useOutside(from: string, days: number): Item[] {
  const { data } = useFetch<any[]>(`/api/daily/events?from=${from}&days=${days}`, 10 * 60000);
  return (data || []).filter(e => e.calendar !== "Orb").map(e => ({ date: e.day, time: e.allDay ? "" : (e.start.length > 10 ? new Date(e.start.endsWith("Z") ? e.start : e.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false, ...(e.start.endsWith("Z") ? zoneOpt() : {}) }) : ""),
    title: e.title, kind: "fam" as const, cal: e.calendar }));
}
const merge = (a: Item[], b: Item[]) => [...a, ...b].sort((x, y) => x.date.localeCompare(y.date) || x.time.localeCompare(y.time));

function Month({ month }: { month: Date }) {
  const ui = useUi(), agenda = useAgenda(), y = month.getFullYear(), mo = month.getMonth();
  const start = new Date(y, mo, 1 - ((new Date(y, mo, 1).getDay() + 6) % 7));
  const cells = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const byDay: Record<string, Item[]> = {}, outside = useOutside(isoOf(cells[0]), 42);
  merge(agenda(isoOf(cells[0]), isoOf(cells[41])), outside).forEach(i => (byDay[i.date] ||= []).push(i));
  const today = todayISO();
  return <>
    <div style={{ overflowX: "auto" }}><div className="month">
      {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => <div key={d} className="dow">{d}</div>)}
      {cells.map(d => { const iso = isoOf(d), ev = byDay[iso] || [];
        return <div key={iso} className={"cell" + (d.getMonth() !== mo ? " out" : "") + (iso === today ? " today" : "")} aria-label={fmtDate(iso)}>
          <span className="dn">{d.getDate()}</span>
          {ev.slice(0, 3).map((e, k) => <span key={k} className={"ev" + (e.kind === "uk" ? " uk" : e.kind === "fam" ? " fam" : "")} title={e.cal ? `${e.title} (${e.cal})` : e.title}>{e.time ? e.time + " " : ""}{e.title}</span>)}
          {ev.length > 3 && <button type="button" className="more" aria-label={`${ev.length - 3} more on ${fmtDate(iso)}`}
            onClick={e => ui.pop(e.currentTarget, <div className="pop-form"><div className="mh" style={{ padding: 0 }}>{fmtDate(iso)}</div>
              <ul className="list">{ev.map((x, k) => <li key={k}><span className={"ev" + (x.kind === "uk" ? " uk" : "")}>{x.time ? x.time + " " : ""}{x.title}</span></li>)}</ul></div>)}>+{ev.length - 3} more</button>}
        </div>; })}
    </div></div>
    <div className="hint">Blue: events and task due dates. Green: the family calendar and other calendars. Amber: chores due.</div>
  </>;
}

function Next({ days }: { days: number }) {
  const agenda = useAgenda(), items = merge(agenda(todayISO(), isoOf(new Date(Date.now() + days * DAY))), useOutside(todayISO(), days + 1));
  if (!items.length) return <div className="empty">Nothing in the next {days} days.</div>;
  return <ul className="list">{items.map((i, k) => <li key={k}>
    <span className="date">{i.kind === "uk" && i.over ? "overdue" : new Date(i.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}{i.time ? " " + i.time : ""}</span>
    <div className="grow">{i.kind === "uk" && <><span className="tag" style={{ color: "var(--warn)" }}>chore</span> </>}{i.title}</div>{i.cal && <span className="tag">{i.cal}</span>}
  </li>)}</ul>;
}

function AddEvent() {
  const ui = useUi(), events = useColl("events"), today = todayISO();
  const [title, setTitle] = useState(""), [date, setDate] = useState(today), [time, setTime] = useState(""), [minutes, setMinutes] = useState("60");
  // With the ALLGlance gateway connected, events can go on the family calendar (dayGLANCE) instead.
  const cfg = useFetch<any>("/api/config", 0).data, family = !!cfg?.allglance?.baseUrl;
  const users = useFetch<{ id: string; name: string }[]>(family ? "/api/allglance/users" : null, 0).data || [];
  const [where, setWhere] = useState<"orb" | "family">("orb"), [owner, setOwner] = useState("");
  const add = async (e: React.FormEvent) => {
    e.preventDefault(); const t = title.trim(); if (!t || !date) return;
    await oneAtATime(e.currentTarget as HTMLFormElement, async () => {
      try {
        if (where === "family") { await post("/api/allglance/events", { title: t, date, time, minutes: time ? Number(minutes) || 60 : undefined, owner: owner || undefined }); ui.status(`Put ${t} on the family calendar for ${fmtDate(date)}.`); }
        else { await create("events", { title: t, date, time }); ui.status(`Added ${t} on ${fmtDate(date)}.`); }
        setTitle(""); setTime("");
      } catch (x) { ui.error(x); }
    });
  };
  const past = [...events].filter(e => e.date < today).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
  const upcoming = [...events].filter(e => e.date >= today).sort((a, b) => a.date.localeCompare(b.date) || String(a.time || "").localeCompare(String(b.time || ""))).slice(0, 8);
  return <>
    <form className="row" onSubmit={add}>
      <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="What" aria-label="Event title" required style={{ flex: "1 1 160px" }} />
      <input type="date" value={date} onChange={e => setDate(e.target.value)} aria-label="Date" required />
      <input type="time" value={time} onChange={e => setTime(e.target.value)} aria-label="Time" />
      {family && <select value={where} onChange={e => setWhere(e.target.value as any)} aria-label="Which calendar"><option value="orb">Orb</option><option value="family">Family calendar (dayGLANCE)</option></select>}
      {family && where === "family" && time && <select value={minutes} onChange={e => setMinutes(e.target.value)} aria-label="How long">{[15, 30, 45, 60, 90, 120, 180, 240].map(m => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`}</option>)}</select>}
      {family && where === "family" && users.length > 0 && <select value={owner} onChange={e => setOwner(e.target.value)} aria-label="For whom"><option value="">Everyone</option>{users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}
      <button className="btn primary" type="submit">Add</button>
    </form>
    {family && where === "family" && <div className="hint">Goes to dayGLANCE through the ALLGlance gateway: with a time it's a block on the calendar, without one an all-day task. Change or remove it in dayGLANCE.</div>}
    {upcoming.length > 0 && <ul className="list">{upcoming.map(e => <li key={e.id}><span className="date">{fmtDate(e.date)}{e.time ? " " + e.time : ""}</span><div className="grow">{e.title}</div>
      <button className="btn" aria-label={"Remove " + e.title} onClick={() => removeWithUndo(ui, "events", e.id, `Removed ${e.title}.`).catch(ui.error)}>Remove</button></li>)}</ul>}
    {past.length > 0 && <details><summary className="small">Past events ({past.length})</summary><ul className="list">{past.map(e => <li key={e.id}><span className="date">{fmtDate(e.date)}{e.time ? " " + e.time : ""}</span><div className="grow">{e.title}</div>
      <button className="btn" aria-label={"Remove " + e.title} onClick={() => removeWithUndo(ui, "events", e.id, `Removed ${e.title}.`).catch(ui.error)}>Remove</button></li>)}</ul></details>}
  </>;
}

// The shown month survives tab switches for the session.
let shownMonth: Date | null = null;
const firstOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);

export const CalendarPage: PageDef = {
  id: "calendar", label: "Calendar", title: "Star Chart", flavor: "Events, task due dates and chores by day.",
  usePanels: () => {
    const [month, setMonthState] = useState<Date>(shownMonth || firstOf(new Date()));
    const setMonth = (d: Date) => { shownMonth = d; setMonthState(d); };
    const step = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
    const nav = <span className="cal-nav">
      <button className="btn" onClick={() => step(-1)} aria-label="Previous month">‹</button>
      <button className="btn" onClick={() => setMonth(firstOf(new Date()))}>Today</button>
      <button className="btn" onClick={() => step(1)} aria-label="Next month">›</button>
    </span>;
    return { panels: [
      { key: "month", title: month.toLocaleDateString(undefined, { month: "long", year: "numeric" }), act: nav, node: <Month month={month} />, w: 8, h: 11 },
      { key: "next", title: "Next 14 days", node: <Next days={14} />, w: 4, h: 11 },
      { key: "add", title: "Add an event", node: <AddEvent />, w: 6, h: 7 },
      { key: "dayglance", title: "dayGLANCE day", node: <DayPlan />, w: 6, h: 9 },
      { key: "milestones", title: "Milestones (lifeGLANCE)", node: <Milestones />, w: 6, h: 7 },
    ] };
  },
};
