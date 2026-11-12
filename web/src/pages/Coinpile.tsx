import type { PageDef } from "./types";
import { useFetch } from "../lib/useFetch";
import { ago, fmtDate, todayISO } from "../lib/util";
import { AppTiles } from "../components/AppPanels";
import type { App } from "../lib/apps";
import { money } from "./Finances";

/** Coinpile, read only: what you share with the Orb (Coinpile → Settings →
 *  Home Assistant & API). It adds what Firefly III has no place for:
 *  savings set aside vs free, goals, alerts, CD maturities, the spending
 *  forecast and Robinhood. */
const SEV_CLS: Record<string, string> = { critical: "bad", warning: "warn", info: "" };
const off = <span className="muted small">not shared</span>;
const pct = (f: number | null | undefined) => (f === null || f === undefined ? "" : `${Math.round(f * 100)}%`);
function useCp(app: App) { return useFetch<any>(`/api/apps/${encodeURIComponent(app.name)}/coinpile`, 5 * 60000); }

/** Small parts shared with the panel. */
export function Forecast({ s }: { s: any }) {
  if (!s) return null;
  return <span title="This month's spending so far and where it's heading, from your own history">{money(s.soFar)} so far, on track for <b>{money(s.projected)}</b>
    {s.pctOfIncome !== null ? <> ({pct(s.pctOfIncome)} of income)</> : null}{s.leftAfter !== null ? <>, {money(s.leftAfter)} left</> : null}</span>;
}
export function GoalBars({ goals, limit = 0 }: { goals: any[]; limit?: number }) {
  const list = limit ? goals.slice(0, limit) : goals;
  if (!list.length) return <div className="empty small">No active goals.</div>;
  return <>{list.map((g, k) => <div key={k} className="meter"><div className="lab"><span>{g.name}</span><b>{money(g.allocated)}{g.target !== null ? ` of ${money(g.target)}` : ""} · {pct(g.pct)}</b></div>
    <div className="bar"><span style={{ width: Math.min(100, Math.round((g.pct ?? 0) * 100)) + "%" }} /></div></div>)}</>;
}
export function AlertList({ alerts, limit = 0 }: { alerts: any[]; limit?: number }) {
  const list = limit ? alerts.slice(0, limit) : alerts;
  if (!list.length) return <div className="empty small">All quiet in the vaults.</div>;
  return <ul className="list">{list.map((a, k) => <li key={k}><span className={"chip " + SEV_CLS[a.severity]}>{a.severity}</span>
    <div className="grow">{a.title}{a.detail && <div className="hint">{a.detail}</div>}</div>{a.date && <span className="date">{fmtDate(a.date)}</span>}</li>)}</ul>;
}

function Overview({ app }: { app: App }) {
  const { data: d, error } = useCp(app);
  if (error) return <div className="err-inline">{error}</div>;
  if (!d) return <div className="hint">Counting the coins…</div>;
  return <>
    <table className="tbl small"><tbody>
      <tr><td>Net worth</td><td className="num">{d.netWorth !== null ? money(d.netWorth) : off}</td></tr>
      <tr><td>Subscriptions</td><td className="num">{d.subscriptionsMonthly !== null ? `${money(d.subscriptionsMonthly)}/mo` : off}</td></tr>
      <tr><td>Bills, next 7 / 30 days</td><td className="num">{d.bills ? `${money(d.bills.next7d)} / ${money(d.bills.next30d)}` : off}</td></tr>
      {d.bills?.next && <tr><td>Next bill</td><td className="num">{d.bills.next.name} · {fmtDate(d.bills.next.date)} · {money(d.bills.next.amount)}</td></tr>}
      <tr><td>Spending this month</td><td className="num">{d.spending ? <Forecast s={d.spending} /> : off}</td></tr>
      <tr><td>Savings (free / set aside)</td><td className="num">{d.savings ? `${money(d.savings.total)} (${money(d.savings.free)} / ${money(d.savings.earmarked)})` : off}</td></tr>
      {d.robinhoodMain && <tr><td>Robinhood</td><td className="num" title={`as of ${d.robinhoodMain.asOf}`}>{money(d.robinhoodMain.value)}</td></tr>}
      {d.robinhoodAgent && <tr><td>Robinhood agentic account</td><td className="num" title={`as of ${d.robinhoodAgent.asOf}`}>{money(d.robinhoodAgent.value)}</td></tr>}
    </tbody></table>
    <div className="hint">Read only. You choose what Orb sees in Coinpile → Settings → Home Assistant & API. {ago(d.at)}</div>
  </>;
}
function Alerts({ app }: { app: App }) {
  const { data: d } = useCp(app);
  if (!d) return <div className="hint">…</div>;
  if (!d.alertList) return <div className="empty">The alert list isn't shared (Coinpile → Settings → Home Assistant & API → Alert list).{d.alerts ? ` ${d.alerts.total} alerts, ${d.alerts.critical} critical.` : ""}</div>;
  return <AlertList alerts={d.alertList} />;
}
function Goals({ app }: { app: App }) {
  const { data: d } = useCp(app);
  if (!d) return <div className="hint">…</div>;
  return d.goals ? <GoalBars goals={d.goals} /> : <div className="empty">Goals aren't shared.</div>;
}
function Maturing({ app }: { app: App }) {
  const { data: d } = useCp(app), today = todayISO();
  if (!d) return <div className="hint">…</div>;
  if (!d.maturities.length) return <div className="empty">No CDs or bonds maturing soon{d.alertList ? "" : " (they come with the shared alert list)"}.</div>;
  return <ul className="list">{d.maturities.map((m: any, k: number) => <li key={k}><span className="date">{m.date === today ? "Today" : fmtDate(m.date)}</span>
    <div className="grow">{m.title}{m.detail && <div className="hint">{m.detail}</div>}</div>{m.kind === "matured_idle" && <span className="chip warn">sitting idle</span>}</li>)}</ul>;
}

export function coinpilePage(app: App, label: string): PageDef {
  return { id: "coinpile", label, title: "The Coin Pile", flavor: `${app.name}: savings, goals, alerts and the forecast, read only.`,
    usePanels: () => ({ panels: [
      { key: "overview", title: "At a glance", node: <Overview app={app} />, w: 6, h: 9 },
      { key: "alerts", title: "Alerts", node: <Alerts app={app} />, w: 6, h: 9 },
      { key: "goals", title: "Goals", node: <Goals app={app} />, w: 6, h: 7 },
      { key: "maturing", title: "Maturing", node: <Maturing app={app} />, w: 6, h: 6 },
      { key: "open", title: "Open Coinpile", node: <AppTiles apps={[app]} />, w: 4, h: 3 },
    ] }) };
}
