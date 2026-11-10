import { useState } from "react";
import type { PageDef } from "./types";
import { useFetch } from "../lib/useFetch";
import { ago, fmtDate, todayISO } from "../lib/util";
import { AppTiles } from "../components/AppPanels";
import type { App } from "../lib/apps";

/** Firefly III, read only: this month, accounts, bills, budgets, piggy banks
 *  and transactions. The full page is turned on with `page: true` on the
 *  app's widget in the apps YAML. */
export const money = (n: number | null | undefined, cur = "USD") => (n === null || n === undefined ? "—"
  : n.toLocaleString(undefined, { style: "currency", currency: cur || "USD", maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 }));
const base = (app: App) => `/api/apps/${encodeURIComponent(app.name)}/firefly`;
function useOverview(app: App) { return useFetch<any>(`${base(app)}/overview`, 5 * 60000); }
const Err = ({ e }: { e: string }) => <div className="err-inline">{e}</div>;

/** The month at a glance (also the small panel's body). */
export function MonthBoxes({ s }: { s: any }) {
  const c = s.currency, box = (label: string, v: number | null, cls = "") => <div className="ff-box"><div className="hint">{label}</div><b className={cls}>{money(v, c)}</b></div>;
  return <div className="ff-boxes">
    {box("Net worth", s.netWorth)}{box("Spent this month", s.spent, "down")}{box("Earned this month", s.earned, "up")}
    {box("Left to spend", s.leftToSpend, s.leftToSpend !== null && s.leftToSpend < 0 ? "down" : "")}{box("Bills still to pay", s.billsUnpaid)}
  </div>;
}
export function BudgetBars({ budgets, limit = 0 }: { budgets: any[]; limit?: number }) {
  const list = limit ? budgets.slice(0, limit) : budgets;
  if (!list.length) return <div className="empty small">No budgets this month.</div>;
  return <>{list.map((b, k) => <div key={k} className="meter"><div className="lab"><span>{b.name}</span><b className={b.pct > 100 ? "down" : ""}>{money(b.spent, b.currency)} of {money(b.amount, b.currency)} · {b.pct}%</b></div>
    <div className="bar"><span className={b.pct >= 100 ? "crit" : b.pct >= 85 ? "hot" : ""} style={{ width: Math.min(100, b.pct) + "%" }} /></div></div>)}</>;
}

