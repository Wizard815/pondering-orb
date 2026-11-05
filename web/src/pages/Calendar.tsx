import { useState } from "react";
import type { PageDef } from "./types";
import { create, useColl, Doc } from "../lib/store";
import { useUi } from "../lib/ui";
import { removeWithUndo } from "../components/Common";
import { DayPlan, Milestones } from "../components/Glance";
import { DAY, choreState, fmtDate, isoOf, todayISO } from "../lib/util";

type Item = { date: string; time: string; title: string; kind: "ev" | "uk"; over?: boolean };

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

function Month({ month }: { month: Date }) {
  const agenda = useAgenda(), y = month.getFullYear(), mo = month.getMonth();
  const start = new Date(y, mo, 1 - ((new Date(y, mo, 1).getDay() + 6) % 7));
  const cells = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const byDay: Record<string, Item[]> = {};
  agenda(isoOf(cells[0]), isoOf(cells[41])).forEach(i => (byDay[i.date] ||= []).push(i));
  const today = todayISO();
  return <>
    <div style={{ overflowX: "auto" }}><div className="month">
      {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => <div key={d} className="dow">{d}</div>)}
      {cells.map(d => { const iso = isoOf(d), ev = byDay[iso] || [];
        return <div key={iso} className={"cell" + (d.getMonth() !== mo ? " out" : "") + (iso === today ? " today" : "")} aria-label={fmtDate(iso)}>
          <span className="dn">{d.getDate()}</span>
          {ev.slice(0, 3).map((e, k) => <span key={k} className={"ev" + (e.kind === "uk" ? " uk" : "")} title={e.title}>{e.time ? e.time + " " : ""}{e.title}</span>)}
          {ev.length > 3 && <span className="dn" title={ev.slice(3).map(e => e.title).join("\n")}>+{ev.length - 3}</span>}
        </div>; })}
    </div></div>
    <div className="hint">Blue: events and task due dates. Amber: chores due.</div>
  </>;
}

function Next({ days }: { days: number }) {
  const agenda = useAgenda(), items = agenda(todayISO(), isoOf(new Date(Date.now() + days * DAY)));
  if (!items.length) return <div className="empty">Nothing in the next {days} days.</div>;
  return <ul className="list">{items.map((i, k) => <li key={k}>
    <span className="date">{i.kind === "uk" && i.over ? "overdue" : new Date(i.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}{i.time ? " " + i.time : ""}</span>
    <div className="grow">{i.kind === "uk" && <><span className="tag" style={{ color: "var(--warn)" }}>chore</span> </>}{i.title}</div>
  </li>)}</ul>;
}

function AddEvent() {
  const ui = useUi(), events = useColl("events"), today = todayISO();
  const [title, setTitle] = useState(""), [date, setDate] = useState(today), [time, setTime] = useState("");
  const add = async (e: React.FormEvent) => {
    e.preventDefault(); const t = title.trim(); if (!t || !date) return;
    try { await create("events", { title: t, date, time }); setTitle(""); setTime(""); ui.status(`Added ${t} on ${fmtDate(date)}.`); } catch (x) { ui.error(x); }
  };
  const upcoming = [...events].filter(e => e.date >= today).sort((a, b) => a.date.localeCompare(b.date) || String(a.time || "").localeCompare(String(b.time || ""))).slice(0, 8);
  return <>
    <form className="row" onSubmit={add}>
      <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="What" aria-label="Event title" required style={{ flex: "1 1 160px" }} />
      <input type="date" value={date} onChange={e => setDate(e.target.value)} aria-label="Date" required />
      <input type="time" value={time} onChange={e => setTime(e.target.value)} aria-label="Time" />
      <button className="btn primary" type="submit">Add</button>
    </form>
    {upcoming.length > 0 && <ul className="list">{upcoming.map(e => <li key={e.id}><span className="date">{fmtDate(e.date)}{e.time ? " " + e.time : ""}</span><div className="grow">{e.title}</div>
      <button className="btn" aria-label={"Remove " + e.title} onClick={() => removeWithUndo(ui, "events", e.id, `Removed ${e.title}.`).catch(ui.error)}>Remove</button></li>)}</ul>}
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
