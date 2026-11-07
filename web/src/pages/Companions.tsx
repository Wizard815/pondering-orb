import { useState } from "react";
import type { PageDef } from "./types";
import { useColl } from "../lib/store";
import { useFetch } from "../lib/useFetch";
import { ago, fmtDate, sortTasks, todayISO } from "../lib/util";
import { TaskRows, fromOmi } from "../components/Common";
import { AppTiles } from "../components/AppPanels";
import type { App } from "../lib/apps";

/** Full pages for your own apps, turned on with `page: true` (or a tab name)
 *  in the app's widget in the apps YAML. Everything here is read only. */
const usd = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 }));
const SEV_CLS: Record<string, string> = { critical: "bad", warning: "warn", info: "" };
const notShared = <span className="muted small">not shared</span>;

// ---------------- Goblin-Bank ----------------
function useMoney(app: App) { return useFetch<any>(`/api/apps/${encodeURIComponent(app.name)}/money`, 5 * 60000); }
function People({ app }: { app: App }) {
  const { data, error } = useMoney(app);
  if (error) return <div className="err-inline">{error}</div>;
  if (!data) return <div className="hint">Counting the hoard…</div>;
  return <>
    {data.netWorth !== null && <div className="row"><span className="wx-t">{usd(data.netWorth)}</span><span className="hint">shared net worth, everyone together</span></div>}
    <div className="money-people">{data.people.map((p: any) => <div key={p.name} className="money-person">
      <div className="row"><b>{p.name}</b>{p.error && <span className="chip bad">{p.error}</span>}{p.alerts?.critical > 0 && <span className="chip bad">{p.alerts.critical} critical</span>}{p.alerts?.warning > 0 && <span className="chip warn">{p.alerts.warning} warning</span>}</div>
      {!p.error && <table className="tbl small"><tbody>
        <tr><td>Net worth</td><td className="num">{p.netWorth !== null ? usd(p.netWorth) : notShared}</td></tr>
        <tr><td>Subscriptions</td><td className="num">{p.subscriptionsMonthly !== null ? `${usd(p.subscriptionsMonthly)}/mo` : notShared}</td></tr>
        <tr><td>Bills, next 7 / 30 days</td><td className="num">{p.bills ? `${usd(p.bills.next7d)} / ${usd(p.bills.next30d)}` : notShared}</td></tr>
        {p.bills?.next && <tr><td>Next bill</td><td className="num">{p.bills.next.name} · {fmtDate(p.bills.next.date)} · {usd(p.bills.next.amount)}</td></tr>}
        <tr><td>Savings (free / set aside)</td><td className="num">{p.savings ? `${usd(p.savings.total)} (${usd(p.savings.free)} / ${usd(p.savings.earmarked)})` : notShared}</td></tr>
        {p.robinhoodMain && <tr><td>Robinhood</td><td className="num" title={`${p.robinhoodMain.source}, as of ${p.robinhoodMain.asOf}`}>{usd(p.robinhoodMain.equity)}</td></tr>}
        {p.robinhoodAgent && <tr><td>Robinhood agentic account</td><td className="num" title={`as of ${p.robinhoodAgent.asOf}`}>{usd(p.robinhoodAgent.equity)}</td></tr>}
      </tbody></table>}
    </div>)}</div>
    <div className="hint">Read only. Each person picks what Orb sees in Goblin-Bank → Settings → Sharing. Updated {ago(data.at)}.</div>
  </>;
}
function Bills({ app, days }: { app: App; days: number }) {
  const { data } = useMoney(app), today = todayISO();
  if (!data) return <div className="hint">…</div>;
  const end = new Date(Date.now() + days * 864e5).toISOString().slice(0, 10), list = (data.bills || []).filter((b: any) => b.date >= today && b.date <= end);
  if (!data.people.some((p: any) => p.billList)) return <div className="empty">Nobody shares a bill list yet (Goblin-Bank → Settings → Sharing → Bill list).</div>;
  if (!list.length) return <div className="empty">No bills in the next {days} days.</div>;
  const mine = list.filter((b: any) => b.paidBy === "me");
  return <><ul className="list">{list.map((b: any, k: number) => <li key={k}><span className="date">{b.date === today ? "Today" : fmtDate(b.date)}</span>
    <div className="grow">{b.name}<div className="hint">{b.person}{b.paidBy !== "me" ? ` · paid by ${b.paidBy}` : ""} · {b.category}</div></div><span className="num">{usd(b.amount)}</span></li>)}</ul>
    <div className="hint">{mine.length} to pay, {usd(mine.reduce((a: number, b: any) => a + b.amount, 0))} in total.</div></>;
}
function Alerts({ app }: { app: App }) {
  const { data } = useMoney(app);
  if (!data) return <div className="hint">…</div>;
  if (!data.people.some((p: any) => p.alertList)) return <div className="empty">Nobody shares an alert list yet (Goblin-Bank → Settings → Sharing → Alert list).</div>;
  if (!data.alerts.length) return <div className="empty">All quiet in the vaults.</div>;
  return <ul className="list">{data.alerts.map((a: any, k: number) => <li key={k}><span className={"chip " + SEV_CLS[a.severity]}>{a.severity}</span>
    <div className="grow">{a.title}{a.detail && <div className="hint">{a.detail}</div>}</div><span className="tag">{a.person}</span></li>)}</ul>;
}
function Goals({ app }: { app: App }) {
  const { data } = useMoney(app);
  const goals = (data?.people || []).flatMap((p: any) => (p.goals || []).map((g: any) => ({ ...g, person: p.name })));
  if (!data) return <div className="hint">…</div>;
  if (!goals.length) return <div className="empty">No shared goals.</div>;
  return <>{goals.map((g: any, k: number) => <div key={k} className="meter"><div className="lab"><span>{g.name} <span className="hint">{g.person}</span></span><b>{usd(g.allocated)} of {usd(g.target)}{g.pct != null ? ` · ${Math.round(g.pct * 100)}%` : ""}</b></div>
    <div className="bar"><span style={{ width: Math.min(100, Math.round((g.pct ?? 0) * 100)) + "%" }} /></div></div>)}</>;
}
export function moneyPage(app: App, label: string): PageDef {
  return { id: "money", label, title: "The Hoard", flavor: `${app.name}: what each of you shares, read only.`,
    usePanels: () => ({ panels: [
      { key: "people", title: "Everyone", node: <People app={app} />, w: 7, h: 12 },
      { key: "alerts", title: "Alerts", node: <Alerts app={app} />, w: 5, h: 8 },
      { key: "bills", title: "Bills, next 30 days", node: <Bills app={app} days={30} />, w: 5, h: 12 },
      { key: "goals", title: "Goals", node: <Goals app={app} />, w: 7, h: 6 },
      { key: "open", title: "Open Goblin-Bank", node: <AppTiles apps={[app]} />, w: 4, h: 3 },
    ] }) };
}