function Month({ app }: { app: App }) {
  const { data, error } = useOverview(app);
  if (error) return <Err e={error} />;
  if (!data) return <div className="hint">Counting the hoard…</div>;
  return <><MonthBoxes s={data.summary} /><div className="hint">{fmtDate(data.summary.from)} to {fmtDate(data.summary.to)} · read only from Firefly III · {ago(data.at)}</div></>;
}
function Bills({ app }: { app: App }) {
  const { data } = useOverview(app), today = todayISO();
  if (!data) return <div className="hint">…</div>;
  if (!data.bills.length) return <div className="empty">No bills in the next 30 days.</div>;
  const due = data.bills.filter((b: any) => !b.paid);
  return <><ul className="list">{data.bills.map((b: any, k: number) => <li key={k} className={b.paid ? "muted" : ""}><span className="date">{b.date === today ? "Today" : fmtDate(b.date)}</span>
    <div className="grow">{b.name}{b.repeat && <span className="hint"> · {b.repeat}</span>}</div>{b.paid ? <span className="chip ok">paid</span> : b.date < today ? <span className="chip bad">late</span> : null}<span className="num">{money(b.amount, b.currency)}</span></li>)}</ul>
    <div className="hint">{due.length} to pay, {money(due.reduce((a: number, b: any) => a + b.amount, 0), data.summary.currency)} in total.</div></>;
}
function Budgets({ app }: { app: App }) {
  const { data } = useOverview(app);
  return data ? <BudgetBars budgets={data.budgets} /> : <div className="hint">…</div>;
}
function Piggies({ app }: { app: App }) {
  const { data } = useOverview(app);
  if (!data) return <div className="hint">…</div>;
  if (!data.piggies.length) return <div className="empty">No piggy banks.</div>;
  return <>{data.piggies.map((p: any, k: number) => <div key={k} className="meter"><div className="lab"><span>{p.name}{p.targetDate && <span className="hint"> · by {fmtDate(p.targetDate)}</span>}</span>
    <b>{money(p.saved, p.currency)}{p.target !== null ? ` of ${money(p.target, p.currency)}` : ""} · {p.pct}%</b></div><div className="bar"><span style={{ width: p.pct + "%" }} /></div></div>)}</>;
}
function Accounts({ app }: { app: App }) {
  const { data, error } = useFetch<any[]>(`${base(app)}/accounts`, 5 * 60000);
  if (error) return <Err e={error} />;
  if (!data) return <div className="hint">…</div>;
  const group = (t: string) => data.filter(a => (t === "asset" ? a.type === "asset" : a.type !== "asset"));
  const table = (rows: any[]) => <table className="tbl small"><tbody>{rows.map((a, k) => <tr key={k}><td>{a.name}{!a.inNetWorth && <span className="hint"> · not in net worth</span>}</td>
    <td className={"num " + (a.balance < 0 ? "down" : "")}>{money(a.balance, a.currency)}</td></tr>)}</tbody></table>;
  return <>{group("asset").length > 0 && <><h4 className="group-name">Assets</h4>{table(group("asset"))}</>}
    {group("liability").length > 0 && <><h4 className="group-name">Liabilities</h4>{table(group("liability"))}</>}</>;
}
function Transactions({ app }: { app: App }) {
  const [q, setQ] = useState(""), [asked, setAsked] = useState("");
  const { data, error, loading } = useFetch<any[]>(`${base(app)}/transactions${asked ? `?q=${encodeURIComponent(asked)}` : "?limit=25"}`, asked ? 0 : 5 * 60000);
  return <>
    <form className="row" onSubmit={e => { e.preventDefault(); setAsked(q.trim()); }}>
      <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search: amazon, category:Groceries, date_after:2026-10-01" aria-label="Search transactions" style={{ flex: 1 }} />
      <button className="btn primary" type="submit">Search</button>{asked && <button className="btn" type="button" onClick={() => { setQ(""); setAsked(""); }}>Recent</button>}
    </form>
    {error && <Err e={error} />}{loading && !data && <div className="hint">…</div>}
    {data && (data.length ? <div style={{ overflowX: "auto" }}><table className="tbl small" style={{ width: "100%" }}><tbody>{data.map((t, k) => <tr key={k}><td className="small">{fmtDate(t.date)}</td>
      <td>{t.description}<div className="hint">{[t.counterparty, t.category, t.budget].filter(Boolean).join(" · ")}</div></td><td className="small muted">{t.account}</td>
      <td className={"num " + (t.amount < 0 ? "down" : t.type === "deposit" ? "up" : "")}>{money(t.amount, t.currency)}</td></tr>)}</tbody></table></div>
      : <div className="empty">Nothing found.</div>)}
  </>;
}

export function fireflyPage(app: App, label: string): PageDef {
  return { id: "money", label, title: "The Hoard", flavor: `${app.name}: your money this month, read only.`,
    usePanels: () => ({ panels: [
      { key: "month", title: "This month", node: <Month app={app} />, w: 12, h: 4 },
      { key: "bills", title: "Bills, next 30 days", node: <Bills app={app} />, w: 5, h: 10 },
      { key: "budgets", title: "Budgets", node: <Budgets app={app} />, w: 7, h: 10 },
      { key: "accounts", title: "Accounts", node: <Accounts app={app} />, w: 5, h: 9 },
      { key: "piggies", title: "Piggy banks", node: <Piggies app={app} />, w: 7, h: 6 },
      { key: "transactions", title: "Transactions", node: <Transactions app={app} />, w: 12, h: 12 },
      { key: "open", title: "Open Firefly III", node: <AppTiles apps={[app]} />, w: 4, h: 3 },
    ] }) };
}
