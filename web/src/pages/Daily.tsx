import type { PageDef } from "./types";
import { useColl, useSettings } from "../lib/store";
import { useUi } from "../lib/ui";
import { post } from "../lib/api";
import { useFetch } from "../lib/useFetch";
import { Markdown } from "../lib/markdown";
import { ago, choreState, fmtDate, sortTasks, todayISO, zoneOpt } from "../lib/util";
import { TaskRows } from "../components/Common";
import { Spark, pct, money } from "../components/Spark";
import { useAppPanels } from "../components/AppPanels";

type Ev = { title: string; start: string; end: string; allDay: boolean; location: string; calendar?: string; day: string };
type Wx = { place: string; units: "F" | "C"; now: { temp: number; feels: number; wind: number; text: string }; days: { date: string; high: number; low: number; rain: number; text: string }[] };
type News = { title: string; link: string; source: string; published: number; summary: string };
type Q = { symbol: string; name?: string; price?: number; change?: number; changePct?: number; history?: { date: string; close: number }[]; error?: string };

const time = (e: Ev) => e.allDay ? "all day" : e.start.length > 10 ? new Date(e.start.endsWith("Z") ? e.start : e.start).toLocaleTimeString(undefined, { ...(e.start.endsWith("Z") ? zoneOpt() : {}), hour: "numeric", minute: "2-digit" }) : "";
const dayName = (iso: string) => iso === todayISO() ? "Today" : new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

function Brief() {
  const ui = useUi(), day = todayISO(), doc = useColl("daily").find(d => d.id === day), s = useSettings().daily || {};
  const regen = async (e: React.MouseEvent<HTMLButtonElement>) => { const b = e.currentTarget; b.disabled = true; ui.status("The Golem is writing today's brief…");
    try { await post("/api/daily/brief", {}); ui.status("Brief written."); } catch (x) { ui.error(x); } finally { b.disabled = false; } };
  return <div className="brief">
    {doc ? <Markdown text={doc.brief} /> : <div className="empty">No brief yet today. {s.briefOn === false ? "The morning brief is off in Settings → Daily page." : `It's written after ${String(s.briefHour ?? 7).padStart(2, "0")}:00.`}</div>}
    <div className="row small"><button className="btn" onClick={regen}>{doc ? "Write it again" : "Write it now"}</button>{doc && <span className="hint">written {ago(doc.generatedAt)}{doc.notes?.length ? ` · ${doc.notes.join("; ")}` : ""}</span>}</div>
  </div>;
}

function Weather() {
  const { data, error } = useFetch<Wx>("/api/daily/weather", 20 * 60000);
  if (error) return <div className="empty">{error} <a href="#config">Settings</a></div>;
  if (!data) return <div className="hint">Reading the skies…</div>;
  return <div className="wx">
    <div className="wx-now"><span className="wx-t">{data.now.temp}°{data.units}</span><div><b>{data.now.text}</b><div className="hint">feels {data.now.feels}° · wind {data.now.wind} {data.units === "F" ? "mph" : "km/h"} · {data.place}</div></div></div>
    <div className="wx-days">{data.days.map(d => <div key={d.date} className="wx-day"><div className="small">{d.date === todayISO() ? "Today" : new Date(d.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "short" })}</div>
      <div><b>{d.high}°</b> <span className="muted">{d.low}°</span></div><div className="hint">{d.text}{d.rain ? ` · ${d.rain}%` : ""}</div></div>)}</div>
  </div>;
}

