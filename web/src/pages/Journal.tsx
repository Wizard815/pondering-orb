import { useCallback, useEffect, useRef, useState } from "react";
import type { PageDef } from "./types";
import { api, ApiError } from "../lib/api";
import { useUi } from "../lib/ui";
import { useFetch } from "../lib/useFetch";
import { Markdown } from "../lib/markdown";
import { ago, todayISO } from "../lib/util";

/** The Journal: one page per day. Orb's log of the day (money, what got done,
 *  commits, agents, Omi, alerts) and your typed notes. Days load one at a time. */

type Doc = { id?: string; version?: number; date: string; text: string; auto?: any };
const shift = (iso: string, n: number) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const longDay = (iso: string) => new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const usd = (n: number, cur = "") => n.toLocaleString(undefined, { style: "currency", currency: cur || "USD" });
const newId = (day: string) => `${day}-${Math.random().toString(36).slice(2, 10)}`;

/** Journal records by day: loaded one day at a time, saved in small pieces.
 *  Every save names its day, so a save that finishes after you moved to
 *  another day still lands on (and only changes) the day it was made on. */
type Patch = Partial<Doc> | ((cur: Doc) => Partial<Doc>);
function useJournal(day: string) {
  const ui = useUi(), docs = useRef(new Map<string, Doc>()), seq = useRef(new Map<string, number>()), shown = useRef(day);
  const [, bump] = useState(0); shown.current = day;
  const set = (d: string, v: Doc) => { docs.current.set(d, v); if (d === shown.current) bump(x => x + 1); };
  useEffect(() => { let live = true;
    if (docs.current.has(day)) return;
    api<Doc>("GET", `/api/c/journal/${day}`).catch(e => { if (e instanceof ApiError && e.status === 404) return { date: day, text: "" }; throw e; })
      .then(d => { if (live && !docs.current.has(day)) set(day, { ...d, text: d.text || "" }); }, ui.error);
    return () => { live = false; }; }, [day]);
  const save = useCallback(async (forDay: string, p: Patch) => {
    const cur = docs.current.get(forDay) || { date: forDay, text: "" }, part = typeof p === "function" ? p(cur) : p;
    set(forDay, { ...cur, ...part });
    const n = (seq.current.get(forDay) || 0) + 1; seq.current.set(forDay, n);
    // PATCH changes only what was sent; a day with no record yet is created.
    const url = `/api/c/journal/${forDay}`;
    const d = await api<Doc>("PATCH", url, part).catch(e => { if (e instanceof ApiError && e.status === 404) return api<Doc>("PUT", url, { date: forDay, text: "", ...part }); throw e; });
    // Only the latest save's answer counts (an older one may arrive last).
    if (seq.current.get(forDay) === n) set(forDay, { ...(docs.current.get(forDay) as Doc), version: d.version, id: d.id });
  }, []);
  return { doc: docs.current.get(day) || null, save };
}

