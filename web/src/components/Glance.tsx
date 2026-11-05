import { useState } from "react";
import { useFetch } from "../lib/useFetch";
import { fmtDate, prioName, todayISO } from "../lib/util";

/** Panels fed by the ALLGlance gateway (through Orb's server). */
const NotSet = ({ error }: { error: string }) => /isn't set up/.test(error)
  ? <div className="empty">Connect the ALLGlance gateway in <a href="#config">Settings → Connections</a> to see this.</div>
  : <div className="err-inline">{error}</div>;

const PRIO_CLASS = (p: number) => `prio l${p}`;
const ends = (start: string | null, min: number | null) => { if (!start || !min) return ""; const [h, m] = start.split(":").map(Number), t = h * 60 + m + min; return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; };

/** dayGLANCE's time blocks for one day. */
export function DayPlan({ date: fixed }: { date?: string }) {
  const [date, setDate] = useState(fixed || todayISO());
  const { data, error } = useFetch<{ date: string; blocks: any[] }>(`/api/allglance/day?date=${date}`, 120000);
  if (error) return <NotSet error={error} />;
  const blocks = data?.blocks || [];
  return <>
    {!fixed && <div className="row small"><input type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} aria-label="Day" /><button className="btn" onClick={() => setDate(todayISO())}>Today</button></div>}
    {blocks.length ? <ul className="list">{blocks.map(b => <li key={b.id || b.title + b.start}><span className="date">{b.start ? `${b.start}${b.minutes ? "–" + ends(b.start, b.minutes) : ""}` : "any time"}</span>
      <div className={"grow" + (b.done ? " muted" : "")} style={b.done ? { textDecoration: "line-through" } : undefined}>{b.title}{b.type && b.type !== "task" ? <span className="hint"> · {b.type}</span> : null}</div></li>)}</ul>
      : <div className="empty">{data ? `Nothing planned in dayGLANCE for ${fmtDate(date)}.` : "Loading…"}</div>}
  </>;
}

/** dayGLANCE tasks with their priority (0 none … 3 high in dayGLANCE). Read only: change them in dayGLANCE. */
export function GlanceInbox() {
  const { data, error } = useFetch<any[]>("/api/allglance/dayglance-tasks", 300000);
  if (error) return <NotSet error={error} />;
  const list = [...(data || [])].filter(t => !t.done).sort((a, b) => b.priority - a.priority || String(a.due || "9").localeCompare(String(b.due || "9")));
  if (!list.length) return <div className="empty">{data ? "dayGLANCE has no open tasks." : "Loading…"}</div>;
  return <><div>{list.slice(0, 30).map(t => <div key={t.id} className="task"><span className={PRIO_CLASS(t.priority)} title={`Priority: ${prioName(t.priority)}`}>{t.priority ? prioName(t.priority) : "·"}</span>
    <div className="grow"><span className="t">{t.title}</span>{t.start && <span className="hint"> · {t.start}</span>}</div>{t.due && <span className="due">{fmtDate(t.due)}</span>}</div>)}</div>
    <p className="hint" style={{ margin: 0 }}>From dayGLANCE through ALLGlance. Change these in dayGLANCE; scheduled blocks carry no priority by design.</p></>;
}

/** lastGLANCE chores: when each was last done. Read only. */
export function GlanceChores() {
  const { data, error } = useFetch<any[]>("/api/allglance/chores", 300000);
  if (error) return <NotSet error={error} />;
  const list = [...(data || [])].sort((a, b) => String(a.lastDone || "0").localeCompare(String(b.lastDone || "0")));
  if (!list.length) return <div className="empty">{data ? "No lastGLANCE chores." : "Loading…"}</div>;
  return <ul className="list">{list.map(c => <li key={c.id}><div className="grow">{c.title}</div><span className="date">{c.lastDone ? `last ${fmtDate(c.lastDone)}` : "never"}</span></li>)}</ul>;
}

/** lifeGLANCE milestones, newest and upcoming first. */
export function Milestones() {
  const { data, error } = useFetch<any[]>("/api/allglance/milestones", 600000);
  if (error) return <NotSet error={error} />;
  const list = [...(data || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!list.length) return <div className="empty">{data ? "No lifeGLANCE milestones." : "Loading…"}</div>;
  return <ul className="list">{list.slice(0, 20).map(m => <li key={m.id}><span className="date">{fmtDate(m.date)}</span><div className="grow">{m.title}</div></li>)}</ul>;
}
