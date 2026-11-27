import { useFetch } from "../lib/useFetch";
import { useColl } from "../lib/store";
import { ago, sortTasks } from "../lib/util";
import { TaskRows, fromOmi } from "./Common";
import { BudgetBars, MonthBoxes, money } from "../pages/Finances";
import { AlertList, Forecast, GoalBars } from "../pages/Coinpile";

/** Firefly III: the month, the next unpaid bills and the budgets closest to their limit. */
function Firefly({ data }: { data: any }) {
  const today = new Intl.DateTimeFormat("en-CA").format(new Date()), due = (data.bills || []).filter((b: any) => !b.paid).slice(0, 4);
  return <>
    <MonthBoxes s={data.summary} />
    {due.length > 0 && <div className="small" style={{ marginTop: 6 }}><span className="muted">Next bills:</span> {due.map((b: any) => `${b.name} ${b.date === today ? "today" : b.date.slice(5)} ${money(b.amount, b.currency)}`).join(" · ")}</div>}
    {data.budgets?.some((b: any) => b.pct >= 80) && <div style={{ marginTop: 6 }}><BudgetBars budgets={data.budgets.filter((b: any) => b.pct >= 80)} limit={3} /></div>}
    <div className="hint">Read only, from Firefly III · {ago(data.at)}</div>
  </>;
}
/** Coinpile: what Firefly can't hold: savings, the forecast, alerts, goals, maturities. */
function Coinpile({ data: d }: { data: any }) {
  const alerts = (d.alertList || []).filter((a: any) => a.severity !== "info");
  return <>
    <div className="small">{d.savings && <div>Savings {money(d.savings.total)}: <b>{money(d.savings.free)}</b> free, {money(d.savings.earmarked)} set aside</div>}
      {d.spending && <div>Spending: <Forecast s={d.spending} /></div>}
      {(d.robinhoodAgent || d.robinhoodMain) && <div>Robinhood {money((d.robinhoodMain?.value ?? 0) + (d.robinhoodAgent?.value ?? 0))}</div>}
      {(() => { const m = (d.maturities || []).find((x: any) => x.kind === "maturing"); return m ? <div>Next to mature: {m.title}</div> : null; })()}
      {d.budgets && d.budgets.limit != null && <div>Budgets: <b>{money(d.budgets.left)}</b> left of {money(d.budgets.limit)}{(() => { const over = d.budgets.items.filter((b: any) => b.limit && b.spent / b.limit >= 0.9); return over.length ? <span className="muted"> · near limit: {over.map((b: any) => b.name).join(", ")}</span> : null; })()}</div>}
      {d.paycheck && <div>Next paycheck {d.paycheck.date}: {money(d.paycheck.amount)} → {money(d.paycheck.bills)} bills{d.paycheck.piggyBanks ? `, ${money(d.paycheck.piggyBanks)} piggy banks` : ""}, <b>{money(d.paycheck.left)}</b> left</div>}
      {d.week && <div>This week: {money(d.week.moneyOut)} out{d.week.outChange != null ? <span className="muted"> ({d.week.outChange >= 0 ? "+" : ""}{money(d.week.outChange)} vs last week)</span> : null}</div>}</div>
    {alerts.length > 0 ? <div style={{ marginTop: 6 }}><AlertList alerts={alerts} limit={3} /></div> : d.alerts && d.alerts.total > 0 ? <div className="small">{d.alerts.total} alerts, {d.alerts.critical} critical</div> : null}
    {d.goals?.length > 0 && <div style={{ marginTop: 6 }}><GoalBars goals={d.goals} limit={3} /></div>}
    <div className="hint">Read only, from Coinpile · {ago(d.at)}</div>
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

/** Immich: "on this day" photos from earlier years, and the library's size. */
function Immich({ name, data }: { name: string; data: any }) {
  const gb = (b: number) => `${(b / 1e9).toFixed(b >= 1e11 ? 0 : 1)} GB`;
  return <>
    {data.memories?.length ? data.memories.slice(0, 3).map((m: any) => <div key={m.id} style={{ marginBottom: 6 }}>
      <div className="small"><b>{m.yearsAgo === 1 ? "1 year ago" : m.yearsAgo ? `${m.yearsAgo} years ago` : "On this day"}</b> <span className="hint">{m.year || ""} · {m.count} {m.count === 1 ? "photo" : "photos"}</span></div>
      <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>{m.photos.map((p: any) =>
        <a key={p.id} href={`${data.link}/photos/${p.id}`} target="_blank" rel="noreferrer" aria-label={`Open ${p.video ? "video" : "photo"} from ${m.year || "this day"} in Immich`}>
          <img src={`/api/widgets/${encodeURIComponent(name)}/photo/${p.id}`} alt={`${p.video ? "Video" : "Photo"} from ${m.year || "this day"}`} loading="lazy" style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 6 }} /></a>)}</div>
    </div>) : <div className="empty small">No memories for today.</div>}
    {data.library && <div className="hint">{data.library.photos.toLocaleString()} photos · {data.library.videos.toLocaleString()} videos · {gb(data.library.bytes)}</div>}
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
  if (data.type === "omi") return <Omi data={data} />;
  if (data.type === "firefly") return <Firefly data={data} />;
  if (data.type === "coinpile") return <Coinpile data={data} />;
  if (data.type === "immich") return <Immich name={name} data={data} />;
  return null;
}
