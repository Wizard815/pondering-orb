import type { FastifyInstance } from "fastify";
import type { Records } from "./records.js";
import { HttpError } from "./records.js";
import type { OrbConfig } from "./config.js";
import { secret } from "./config.js";
import { chat } from "./integrations/llm.js";
import { newsSearch, quote, cleanSymbol, type NewsItem } from "./integrations/daily.js";
import { localDay, today } from "./dates.js";
import { companion } from "./integrations/companions.js";
import { cpSummary } from "./integrations/coinpile.js";

/** Stocks you watch and own:
 *  - news about one ticker, each headline rated good, bad or neutral for the
 *    stock by Golem's model (your own endpoint), with an overall read;
 *  - what you hold, from Coinpile (which reads Robinhood: its activity CSV,
 *    MCP or connector) when Coinpile shares holdings with the Orb. Read only. */

// ---------------- rated news ----------------
export type Rated = NewsItem & { rating: "good" | "bad" | "neutral" | ""; why: string };
const RATINGS = ["good", "bad", "neutral"] as const;
const rateCache = new Map<string, { at: number; v: unknown }>();

/** Recent news about a ticker, each headline rated for the stock by Golem's model (cached half an hour). */
export type RatedNews = { items: Rated[]; overall: string; summary: string; model: string; error: string };
export async function ratedNews(symbol: string, g: { baseUrl: string; model: string; key: string }): Promise<RatedNews> {
  const items = await newsSearch(`${symbol} stock`, 12), key = `${symbol}:${today()}:${items.map(i => i.link).join("|")}`;
  const hit = rateCache.get(key); if (hit && Date.now() - hit.at < 30 * 60000) return hit.v as RatedNews;
  const base: Rated[] = items.map(i => ({ ...i, rating: "", why: "" }));
  let out = { items: base, overall: "", summary: "", model: g.model || "", error: "" };
  if (items.length) try {
    const list = items.map((i, k) => `${k + 1}. ${i.title} (${i.source}${i.published ? `, ${localDay(i.published)}` : ""})`).join("\n");
    const r = await chat({ baseUrl: g.baseUrl, model: g.model, key: g.key, who: "market", tools: [], maxRounds: 1, messages: [
      { role: "system", content: "You rate news headlines for what they likely mean for one stock's price over the next few weeks. For each headline answer good, bad or neutral for the stock, with a short reason (under 15 words). Judge only from the headline; when it isn't clearly about the company or its prospects, say neutral. Then give an overall read (good, bad, mixed or neutral) and one or two sentences. Answer with JSON only." },
      { role: "user", content: `Stock: ${symbol}\nHeadlines:\n${list}\n\nRespond ONLY with JSON: {"items":[{"n":1,"rating":"good|bad|neutral","why":"..."}],"overall":"good|bad|mixed|neutral","summary":"..."}` }] });
    const j = JSON.parse(/\{[\s\S]*\}/.exec(r.text)?.[0] || "{}");
    for (const x of Array.isArray(j.items) ? j.items : []) { const k = Number(x?.n) - 1; if (base[k] && (RATINGS as readonly string[]).includes(x.rating)) { base[k].rating = x.rating; base[k].why = String(x.why || "").slice(0, 160); } }
    out = { ...out, items: base, overall: ["good", "bad", "mixed", "neutral"].includes(j.overall) ? j.overall : "", summary: String(j.summary || "").slice(0, 500) };
  } catch (e: any) { out.error = `Couldn't rate the news: ${e.message}`; }
  rateCache.set(key, { at: Date.now(), v: out });
  return out;
}


