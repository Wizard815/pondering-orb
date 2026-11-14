import { createPortal } from "react-dom";
import { useFetch } from "../lib/useFetch";
import { useDialog } from "../lib/useDialog";
import { ago } from "../lib/util";
import { money, pct } from "./Spark";

export type Coverage = { on: boolean; label: string; template: string };
/** A link to the story's coverage elsewhere (Ground News by default), built from its headline. */
export const coverageUrl = (c: Coverage | undefined, title: string) => (c?.on && /^https:\/\//.test(c.template) ? c.template.replace("{q}", encodeURIComponent(title.slice(0, 160))) : "");
const DEFAULT_COV: Coverage = { on: true, label: "Ground News", template: "https://ground.news/search?query={q}" };
/** "Search Ground News for …" for a stock or a news event (any words). */
export function CoverageSearch({ q, coverage, label }: { q: string; coverage?: Coverage; label?: string }) {
  const c = coverage || DEFAULT_COV, url = coverageUrl(c, q);
  return url ? <a className="cov-search small" href={url} target="_blank" rel="noopener noreferrer" title={`Search ${c.label} for ${q}`}>{label || `${c.label}: ${q}`}</a> : null;
}

type Item = { title: string; link: string; source: string; published: number; rating: string; why: string };
type Data = { symbol: string; name: string; price: number | null; changePct: number | null; position: any; items: Item[]; overall: string; summary: string; error: string };
const CHIP: Record<string, string> = { good: "ok", bad: "bad", neutral: "", mixed: "warn" };

/** Recent news about one stock, each headline rated good, bad or neutral for it by Golem's model. */
export function TickerNews({ symbol, coverage, onClose }: { symbol: string; coverage?: Coverage; onClose: () => void }) {
  const { data, error } = useFetch<Data>(`/api/market/news/${encodeURIComponent(symbol)}`), ref = useDialog<HTMLDivElement>(onClose);
  const d = data?.symbol === symbol ? data : null, p = d?.position;
  return createPortal(<div ref={ref} tabIndex={-1} className="lk-modal" role="dialog" aria-modal="true" aria-label={`${symbol} news`} onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="panel tn">
      <div className="row tn-head"><h3>{symbol}{d && d.name !== symbol ? <span className="hint"> {d.name}</span> : null}</h3>
        {d?.price != null && <span className="num">{money(d.price)} <span className={d.changePct! >= 0 ? "up" : "down"}>{pct(d.changePct!)}</span></span>}
        <span className="grow" /><button className="btn" onClick={onClose}>Close</button></div>
      <div className="row small" style={{ gap: 10, flexWrap: "wrap" }}><CoverageSearch q={d && d.name !== symbol ? d.name : `${symbol} stock`} coverage={coverage} label={`Search ${(coverage || DEFAULT_COV).label} for ${d && d.name !== symbol ? d.name : symbol}`} /></div>
      {p && <div className="small tn-pos">You hold <b>{p.shares}</b> shares at {money(p.avgCost)} average{p.realized ? ` · realised ${money(p.realized)}` : ""}{p.dividends ? ` · dividends ${money(p.dividends)}` : ""}.</div>}
      {error && !d && <div className="empty">{error}</div>}
      {!d && !error && <div className="hint">Reading the news and rating it…</div>}
      {d && <>
        {d.overall && <div className="tn-overall"><span className={"chip " + (CHIP[d.overall] || "")}>{d.overall} for the stock</span> <span className="small">{d.summary}</span></div>}
        {d.error && <div className="err-inline small">{d.error}</div>}
        {!d.items.length ? <div className="empty">No recent news found for {symbol}.</div>
          : <ul className="list">{d.items.map((n, k) => { const cov = coverageUrl(coverage, n.title); return <li key={k}>
            {n.rating ? <span className={"chip " + (CHIP[n.rating] || "")}>{n.rating}</span> : <span className="chip">?</span>}
            <div className="grow"><a href={n.link} target="_blank" rel="noopener noreferrer">{n.title}</a>
              <div className="hint">{n.source}{n.published ? ` · ${ago(n.published)}` : ""}{n.why ? ` · ${n.why}` : ""}{cov && <> · <a href={cov} target="_blank" rel="noopener noreferrer">{coverage!.label}</a></>}</div></div></li>; })}</ul>}
        <div className="hint">Ratings are your Golem model's reading of the headlines, not advice.</div>
      </>}
    </div></div>, document.body);
}
