import { useState } from "react";
import type { PageDef } from "./types";
import { useColl, useSettings, saveSettings } from "../lib/store";
import { useUi } from "../lib/ui";
import { post } from "../lib/api";
import { useFetch } from "../lib/useFetch";
import { Markdown } from "../lib/markdown";
import { ago, choreState, fmtDate, sortTasks, todayISO, zoneOpt } from "../lib/util";
import { TaskRows } from "../components/Common";
import { Spark, pct, money } from "../components/Spark";
import { useAppPanels } from "../components/AppPanels";
import { TickerNews, coverageUrl, type Coverage } from "../components/TickerNews";

/** Change part of the Daily page settings. */
const useDaily = () => { const s = useSettings(), ui = useUi(), d = s.daily || {}; return { d, save: (p: Record<string, unknown>) => saveSettings({ daily: { ...d, ...p } }).catch(ui.error) }; };
const COVERAGE: Coverage = { on: true, label: "Ground News", template: "https://ground.news/search?query={q}" };
const useCoverage = (): Coverage => { const c = useSettings().daily?.coverage; return { ...COVERAGE, ...(c || {}) }; };
/** A one-line form: type, press Enter or Add. */
function AddInline({ label, placeholder, onAdd }: { label: string; placeholder: string; onAdd: (v: string) => void }) {
  return <form className="row add-inline" onSubmit={e => { e.preventDefault(); const i = e.currentTarget.elements.namedItem("v") as HTMLInputElement; const v = i.value.trim(); if (v) { onAdd(v); i.value = ""; } }}>
    <input name="v" type="text" placeholder={placeholder} aria-label={label} /><button className="btn" type="submit">Add</button></form>;
}

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
  const { d, save } = useDaily(), fav = String(d.location || ""), places: string[] = [fav, ...((d.places || []) as string[]).filter(p => p && p !== fav)].filter(Boolean);
  const [sel, setSel] = useState(""), [edit, setEdit] = useState(false), place = sel && places.includes(sel) ? sel : fav;
  const { data, error } = useFetch<Wx>(place ? `/api/daily/weather${place !== fav ? `?place=${encodeURIComponent(place)}` : ""}` : null, 20 * 60000);
  const chips = <div className="row wx-places" role="group" aria-label="Places">
    {places.map(p => <button key={p} className={"btn" + (p === place ? " on" : "")} aria-pressed={p === place} onClick={() => setSel(p)}>{p === fav ? "★ " : ""}{p}</button>)}
    <button className="btn" onClick={() => setEdit(!edit)} aria-expanded={edit}>{edit ? "Done" : "Places…"}</button></div>;
  const manage = edit && <div className="wx-manage">
    {place && place !== fav && <div className="row"><button className="btn" onClick={() => { save({ location: place, places: places.filter(p => p !== place) }); setSel(""); }}>★ Make {place} the favourite</button>
      <button className="btn" onClick={() => { save({ places: ((d.places || []) as string[]).filter(p => p !== place) }); setSel(""); }}>Remove {place}</button></div>}
    <AddInline label="Add a place" placeholder="City, Country  or  lat,lon" onAdd={v => { if (!fav) save({ location: v }); else if (!places.includes(v)) save({ places: [...((d.places || []) as string[]), v] }); setSel(v); }} />
    <div className="hint">The favourite (★) shows first and is used in the morning brief.</div></div>;
  if (!place) return <>{chips}{manage || <div className="empty">Add a place for the weather. <button className="btn" onClick={() => setEdit(true)}>Add a place</button></div>}</>;
  return <div className="wx">{chips}{manage}
    {error ? <div className="empty">{error}</div> : !data || data.place === undefined ? <div className="hint">Reading the skies…</div> : <>
    <div className="wx-now"><span className="wx-t">{data.now.temp}°{data.units}</span><div><b>{data.now.text}</b><div className="hint">feels {data.now.feels}° · wind {data.now.wind} {data.units === "F" ? "mph" : "km/h"} · {data.place}</div></div></div>
    <div className="wx-days">{data.days.map(d => <div key={d.date} className="wx-day"><div className="small">{d.date === todayISO() ? "Today" : new Date(d.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "short" })}</div>
      <div><b>{d.high}°</b> <span className="muted">{d.low}°</span></div><div className="hint">{d.text}{d.rain ? ` · ${d.rain}%` : ""}</div></div>)}</div></>}
  </div>;
}

