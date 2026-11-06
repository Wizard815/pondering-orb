import { useEffect, useState } from "react";
import type { PageDef } from "./types";
import { useColl } from "../lib/store";
import { useUi } from "../lib/ui";
import { post } from "../lib/api";
import { useFetch } from "../lib/useFetch";
import { Markdown } from "../lib/markdown";
import { ago, fmtDate, oneAtATime, todayISO } from "../lib/util";
import { Spark, pct, money } from "../components/Spark";

const ACTION_CLS: Record<string, string> = { buy: "ok", hold: "warn", skip: "bad" };
const H = [1, 5, 20, 60];
const rh = (sym: string) => `https://robinhood.com/stocks/${encodeURIComponent(sym)}`;

function Research() {
  const ui = useUi(), day = todayISO(), r = useColl("research").find(d => d.id === day), { data: st, reload } = useFetch<any>("/api/market/status", 15000);
  // The research record is live (SSE); the status poll only covers a run with no record yet.
  const busy = r ? !["done", "failed"].includes(r.status) : !!st?.running;
  const run = async () => { try { await post("/api/market/run"); ui.status("Research started. It takes a few minutes; picks appear here as they're judged."); reload(); } catch (x) { ui.error(x); } };
  const STEP: Record<string, string> = { news: "Researching today's market news…", stocks: "Researching stock news…", candidates: "Choosing candidates…", verdicts: "Judging each candidate…", done: "Done", failed: "Failed" };
  return <>
    <div className="row"><button className="btn primary" disabled={busy} onClick={run}>{busy ? "Researching…" : r ? "Run research again" : "Run today's research"}</button>
      {r && <span className={"pill " + (r.status === "failed" ? "bad" : r.status === "done" ? "ok" : "")}><i />{STEP[r.status] || r.status}{r.finishedAt ? ` · ${ago(r.finishedAt)}` : ""}</span>}
      <span className="hint">Verdicts by {st?.decider ? (st.decider.usesGolem ? "Golem's model" : `${st.decider.kind === "jev" ? "your Jev-format service" : "your decision model"}${st.decider.model ? ` (${st.decider.model})` : ""}`) : "…"}.</span></div>
    {r?.error && <div className="err-inline small">{r.error}</div>}
    {r?.newsReport && <details><summary className="small">Market news report</summary><Markdown text={r.newsReport} /></details>}
    {r?.stockReport && <details><summary className="small">Stock news report</summary><Markdown text={r.stockReport} /></details>}
    {!r && <div className="hint">Research runs {st?.settings?.on ? `on ${st.settings.weekdaysOnly ? "weekdays" : "every day"} after ${String(st.settings.hour).padStart(2, "0")}:00` : "when you press the button (turn on the daily run in Settings → Stock picks)"}.</div>}
  </>;
}

function Probs({ a }: { a: any }) {
  if (!a?.probabilities) return null;
  return <span className="probs">{Object.entries(a.probabilities as Record<string, number>).map(([k, v]) => <span key={k} className={k === a.choice ? "on" : ""} title={`${k}: ${Math.round(v * 100)}%`}>
    <i style={{ width: `${Math.max(2, Math.round(v * 100))}%` }} />{k} {Math.round(v * 100)}%</span>)}</span>;
}