// ---------------- holdings (from Coinpile) ----------------
export type Position = { symbol: string; shares: number; avgCost: number | null; cost: number | null; price: number | null; value: number | null; unrealized: number | null; unrealizedPct: number | null; account: string };
/** Holdings Coinpile shares (null when Coinpile isn't set up or doesn't share them yet), one line per symbol. */
export async function coinpileHoldings(appsYaml: string): Promise<{ positions: Position[] | null; note: string }> {
  const cp = companion(appsYaml, "coinpile");
  if (!cp) return { positions: null, note: "Add Coinpile in Settings → Apps to see what you hold." };
  let s; try { s = await cpSummary(cp); } catch (e: any) { return { positions: null, note: e.message }; }
  if (!s.holdings) return { positions: null, note: "Coinpile isn't sharing holdings with the Orb yet (Coinpile → Settings → Home Assistant & API → share holdings)." };
  const by = new Map<string, Position>();
  for (const h of s.holdings) {
    const x = by.get(h.symbol) || { symbol: h.symbol, shares: 0, avgCost: null, cost: null, price: null, value: null, unrealized: null, unrealizedPct: null, account: h.account };
    x.shares += h.quantity; if (h.netCost != null) x.cost = (x.cost ?? 0) + h.netCost; if (h.equity != null) x.value = (x.value ?? 0) + h.equity;
    if (x.account !== h.account) x.account = "several"; by.set(h.symbol, x);
  }
  const out = [...by.values()].map(x => ({ ...x, shares: +x.shares.toFixed(6), avgCost: x.cost != null && x.shares ? +(x.cost / x.shares).toFixed(2) : null }));
  return { positions: out, note: "" };
}

export function stocksApi(app: FastifyInstance, deps: { records: Records; cfg: () => OrbConfig; guard: any; who: (req: any) => string }) {
  const { records, cfg, guard } = deps;
  const appsYaml = () => String((records.get("settings", "apps") as any)?.yaml || "");

  /** Your position in one stock (null if none, or holdings aren't shared). */
  async function positionOf(symbol: string) { return (await coinpileHoldings(appsYaml())).positions?.find(p => p.symbol === symbol) ?? null; }

  app.get("/api/market/news/:symbol", { preHandler: guard }, async (req: any) => {
    const symbol = cleanSymbol(req.params.symbol); if (!symbol) throw new HttpError(400, "That isn't a ticker.");
    const g = cfg().golem, [q, news] = await Promise.all([quote(symbol).catch(() => null), ratedNews(symbol, { baseUrl: g.baseUrl, model: g.model, key: secret(g.keyEnv) })]);
    return { symbol, name: q?.name || symbol, price: q?.price ?? null, changePct: q ? +q.changePct.toFixed(2) : null, position: await positionOf(symbol).catch(() => null), ...news };
  });

  /** What you hold, with current prices, from Coinpile. */
  app.get("/api/holdings", { preHandler: guard }, async () => {
    const { positions, note } = await coinpileHoldings(appsYaml());
    if (!positions) return { source: null, note, positions: [], totals: null };
    await Promise.all(positions.map(async p => { try { const q = await quote(p.symbol); p.price = q.price; p.value = +(q.price * p.shares).toFixed(2); } catch { /* keep Coinpile's value */ }
      if (p.value != null && p.cost != null) { p.unrealized = +(p.value - p.cost).toFixed(2); p.unrealizedPct = p.cost ? +((p.unrealized / p.cost) * 100).toFixed(2) : null; } }));
    const sum = (f: (p: Position) => number | null) => +positions.reduce((a, p) => a + (f(p) ?? 0), 0).toFixed(2);
    return { source: "coinpile", note: "", positions: positions.sort((a, b) => (b.value ?? 0) - (a.value ?? 0)), totals: { value: sum(p => p.value), cost: sum(p => p.cost), unrealized: sum(p => p.unrealized) } };
  });

  /** Coinpile's auto wallet and its ideas (Coinpile → Trading), read only. */
  app.get("/api/trading", { preHandler: guard }, async () => {
    const cp = companion(appsYaml(), "coinpile");
    if (!cp) return { trading: null, url: "", note: "Add Coinpile in Settings → Apps to see its trading." };
    let s; try { s = await cpSummary(cp); } catch (e: any) { return { trading: null, url: cp.url, note: e.message }; }
    return { trading: s.trading, url: cp.url, note: s.trading ? "" : "Coinpile isn't sharing trading with the Orb (Coinpile → Settings → Home Assistant & API → Trading; only the Robinhood owner has it)." };
  });

  return { positionOf };
}