// ---------------- the day's log ----------------
function Section({ title, n, children }: { title: string; n?: number; children: React.ReactNode }) {
  return <section className="jl-sec"><h4 className="group-name">{title}{n ? <span className="hint"> · {n}</span> : null}</h4>{children}</section>;
}
function DayLog({ day, log }: { day: string; log: ReturnType<typeof useFetch<any>> }) {
  const a = log.data?.day === day ? log.data : null;
  if (log.error && !a) return <div className="empty">{log.error}</div>;
  if (!a) return <div className="hint">Gathering the day…</div>;
  const empty = !a.events.length && !a.tasksDone.length && !a.choresDone.length && !a.logs.length && !a.commits.length && !a.requests.length && !a.agents.length && !a.omi && !a.omiConversations.length && !a.picks.length && !a.alerts.length;
  return <div className="jl">
    <div className="row small"><span className="hint">{a.final ? `Saved when the day ended (${ago(a.at)}).` : `As of ${ago(a.at) || "just now"}.`}</span>
      <button className="btn" onClick={() => api("GET", `/api/journal/${day}/auto?refresh=1`).then(() => log.reload())}>Refresh</button></div>
    {empty && <div className="empty">Nothing recorded for this day yet.</div>}
    {a.alerts.length > 0 && <Section title="Alerts" n={a.alerts.length}><ul className="list">{a.alerts.map((x: any, k: number) => <li key={k}><span className={"chip " + (x.severity === "critical" ? "bad" : "warn")}>{x.source}</span><div className="grow">{x.title}{x.detail && <div className="hint">{x.detail}</div>}</div></li>)}</ul></Section>}
    {a.events.length > 0 && <Section title="Calendar" n={a.events.length}><ul className="list">{a.events.map((e: any, k: number) => <li key={k}><span className="date">{e.time}</span><div className="grow">{e.title}</div>{e.calendar && <span className="tag">{e.calendar}</span>}</li>)}</ul></Section>}
    {(a.tasksDone.length > 0 || a.choresDone.length > 0) && <Section title="Done" n={a.tasksDone.length + a.choresDone.length}><ul className="list">
      {a.tasksDone.map((t: any, k: number) => <li key={"t" + k}><span className="chip ok">done</span><div className="grow">{t.title}<div className="hint">{t.list}{t.by && t.by !== "you" ? ` · by ${t.by}` : ""}</div></div></li>)}
      {a.choresDone.map((c: any, k: number) => <li key={"c" + k}><span className="chip ok">chore</span><div className="grow">{c.name}</div></li>)}</ul></Section>}
    {a.logs.length > 0 && <Section title="Log" n={a.logs.length}><ul className="list">{a.logs.map((l: any, k: number) => <li key={k}><span className="date">{l.time}</span><div className="grow"><b>{l.project}</b> {l.text}{l.by && <span className="hint"> · {l.by}</span>}</div></li>)}</ul></Section>}
    {(a.commits.length > 0 || a.requests.length > 0) && <Section title="Code (UpstreamManager)" n={a.commits.length}><ul className="list">
      {a.commits.map((c: any, k: number) => <li key={"c" + k}><span className="date">{c.time}</span><div className="grow">{c.subject}<div className="hint mono">{c.repo} · {c.sha}</div></div></li>)}
      {a.requests.map((r: any, k: number) => <li key={"r" + k}><span className="chip">{r.what}</span><div className="grow">{r.repo}: {r.type} request{r.what === "decided" ? `, ${r.status}` : ""}{r.comment && <div className="hint">{r.comment}</div>}</div></li>)}</ul></Section>}
    {a.agents.length > 0 && <Section title="Agents (Hermes Studio)" n={a.agents.length}><ul className="list">{a.agents.map((g: any, k: number) => <li key={k}><span className="date">{g.time}</span><div className="grow">
      <b>{g.title}</b> <span className="tag">{g.agent}</span> <span className={"chip " + (g.status === "done" ? "ok" : g.status === "needs_you" ? "warn" : "")}>{String(g.status).replace(/_/g, " ")}</span>
      {(g.task || g.project) && <div className="hint">{[g.project, g.task].filter(Boolean).join(" · ")}</div>}{g.last && <div className="small jl-quote">{g.last}</div>}</div></li>)}</ul></Section>}
    {(a.omi || a.omiConversations.length > 0 || a.omiTasks.length > 0) && <Section title="Omi">
      {a.omi && <div className="jl-omi"><b>{a.omi.headline}</b><p className="small">{a.omi.overview}</p>
        {a.omi.decisions.length > 0 && <div className="small"><b>Decided:</b> {a.omi.decisions.join("; ")}</div>}
        {a.omi.questions.length > 0 && <div className="small"><b>Still open:</b> {a.omi.questions.join("; ")}</div>}
        {a.omi.highlights.length > 0 && <ul className="small">{a.omi.highlights.map((h: any, k: number) => <li key={k}><b>{h.topic}</b> {h.summary}</li>)}</ul>}</div>}
      {a.omiConversations.length > 0 && <ul className="list">{a.omiConversations.map((c: any, k: number) => <li key={k}><span className="date">{c.time}</span><div className="grow">{c.title}{c.overview && <div className="hint">{c.overview}</div>}</div></li>)}</ul>}
      {a.omiTasks.length > 0 && <div className="small"><b>Omi's action items:</b> {a.omiTasks.map((t: any) => (t.done ? `✓ ${t.title}` : t.title)).join(" · ")}</div>}
    </Section>}
    {a.picks.length > 0 && <Section title="Stock picks" n={a.picks.length}><ul className="list">{a.picks.map((p: any, k: number) => <li key={k}><b>{p.symbol}</b><div className="grow small">model said {p.action || "?"}</div><span className="tag">{p.decision === "yes" ? `bought ${usd(p.amount)}` : "passed"}</span></li>)}</ul></Section>}
    {a.notes.length > 0 && <div className="hint">Couldn't read: {a.notes.join("; ")}</div>}
  </div>;
}

function Money({ day, log }: { day: string; log: ReturnType<typeof useFetch<any>> }) {
  const a = log.data?.day === day ? log.data : null, m = a?.money;
  if (!a) return <div className="hint">{log.error || "Counting…"}</div>;
  if (!m) return <div className="empty">Add Firefly III (or Coinpile with daily totals) in Settings → Apps to see each day's spending and income. {a.notes.find((n: string) => n.startsWith("Money"))}</div>;
  return <>
    <div className="jl-money">
      <div><div className="hint">Spent</div><div className="big down">{usd(m.spent, m.currency)}</div></div>
      <div><div className="hint">Income</div><div className="big up">{usd(m.income, m.currency)}</div></div>
      <div><div className="hint">Net</div><div className={"big " + (m.income - m.spent >= 0 ? "up" : "down")}>{usd(m.income - m.spent, m.currency)}</div></div>
    </div>
    {m.items.length > 0 ? <ul className="list">{m.items.map((t: any, k: number) => <li key={k}><div className="grow">{t.description}<div className="hint">{[t.category, t.account].filter(Boolean).join(" · ")}</div></div><span className={"num " + (t.amount < 0 ? "down" : "up")}>{usd(t.amount, m.currency)}</span></li>)}</ul>
      : <div className="empty small">No transactions{m.source === "coinpile" ? " listed (Coinpile shares totals only)" : ""}.</div>}
    <div className="hint">From {m.source === "firefly" ? "Firefly III" : "Coinpile"}, read only. Transfers between your own accounts don't count.</div>
  </>;
}

// ---------------- typed notes ----------------
function Notes({ day, j }: { day: string; j: ReturnType<typeof useJournal> }) {
  const ui = useUi(), [text, setText] = useState<string | null>(null), [preview, setPreview] = useState(false), t = useRef(0), [saved, setSaved] = useState(0);
  const pending = useRef<{ day: string; text: string } | null>(null);
  const flush = () => { clearTimeout(t.current); const p = pending.current; pending.current = null; if (p) j.save(p.day, { text: p.text }).then(() => setSaved(Date.now()), ui.error); };
  // Moving to another day (or leaving the page) saves what was typed, on the day it was typed on.
  useEffect(() => { setText(null); setPreview(false); return flush; }, [day]);
  if (!j.doc) return <div className="hint">Opening the day…</div>;
  const val = text ?? j.doc.text;
  const change = (v: string) => { setText(v); pending.current = { day, text: v }; clearTimeout(t.current); t.current = window.setTimeout(flush, 800); };
  return <div className="jn">
    <div className="row small"><button className={"btn" + (!preview ? " on" : "")} onClick={() => setPreview(false)}>Write</button><button className={"btn" + (preview ? " on" : "")} onClick={() => setPreview(true)}>Read</button>
      <span className="hint">{saved ? `Saved ${ago(saved)}` : "Saves as you type. Markdown works."}</span></div>
    {preview ? (val.trim() ? <Markdown text={val} /> : <div className="empty">Nothing written yet.</div>)
      : <textarea className="jn-text" value={val} onChange={e => change(e.target.value)} placeholder={`What happened on ${longDay(day)}?`} aria-label="Your notes for the day" />}
  </div>;
}

// ---------------- the page ----------------
function DayPicker({ day, setDay }: { day: string; setDay: (d: string) => void }) {
  const t = todayISO();
  return <div className="row jd"><button className="btn" onClick={() => setDay(shift(day, -1))} aria-label="Day before">‹</button>
    <input type="date" value={day} max={t} onChange={e => e.target.value && setDay(e.target.value > t ? t : e.target.value)} aria-label="Day" />
    <button className="btn" onClick={() => setDay(shift(day, 1))} disabled={day >= t} aria-label="Day after">›</button>
    {day !== t && <button className="btn" onClick={() => setDay(t)}>Today</button>}</div>;
}

export const JournalPage: PageDef = {
  id: "journal", label: "Journal", title: "Day Book", flavor: "The day as Orb saw it, and what you wrote.",
  usePanels: () => {
    const [day, setDay] = useState(todayISO()), j = useJournal(day);
    const log = useFetch<any>(`/api/journal/${day}/auto`, day === todayISO() ? 5 * 60000 : 0);
    return {
      extra: <><span className="small jd-name">{longDay(day)}</span><DayPicker day={day} setDay={setDay} /></>,
      panels: [
        { key: "log", title: "The day's log", node: <DayLog day={day} log={log} />, w: 7, h: 22 },
        { key: "money", title: "Money", node: <Money day={day} log={log} />, w: 5, h: 9 },
        { key: "notes", title: "Notes", node: <Notes day={day} j={j} />, w: 5, h: 13 },
      ],
    };
  },
};