// ---------------- Omi ----------------
function Days({ app }: { app: App }) {
  const [i, setI] = useState(0), { data, error } = useFetch<any[]>(`/api/apps/${encodeURIComponent(app.name)}/omi/days?limit=30`, 10 * 60000);
  if (error) return <div className="err-inline">{error}</div>;
  if (!data) return <div className="hint">Listening back…</div>;
  if (!data.length) return <div className="empty">No daily summaries yet.</div>;
  const d = data[Math.min(i, data.length - 1)], st = d.stats || {};
  return <>
    <div className="row"><button className="btn" disabled={i >= data.length - 1} onClick={() => setI(i + 1)} aria-label="Earlier day">‹</button>
      <select value={i} onChange={e => setI(Number(e.target.value))} aria-label="Day">{data.map((x, k) => <option key={k} value={k}>{x.date} {x.emoji} {x.headline.slice(0, 40)}</option>)}</select>
      <button className="btn" disabled={i <= 0} onClick={() => setI(i - 1)} aria-label="Later day">›</button></div>
    <div className="omi-head"><b>{d.emoji} {d.headline || "Your day"}</b></div><div className="hint">{d.date}{st.total_conversations ? ` · ${st.total_conversations} conversations` : ""}{st.total_duration_minutes ? ` · ${st.total_duration_minutes} min` : ""}</div>
    <p>{d.overview}</p>
    {d.highlights?.length > 0 && <><h4 className="group-name">Highlights</h4><ul className="list">{d.highlights.map((h: any, k: number) => <li key={k}><div className="grow"><b>{h.emoji} {h.topic}</b><div className="small">{h.summary}</div></div></li>)}</ul></>}
    {d.decisions?.length > 0 && <><h4 className="group-name">Decided</h4><ul className="small">{d.decisions.map((x: string, k: number) => <li key={k}>{x}</li>)}</ul></>}
    {d.questions?.length > 0 && <><h4 className="group-name">Still open</h4><ul className="small">{d.questions.map((x: string, k: number) => <li key={k}>{x}</li>)}</ul></>}
    {d.nuggets?.length > 0 && <><h4 className="group-name">Learned</h4><ul className="small">{d.nuggets.map((x: string, k: number) => <li key={k}>{x}</li>)}</ul></>}
  </>;
}
function Conversations({ app }: { app: App }) {
  const { data, error } = useFetch<any[]>(`/api/apps/${encodeURIComponent(app.name)}/omi/conversations?limit=25`, 5 * 60000);
  if (error) return <div className="err-inline">{error}</div>;
  if (!data) return <div className="hint">…</div>;
  return data.length ? <ul className="list">{data.map(c => <li key={c.id}><div className="grow"><b>{c.emoji} {c.title}</b><div className="hint">{c.overview}</div></div><span className="hint">{c.at ? ago(c.at) : ""}</span></li>)}</ul>
    : <div className="empty">No conversations yet.</div>;
}
function Memories({ app }: { app: App }) {
  const [q, setQ] = useState(""), [asked, setAsked] = useState("");
  const { data, error, loading } = useFetch<any[]>(asked ? `/api/apps/${encodeURIComponent(app.name)}/omi/memories?q=${encodeURIComponent(asked)}` : null, 0);
  return <>
    <form className="row" onSubmit={e => { e.preventDefault(); setAsked(q.trim()); }}><input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="What did I say about…" aria-label="Search Omi's memories" style={{ flex: 1 }} /><button className="btn primary" type="submit">Search</button></form>
    {error && <div className="err-inline small">{error}</div>}
    {loading && <div className="hint">Remembering…</div>}
    {data && (data.length ? <ul className="list">{data.map((m, k) => <li key={k}><div className="grow">{m.content}</div>{m.category && <span className="tag">{m.category}</span>}</li>)}</ul> : <div className="empty">Nothing found.</div>)}
  </>;
}
function OmiTasks() {
  const all = useColl("tasks").filter(fromOmi), open = sortTasks(all.filter(t => !t.done)), done = all.filter(t => t.done).slice(0, 10);
  return <>{open.length ? <TaskRows tasks={open} showList /> : <div className="empty">No open action items.</div>}
    {done.length > 0 && <details><summary className="small">Done recently ({done.length})</summary><TaskRows tasks={done} /></details>}
    <div className="hint">Read from CalDAV, where Omi writes them. Change them in Omi.</div></>;
}
export function omiPage(app: App, label: string): PageDef {
  return { id: "omi", label, title: "The Listening Stone", flavor: `${app.name}: your days, conversations and what Omi remembers, read only.`,
    usePanels: () => ({ panels: [
      { key: "day", title: "Day recap", node: <Days app={app} />, w: 7, h: 16 },
      { key: "tasks", title: "Action items", node: <OmiTasks />, w: 5, h: 8 },
      { key: "memories", title: "Search memories", node: <Memories app={app} />, w: 5, h: 8 },
      { key: "conversations", title: "Conversations", node: <Conversations app={app} />, w: 12, h: 10 },
    ] }) };
}