function useEvents() { return useFetch<Ev[]>("/api/daily/events?days=7", 10 * 60000); }
function Today() {
  const { data, error } = useEvents(), day = todayISO(), tasks = useColl("tasks"), chores = useColl("chores");
  const ev = (data || []).filter(e => e.day === day), due = sortTasks(tasks.filter(t => !t.done && t.due && t.due <= day));
  const ch = chores.map(c => ({ c, s: choreState(c) })).filter(x => x.s.cls === "over" || x.s.left <= 0 || !x.c.lastDone);
  return <>
    {error && <div className="err-inline small">Calendar: {error}</div>}
    {ev.length ? <ul className="list">{ev.map((e, k) => <li key={k}><span className="date">{time(e)}</span><div className="grow">{e.title}{e.location && <div className="hint">{e.location}</div>}</div>{e.calendar && <span className="tag">{e.calendar}</span>}</li>)}</ul>
      : data && <div className="empty small">Nothing on the calendar today.</div>}
    {due.length > 0 && <><h4 className="group-name">Due today or overdue</h4><TaskRows tasks={due} showList /></>}
    {ch.length > 0 && <><h4 className="group-name">Chores due</h4><ul className="list">{ch.map(({ c, s }) => <li key={c.id}><div className="grow">{c.name}</div><span className={"chip " + (s.cls === "over" ? "bad" : "warn")}>{!c.lastDone ? "never done" : s.left < 0 ? `${-s.left} day${s.left === -1 ? "" : "s"} late` : "due today"}</span></li>)}</ul></>}
  </>;
}
function Week() {
  const { data } = useEvents(), day = todayISO();
  const rest = (data || []).filter(e => e.day > day), days = [...new Set(rest.map(e => e.day))];
  if (!data) return <div className="hint">Reading the calendar…</div>;
  if (!days.length) return <div className="empty">Nothing else this week.</div>;
  return <>{days.map(d => <div key={d}><h4 className="group-name">{dayName(d)}</h4><ul className="list">{rest.filter(e => e.day === d).map((e, k) =>
    <li key={k}><span className="date">{time(e)}</span><div className="grow">{e.title}</div>{e.calendar && <span className="tag">{e.calendar}</span>}</li>)}</ul></div>)}</>;
}
function Tasks() {
  const tasks = sortTasks(useColl("tasks").filter(t => !t.done)).slice(0, 10);
  return tasks.length ? <><TaskRows tasks={tasks} showList /><div className="row"><a className="btn" href="#todo">All tasks</a></div></> : <div className="empty">No open tasks.</div>;
}
function NewsList() {
  const { data, error } = useFetch<News[]>("/api/daily/news", 15 * 60000);
  if (error) return <div className="empty">{error}</div>;
  if (!data) return <div className="hint">Gathering the news…</div>;
  return <ul className="list news">{data.slice(0, 15).map((n, k) => <li key={k}><div className="grow"><a href={n.link} target="_blank" rel="noopener noreferrer">{n.title}</a>
    <div className="hint">{n.source}{n.published ? ` · ${ago(n.published)}` : ""}</div></div></li>)}</ul>;
}
function Stocks() {
  const { data, error, at } = useFetch<Q[]>("/api/daily/quotes", 10 * 60000);
  if (error) return <div className="empty">{error}</div>;
  if (!data) return <div className="hint">Checking the markets…</div>;
  if (!data.length) return <div className="empty">Add tickers in Settings → Daily page.</div>;
  return <><table className="tbl stocks"><tbody>{data.map(q => q.error ? <tr key={q.symbol}><td><b>{q.symbol}</b></td><td colSpan={3} className="small err-inline">{q.error}</td></tr>
    : <tr key={q.symbol}><td><b>{q.symbol}</b><div className="hint">{q.name}</div></td><td className="num">{money(q.price!)}</td>
      <td className={"num " + (q.change! >= 0 ? "up" : "down")}>{pct(q.changePct!)}</td><td><Spark data={(q.history || []).map(b => b.close)} /></td></tr>)}</tbody></table>
    <div className="hint">Prices can be delayed. Updated {ago(at)}.</div></>;
}
function PicksToday() {
  const day = todayISO(), picks = useColl("picks").filter(p => p.date === day), r = useColl("research").find(d => d.id === day);
  if (!picks.length) return <div className="empty">{r?.status && r.status !== "done" && r.status !== "failed" ? "Research is running…" : "No stock picks today."} <a href="#picks">Picks</a></div>;
  return <ul className="list">{picks.map(p => <li key={p.id}><b>{p.symbol}</b><div className="grow small">{p.thesis}</div>
    <span className={"chip " + ({ buy: "ok", hold: "warn", skip: "bad" } as any)[p.verdict?.answers?.action?.choice] || ""}>{p.verdict?.answers?.action?.choice || "?"}</span>
    <span className="tag">{p.decision === "pending" ? "waiting for you" : p.decision}</span></li>)}<li><a className="btn" href="#picks">Open Picks</a></li></ul>;
}

export const DailyPage: PageDef = {
  id: "daily", label: "Daily", title: "Morning Scroll", flavor: "The Golem's morning brief: weather, news, markets, your tasks and the week ahead.",
  usePanels: () => {
    // Your apps can go on this page too (Edit layout → add). Goblin-Bank and Omi start here.
    const { panels: apps, widgetKeys } = useAppPanels();
    const own = [
      { key: "brief", title: "Morning brief", node: <Brief />, w: 8, h: 14 },
      { key: "weather", title: "Weather", node: <Weather />, w: 4, h: 7 },
      { key: "today", title: "Today", node: <Today />, w: 4, h: 7 },
      { key: "week", title: "This week", node: <Week />, w: 4, h: 9 },
      { key: "tasks", title: "Current tasks", node: <Tasks />, w: 4, h: 9 },
      { key: "stocks", title: "Markets", node: <Stocks />, w: 4, h: 9 },
      { key: "news", title: "News", node: <NewsList />, w: 6, h: 11 },
      { key: "picks", title: "Today's stock picks", node: <PicksToday />, w: 6, h: 7 },
    ];
    return { panels: [...own, ...apps], defaults: [...own.map(p => p.key), ...widgetKeys("omi"), ...widgetKeys("goblinbank")] };
  },
};