function Decide({ p }: { p: any }) {
  const ui = useUi(), [amount, setAmount] = useState(String(p.amount || "")), [note, setNote] = useState(p.note || "");
  const go = (decision: string) => (e: React.MouseEvent<HTMLButtonElement>) => oneAtATime(e.currentTarget.form, async () => {
    try { await post(`/api/market/picks/${encodeURIComponent(p.id)}/decide`, { decision, amount: Number(amount) || 0, note });
      ui.status(decision === "yes" ? `Marked ${p.symbol} as bought. Place the order on Robinhood if you haven't.` : decision === "no" ? `Passed on ${p.symbol}; Orb will track what it would have done.` : "Back to undecided."); } catch (x) { ui.error(x); } });
  return <form className="row decide" onSubmit={e => e.preventDefault()}>
    <label className="small row" style={{ gap: 4 }}>$<input type="number" min={0} step="any" value={amount} onChange={e => setAmount(e.target.value)} aria-label={`Amount for ${p.symbol}`} style={{ width: 90 }} placeholder="amount" /></label>
    <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="Why (optional)" aria-label="Note" style={{ flex: "1 1 120px" }} />
    {p.decision !== "yes" && <button className="btn primary" onClick={go("yes")}>I'm buying</button>}
    {p.decision !== "no" && <button className="btn" onClick={go("no")}>Pass</button>}
    {p.decision !== "pending" && <button className="btn sm" onClick={go("pending")}>Undo</button>}
    <a className="btn" href={rh(p.symbol)} target="_blank" rel="noopener noreferrer">Open on Robinhood</a>
  </form>;
}

function PickCard({ p }: { p: any }) {
  const v = p.verdict?.answers || {}, a = v.action?.choice || "?", { data } = useFetch<any>(`/api/market/chart/${encodeURIComponent(p.symbol)}`, 0);
  return <div className="pick">
    <div className="row"><b className="sym">{p.symbol}</b><span className="muted small">{p.name}</span><span className={"chip " + (ACTION_CLS[a] || "")}>{a}</span>
      {v.conviction && <span className="tag">{v.conviction.choice} conviction</span>}
      {p.decision !== "pending" && <span className={"pill " + (p.decision === "yes" ? "ok" : "")}><i />{p.decision === "yes" ? "you bought" : "you passed"}{p.amount ? ` · ${money(p.amount)}` : ""}</span>}<span className="grow" /><span className="num">{money(p.priceAtPick)}</span>
      {data?.history && <Spark data={data.history.map((b: any) => b.close)} mark={p.priceAtPick} w={120} />}</div>
    <div className="small">{p.thesis}</div>
    {p.catalyst && <div className="hint">Catalyst: {p.catalyst}</div>}
    <div className="verdict small">
      <div>Action <Probs a={v.action} /></div><div>5 days <Probs a={v.direction_5d} /></div><div>20 days <Probs a={v.direction_20d} /></div>
      <div className="hint">by {p.verdict?.source === "jev" ? "Jev-format model" : "decision model"}{p.verdict?.model ? ` ${p.verdict.model}` : ""}{p.verdict?.error ? ` · ${p.verdict.error}` : ""}</div></div>
    {p.sources?.length > 0 && <div className="small">{p.sources.map((u: string, k: number) => <a key={k} href={u} target="_blank" rel="noopener noreferrer" className="src">{new URL(u).hostname.replace(/^www\./, "")}</a>)}</div>}
    <Decide p={p} />
    {p.decision === "yes" && <OrderStep p={p} />}
  </div>;
}

/** Place the order through Robinhood's Trading MCP: Orb fills in the order,
 *  you see exactly what will be sent, and confirm. */
function OrderStep({ p }: { p: any }) {
  const ui = useUi(), orders = useColl("orders").filter(o => o.pickId === p.id).sort((a, b) => b.at - a.at);
  const open = async (e: React.MouseEvent<HTMLButtonElement>) => {
    const anchor = e.currentTarget;
    try { const pv = await post<any>("/api/robinhood/order/preview", { pickId: p.id, amount: p.amount }); ui.pop(anchor, <OrderForm p={p} pv={pv} />); } catch (x) { ui.error(x); }
  };
  return <div className="row small">
    {orders[0] ? <span className={"pill " + (orders[0].isError ? "bad" : "ok")} title={orders[0].result}><i />{orders[0].isError ? "order failed" : `order sent · $${orders[0].dollars}`} {ago(orders[0].at)}</span> : null}
    {(!orders[0] || orders[0].isError) && <button className="btn" onClick={open} disabled={!p.amount}>{p.amount ? `Place a $${p.amount} order on Robinhood…` : "Set an amount to place an order"}</button>}
    {orders[0] && !orders[0].isError && <span className="hint">Check it in Robinhood's agentic account.</span>}
  </div>;
}
function OrderForm({ p, pv }: { p: any; pv: any }) {
  const ui = useUi(), [text, setText] = useState(JSON.stringify(pv.args, null, 2)), [err, setErr] = useState("");
  let args: any = null; try { args = JSON.parse(text); } catch { /* shown below */ }
  return <form className="pop-form" style={{ minWidth: "min(380px,90vw)" }} onSubmit={e => { e.preventDefault(); if (!args) return setErr("That isn't valid JSON.");
    oneAtATime(e.currentTarget, async () => { try { await post("/api/robinhood/order", { pickId: p.id, tool: pv.tool, args, confirm: true }); ui.close(); ui.status(`Order for ${p.symbol} sent to Robinhood.`); } catch (x: any) { setErr(x?.message || String(x)); } }); }}>
    <div className="mh" style={{ padding: 0 }}>Buy {p.symbol} on Robinhood</div>
    <div className="small">Orb will call <b className="mono">{pv.tool}</b> with exactly this. Price now about {money(pv.price)}. Caps: {money(pv.maxOrder)} per order, {money(pv.maxDay)} a day.</div>
    {pv.warnings?.map((w: string, k: number) => <div key={k} className="err-inline small">{w}</div>)}
    <textarea rows={8} className="mono" value={text} onChange={e => setText(e.target.value)} aria-label="Order arguments" />
    {!pv.tradingOn && <div className="err-inline small">Placing orders is off. Turn it on in <a href="#config">Settings → Robinhood</a>.</div>}
    {err && <div className="err">{err}</div>}
    <div className="row"><button className="btn primary" type="submit" disabled={!pv.tradingOn || !args}>Send this order</button><button className="btn" type="button" onClick={ui.close}>Cancel</button></div>
  </form>;
}

function Account() {
  const { data: st } = useFetch<any>("/api/robinhood/status", 0);
  const { data, error, reload } = useFetch<any>(st?.connected && st?.accountTool ? "/api/robinhood/account" : null, 5 * 60000);
  if (!st) return <div className="hint">…</div>;
  if (!st.connected) return <div className="empty">Robinhood isn't connected. <a href="#config">Settings → Robinhood</a></div>;
  if (!st.accountTool) return <div className="empty">Pick the account tool in <a href="#config">Settings → Robinhood</a>.</div>;
  return <>{error ? <div className="err-inline small">{error}</div> : data ? <pre className="small" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{data.text}</pre> : <div className="hint">Reading the account…</div>}
    <div className="row small"><button className="btn" onClick={reload}>Refresh</button><span className="hint">{st.tradingOn ? `Orders on · $${Number(st.spentToday).toFixed(2)} of $${st.maxDay} today` : "Orders off"}</span></div></>;
}

function Today() {
  const day = todayISO(), picks = useColl("picks").filter(p => p.date === day || p.decision === "pending").sort((a, b) => String(b.date).localeCompare(a.date));
  if (!picks.length) return <div className="empty">No picks waiting. Run the research to get today's.</div>;
  return <>{picks.map(p => <PickCard key={p.id} p={p} />)}
    <div className="hint">Not financial advice. Verdicts are a model's guess and are often wrong: check the scorecard before trusting them. Orders go to Robinhood only when you confirm them.</div></>;
}

function History() {
  const ui = useUi(), [show, setShow] = useState<"all" | "yes" | "no">("all"), picks = useColl("picks").filter(p => p.decision !== "pending" && (show === "all" || p.decision === show))
    .sort((a, b) => String(b.date).localeCompare(a.date));
  const refresh = async () => { try { const r = await post<{ updated: number }>("/api/market/outcomes"); ui.status(`Updated ${r.updated} pick${r.updated === 1 ? "" : "s"}.`); } catch (x) { ui.error(x); } };
  return <>
    <div className="row small"><select value={show} onChange={e => setShow(e.target.value as any)} aria-label="Which picks"><option value="all">Bought and passed</option><option value="yes">Bought</option><option value="no">Passed</option></select>
      <button className="btn" onClick={refresh}>Update prices</button><span className="hint">Returns after 1, 5, 20 and 60 trading days. Passed picks show what your amount (or the default) would have made.</span></div>
    {picks.length ? <div style={{ overflowX: "auto" }}><table className="tbl"><thead><tr><th>Date</th><th>Stock</th><th>Verdict</th><th>You</th><th className="num">Amount</th><th className="num">At pick</th>{H.map(k => <th key={k} className="num">{k}d</th>)}<th className="num">P/L</th></tr></thead>
      <tbody>{picks.map(p => { const last = [...H].reverse().map(k => p.outcomes?.[`d${k}`]).find(Boolean), amt = p.amount || 0;
        return <tr key={p.id}><td className="small">{fmtDate(p.date)}</td><td><b>{p.symbol}</b></td><td><span className={"chip " + (ACTION_CLS[p.verdict?.answers?.action?.choice] || "")}>{p.verdict?.answers?.action?.choice}</span></td>
          <td>{p.decision === "yes" ? "bought" : "passed"}</td><td className="num">{amt ? money(amt) : "—"}</td><td className="num">{money(p.priceAtPick)}</td>
          {H.map(k => { const o = p.outcomes?.[`d${k}`]; return <td key={k} className={"num " + (o ? (o.retPct >= 0 ? "up" : "down") : "muted")}>{o ? pct(o.retPct) : "…"}</td>; })}
          <td className={"num " + (last ? (last.retPct >= 0 ? "up" : "down") : "muted")} title={p.decision === "no" ? "what it would have made" : ""}>{last && amt ? (p.decision === "no" ? "would be " : "") + money((amt * last.retPct) / 100) : "…"}</td></tr>; })}</tbody></table></div>
      : <div className="empty">Nothing decided yet.</div>}
  </>;
}

function Scorecard() {
  const { data, error, reload } = useFetch<any>("/api/market/scorecard", 60000), picks = useColl("picks");
  useEffect(() => { reload(); }, [picks, reload]); // new picks, decisions and outcomes arrive live
  if (error) return <div className="err-inline">{error}</div>;
  if (!data) return <div className="hint">Scoring…</div>;
  const dir = (d: any, n: number) => !d?.n ? <div className="hint">{n}-day direction: nothing scored yet.</div>
    : <div className="small">{n}-day direction: <b>{Math.round(d.accuracy * 100)}%</b> right over {d.n} (always “flat” would get {Math.round(d.alwaysFlat * 100)}%, momentum {Math.round(d.momentum * 100)}%). Brier {d.brier} (lower is better; 0.667 is a uniform guess).</div>;
  return <>
    <div className="row small"><span className="tag">{data.picks} picks</span><span className="tag">{data.pending} waiting</span><span className="tag">{data.yes} bought</span><span className="tag">{data.no} passed</span>
      <span className="hint">{data.sources.jev} by a Jev-format model, {data.sources.llm} by an OpenAI-compatible one</span></div>
    <table className="tbl"><thead><tr><th>After</th><th className="num">Scored</th><th className="num">Bought: P/L</th><th className="num">Passed: would have</th><th className="num">“Buy” verdicts avg</th></tr></thead>
      <tbody>{data.horizons.map((h: any) => <tr key={h.days}><td>{h.days} trading day{h.days === 1 ? "" : "s"}</td><td className="num">{h.scored}</td>
        <td className={"num " + (h.yesPnl >= 0 ? "up" : "down")}>{money(h.yesPnl)}</td><td className={"num " + (h.noWouldHave >= 0 ? "up" : "down")}>{money(h.noWouldHave)}</td>
        <td className="num">{h.buyAvgRet == null ? "—" : pct(h.buyAvgRet)}</td></tr>)}</tbody></table>
    {dir(data.direction5d, 5)}{dir(data.direction20d, 20)}
    <div className="hint">This record goes into every new verdict, so the model sees how its past calls did. Passed picks without an amount use ${data.notional}.</div>
  </>;
}

export const PicksPage: PageDef = {
  id: "picks", label: "Picks", title: "Augury", flavor: "Daily research, a verdict per stock, your call, and what came of it.",
  usePanels: () => ({
    panels: [
      { key: "research", title: "Today's research", node: <Research />, w: 12, h: 5 },
      { key: "today", title: "Picks waiting for you", node: <Today />, w: 7, h: 16 },
      { key: "score", title: "Scorecard", node: <Scorecard />, w: 5, h: 10 },
      { key: "history", title: "History", node: <History />, w: 12, h: 10 },
      { key: "account", title: "Robinhood agentic account", node: <Account />, w: 5, h: 7 },
    ],
  }),
};