function useEvents() { return useFetch<Ev[]>("/api/daily/events?days=7", 10 * 60000); }
/** Bills still to pay: Firefly III's, or Coinpile's list when there's no Firefly. */
type BillDue = { date: string; name: string; amount: number; person: string; paidBy: string };
function useBills() { return useFetch<BillDue[]>("/api/daily/bills?days=7", 10 * 60000); }
/** CDs and bonds maturing, from Coinpile's shared alert list. */
type Maturity = { date: string; title: string; detail: string; kind: string; severity: string };
function useMaturities() { return useFetch<Maturity[]>("/api/daily/maturities?days=7", 10 * 60000); }
const MaturityRow = ({ m }: { m: Maturity }) => <li><span className="date">{m.kind === "matured_idle" ? "matured" : "matures"}</span><div className="grow">{m.title.replace(/ \(\d{4}-\d{2}-\d{2}\)$/, "")}{m.detail && <div className="hint">{m.detail}</div>}</div>{m.severity === "warning" && <span className="chip warn">{m.kind === "matured_idle" ? "idle" : "soon"}</span>}</li>;
const usd = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD" });
const BillRow = ({ b }: { b: BillDue }) => <li><span className="date">bill</span><div className="grow">{b.name}<div className="hint">{b.person}{b.paidBy !== "me" ? ` · paid by ${b.paidBy}` : ""}</div></div><span className="num">{usd(b.amount)}</span></li>;
function Today() {
  const { data, error } = useEvents(), day = todayISO(), tasks = useColl("tasks"), chores = useColl("chores"), bills = (useBills().data || []).filter(b => b.date === day), mats = (useMaturities().data || []).filter(m => m.date === day);
  const ev = (data || []).filter(e => e.day === day), due = sortTasks(tasks.filter(t => !t.done && t.due && t.due <= day));
  const ch = chores.map(c => ({ c, s: choreState(c) })).filter(x => x.s.cls === "over" || x.s.left <= 0 || !x.c.lastDone);
  return <>
    {error && <div className="err-inline small">Calendar: {error}</div>}
    {ev.length ? <ul className="list">{ev.map((e, k) => <li key={k}><span className="date">{time(e)}</span><div className="grow">{e.title}{e.location && <div className="hint">{e.location}</div>}</div>{e.calendar && <span className="tag">{e.calendar}</span>}</li>)}</ul>
      : data && <div className="empty small">Nothing on the calendar today.</div>}
    {mats.length > 0 && <><h4 className="group-name">Maturing today</h4><ul className="list">{mats.map((m, k) => <MaturityRow key={k} m={m} />)}</ul></>}
    {bills.length > 0 && <><h4 className="group-name">Bills due today</h4><ul className="list">{bills.map((b, k) => <BillRow key={k} b={b} />)}</ul></>}
    {due.length > 0 && <><h4 className="group-name">Due today or overdue</h4><TaskRows tasks={due} showList /></>}
    {ch.length > 0 && <><h4 className="group-name">Chores due</h4><ul className="list">{ch.map(({ c, s }) => <li key={c.id}><div className="grow">{c.name}</div><span className={"chip " + (s.cls === "over" ? "bad" : "warn")}>{!c.lastDone ? "never done" : s.left < 0 ? `${-s.left} day${s.left === -1 ? "" : "s"} late` : "due today"}</span></li>)}</ul></>}
  </>;
}
function Week() {
  const { data } = useEvents(), day = todayISO(), bills = (useBills().data || []).filter(b => b.date > day), mats = (useMaturities().data || []).filter(m => m.date > day);
  const rest = (data || []).filter(e => e.day > day), days = [...new Set([...rest.map(e => e.day), ...bills.map(b => b.date), ...mats.map(m => m.date)])].sort();
  if (!data) return <div className="hint">Reading the calendar…</div>;
  if (!days.length) return <div className="empty">Nothing else this week.</div>;
  return <>{days.map(d => <div key={d}><h4 className="group-name">{dayName(d)}</h4><ul className="list">{rest.filter(e => e.day === d).map((e, k) =>
    <li key={k}><span className="date">{time(e)}</span><div className="grow">{e.title}</div>{e.calendar && <span className="tag">{e.calendar}</span>}</li>)}
    {bills.filter(b => b.date === d).map((b, k) => <BillRow key={"b" + k} b={b} />)}{mats.filter(m => m.date === d).map((m, k) => <MaturityRow key={"m" + k} m={m} />)}</ul></div>)}</>;
}
function Tasks() {
  const tasks = sortTasks(useColl("tasks").filter(t => !t.done)).slice(0, 10);
  return tasks.length ? <><TaskRows tasks={tasks} showList /><div className="row"><a className="btn" href="#todo">All tasks</a></div></> : <div className="empty">No open tasks.</div>;
}
type FeedInfo = { url: string; title: string; site: string; count: number; error: string };
/** Your favourite feed by default; pick another or all of them. Every headline links to its story, and to its coverage (Ground News by default). */
function NewsList() {
  const { d, save } = useDaily(), cov = useCoverage();
  const info = useFetch<{ favourite: string; feeds: FeedInfo[] }>("/api/daily/feeds", 15 * 60000), feeds = info.data?.feeds || [];
  const fav = feeds.some(f => f.url === info.data?.favourite) ? info.data!.favourite : "";
  const [sel, setSel] = useState<string | null>(null), [edit, setEdit] = useState(false);
  const cur = sel && (sel === "all" || feeds.some(f => f.url === sel)) ? sel : fav || "all", one = feeds.find(f => f.url === cur);
  const { data, error } = useFetch<News[]>(info.data ? `/api/daily/news${cur === "all" ? "" : `?feed=${encodeURIComponent(cur)}`}` : null, 15 * 60000);
  const list: string[] = d.feeds || feeds.map(f => f.url);
  return <div className="nf">
    <div className="row nf-bar">
      <select value={cur} onChange={e => setSel(e.target.value)} aria-label="Feed"><option value="all">All feeds</option>{feeds.map(f => <option key={f.url} value={f.url}>{f.url === fav ? "★ " : ""}{f.title}</option>)}</select>
      {one && one.url !== fav && <button className="btn" onClick={() => save({ favFeed: one.url })} title="Show this feed first">★ Favourite</button>}
      {one && <a className="btn" href={one.site} target="_blank" rel="noopener noreferrer">Visit {one.title}</a>}
      <button className="btn" onClick={() => setEdit(!edit)} aria-expanded={edit}>{edit ? "Done" : "Feeds…"}</button>
    </div>
    {edit && <div className="nf-manage">
      <ul className="list">{feeds.map(f => <li key={f.url}><div className="grow"><a href={f.site} target="_blank" rel="noopener noreferrer">{f.title}</a><div className="hint mono">{f.url}{f.error ? ` · ${f.error}` : ` · ${f.count} items`}</div></div>
        <button className="btn" onClick={() => { save({ feeds: list.filter(u => u !== f.url), ...(f.url === fav ? { favFeed: "" } : {}) }); if (cur === f.url) setSel("all"); }} aria-label={`Remove ${f.title}`}>Remove</button></li>)}</ul>
      <AddInline label="Add an RSS or Atom feed" placeholder="https://… (any RSS or Atom feed, e.g. weather alerts for your area)" onAdd={v => { if (/^https?:\/\//i.test(v) && !list.includes(v)) save({ feeds: [...list, v] }); }} />
    </div>}
    {error ? <div className="empty">{error}</div> : !data ? <div className="hint">Gathering the news…</div> : !data.length ? <div className="empty">Nothing in this feed right now.</div>
      : <ul className="list news">{data.slice(0, cur === "all" ? 20 : 30).map((n, k) => { const c = coverageUrl(cov, n.title); return <li key={k}><div className="grow"><a href={n.link} target="_blank" rel="noopener noreferrer">{n.title}</a>
        <div className="hint">{n.source}{n.published ? ` · ${ago(n.published)}` : ""}{c && <> · <a href={c} target="_blank" rel="noopener noreferrer">{cov.label}</a></>}</div></div></li>; })}</ul>}
  </div>;
}
/** Your watchlist: add and remove tickers here; click one for its news, rated for the stock. */
function Stocks() {
  const { d, save } = useDaily(), cov = useCoverage(), [open, setOpen] = useState(""), [edit, setEdit] = useState(false);
  const watch: string[] = d.watchlist || ["SPY", "QQQ", "DIA"];
  const { data, error, at } = useFetch<Q[]>(`/api/daily/quotes?w=${encodeURIComponent(watch.join(","))}`, 10 * 60000);
  const add = (v: string) => { const t = v.toUpperCase().replace(/\s+/g, ""); if (/^[A-Z^][A-Z0-9.^=-]{0,14}$/.test(t) && !watch.includes(t)) save({ watchlist: [...watch, t] }); };
  const rm = (t: string) => save({ watchlist: watch.filter(x => x !== t) });
  return <>
    {error ? <div className="empty">{error}</div> : !data ? <div className="hint">Checking the markets…</div> : !data.length ? <div className="empty">Add a ticker to watch.</div>
      : <table className="tbl stocks"><tbody>{data.map(q => <tr key={q.symbol}>
        <td><button className="linkish" onClick={() => setOpen(q.symbol)} title={`News about ${q.symbol}, rated`}><b>{q.symbol}</b></button>{!q.error && <div className="hint">{q.name}</div>}</td>
        {q.error ? <td colSpan={3} className="small err-inline">{q.error}</td> : <><td className="num">{money(q.price!)}</td>
          <td className={"num " + (q.change! >= 0 ? "up" : "down")}>{pct(q.changePct!)}</td><td><Spark data={(q.history || []).map(b => b.close)} /></td></>}
        {edit && <td><button className="btn" onClick={() => rm(q.symbol)} aria-label={`Stop watching ${q.symbol}`}>×</button></td>}</tr>)}</tbody></table>}
    <div className="row small"><span className="hint grow">Click a ticker for its news. Prices can be delayed{at ? `; updated ${ago(at)}` : ""}.</span><button className="btn" onClick={() => setEdit(!edit)} aria-expanded={edit}>{edit ? "Done" : "Edit"}</button></div>
    {edit && <AddInline label="Add a ticker" placeholder="Ticker, e.g. NVDA" onAdd={add} />}
    {open && <TickerNews symbol={open} coverage={cov} onClose={() => setOpen("")} />}
  </>;
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
    // Your apps can go on this page too (Edit layout → add). Firefly III, Coinpile and Omi start here.
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
    return { panels: [...own, ...apps], defaults: [...own.map(p => p.key), ...widgetKeys("firefly"), ...widgetKeys("coinpile"), ...widgetKeys("omi")] };
  },
};
