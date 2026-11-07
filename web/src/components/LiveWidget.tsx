import { useFetch } from "../lib/useFetch";
import { useColl } from "../lib/store";
import { ago, sortTasks } from "../lib/util";
import { TaskRows, fromOmi } from "./Common";

const usd = (n: number | null) => (n === null || n === undefined ? "—" : n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 }));

/** Goblin-Bank: only what each person shares (no transactions). */
function GoblinBank({ data }: { data: any }) {
  const bits = (p: any) => [
    p.bills?.next7d != null && `bills ${usd(p.bills.next7d)} this week${p.bills.next30d != null ? `, ${usd(p.bills.next30d)} in 30 days` : ""}`,
    p.bills?.next && `next: ${p.bills.next.name} ${String(p.bills.next.date).slice(5)}`,
    p.savings?.total != null && `savings ${usd(p.savings.total)}${p.savings.free != null ? `, ${usd(p.savings.free)} free` : ""}`,
  ].filter(Boolean) as string[];
  return <>
    {data.netWorth !== null && <div className="row"><span className="wx-t">{usd(data.netWorth)}</span><span className="hint">net worth, shared</span></div>}
    <table className="tbl small"><tbody>{data.people.map((p: any) => <tr key={p.name}><td><b>{p.name}</b></td>
      {p.error ? <td colSpan={3} className="err-inline">{p.error}</td> : <>
        <td className="num">{p.netWorth !== null ? usd(p.netWorth) : <span className="muted">not shared</span>}</td>
        <td className="num">{p.subscriptionsMonthly !== null ? `${usd(p.subscriptionsMonthly)}/mo` : ""}</td>
        <td className="num">{p.robinhoodAgent?.equity != null ? <span title={`agentic account, as of ${p.robinhoodAgent.asOf}`}>RH agent {usd(p.robinhoodAgent.equity)}</span> : p.robinhoodMain?.equity != null ? <span title={`${p.robinhoodMain.source}, as of ${p.robinhoodMain.asOf}`}>RH {usd(p.robinhoodMain.equity)}</span> : ""}</td></>}
    </tr>)}</tbody></table>
    {data.people.filter((p: any) => !p.error && (bits(p).length || p.alerts?.total || p.goals?.length)).map((p: any) => <div key={p.name} className="small" style={{ marginTop: 6 }}>
      <b>{p.name}</b> <span className="muted">{bits(p).join(" · ")}</span>
      {p.alerts?.total > 0 && <span className={p.alerts.critical ? "err-inline" : "hint"}> · {p.alerts.total} alert{p.alerts.total === 1 ? "" : "s"}{p.alerts.critical ? `, ${p.alerts.critical} critical` : ""}</span>}
      {p.goals?.length > 0 && <div className="muted">{p.goals.map((g: any) => `${g.name} ${g.pct != null ? Math.round(g.pct * 100) + "%" : ""}`).join(" · ")}</div>}
    </div>)}
    {data.alerts?.filter((a: any) => a.severity !== "info").slice(0, 3).map((a: any, k: number) => <div key={k} className="small"><span className={"chip " + (a.severity === "critical" ? "bad" : "warn")}>{a.severity}</span> {a.title} <span className="hint">{a.person}</span></div>)}
    {data.bills?.length > 0 && <div className="small">Next bills: {data.bills.slice(0, 3).map((b: any) => `${b.name} ${b.date.slice(5)} ${usd(b.amount)}`).join(" · ")}</div>}
    <div className="hint">Read only, from Goblin-Bank's shared summary · {ago(data.at)}</div>
  </>;
}
/** Omi: yesterday's recap and recent conversations from Omi; its action items from CalDAV. */
function Omi({ data }: { data: any }) {
  const tasks = sortTasks(useColl("tasks").filter(t => fromOmi(t) && !t.done)).slice(0, 6), d = data.day;
  return <>
    {d ? <div><b>{d.emoji} {d.headline || "Your day"}</b> <span className="hint">{d.date}</span><div className="small">{d.overview}</div>
      {d.decisions?.length > 0 && <div className="small"><span className="muted">Decided:</span> {d.decisions.join(" · ")}</div>}
      {d.questions?.length > 0 && <div className="small"><span className="muted">Open:</span> {d.questions.join(" · ")}</div>}</div>
      : <div className="empty small">No daily summary yet.</div>}
    <h4 className="group-name">Action items <span className="hint">(from CalDAV, read only)</span></h4>
    {tasks.length ? <TaskRows tasks={tasks} /> : <div className="empty small">None open.</div>}
    {data.conversations?.length > 0 && <><h4 className="group-name">Recent conversations</h4><ul className="list small">{data.conversations.map((c: any) =>
      <li key={c.id}><div className="grow"><b>{c.emoji} {c.title}</b><div className="hint">{c.overview}</div></div><span className="hint">{c.at ? ago(c.at) : ""}</span></li>)}</ul></>}
  </>;
}

/** Live data for an app with `widget:` in the apps YAML (Plex, SABnzbd),
 *  fetched through the server so the app's key never reaches the browser. */
export function LiveWidget({ name }: { name: string }) {
  const { data, error } = useFetch<any>(`/api/widgets/${encodeURIComponent(name)}`, 15000);
  if (error) return <div className="err-inline small">{error}</div>;
  if (!data) return <div className="hint">Loading…</div>;
  const bar = (pct: number) => <div className="bar"><span style={{ width: Math.min(100, pct) + "%" }} /></div>;
  if (data.type === "plex") return data.sessions.length ? <div>{data.sessions.map((s: any, i: number) => <div key={i} className="lv">
      <div className="row" style={{ justifyContent: "space-between" }}><b className="grow" style={{ overflowWrap: "anywhere" }}>{s.title}</b><span className="hint">{s.user}{s.player ? " · " + s.player : ""}{s.state === "paused" ? " · paused" : ""}{s.transcode ? " · transcoding" : ""}</span></div>{bar(s.progress)}</div>)}</div>
    : <div className="empty small">Nothing playing.</div>;
  if (data.type === "sabnzbd") return <>
    <div className="row small mono" style={{ justifyContent: "space-between" }}><span>{data.paused ? "paused" : data.speed || "idle"}</span><span>{data.timeleft ? `${data.timeleft} left` : ""}{data.sizeLeft ? ` · ${data.sizeLeft}` : ""}</span></div>
    {data.queue.length ? data.queue.map((q: any, i: number) => <div key={i} className="lv"><div className="row" style={{ justifyContent: "space-between" }}><span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.name}</span><span className="mono small">{q.pct}%</span></div>{bar(q.pct)}</div>)
      : <div className="empty small">Queue empty.</div>}</>;
  if (data.type === "goblinbank") return <GoblinBank data={data} />;
  if (data.type === "omi") return <Omi data={data} />;
  return null;
}
