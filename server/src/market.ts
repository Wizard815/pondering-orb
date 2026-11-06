import type { FastifyInstance } from "fastify";
import type { Records } from "./records.js";
import { HttpError } from "./records.js";
import type { OrbConfig } from "./config.js";
import { secret } from "./config.js";
import { chat, type Tool } from "./integrations/llm.js";
import { newsSearch, quote, cleanSymbol, type Bar } from "./integrations/daily.js";
import { indicators, readPage } from "./integrations/research.js";
import { askJev, askLlm, type Question, type Verdict } from "./integrations/jev.js";
import { today } from "./dates.js";

/** Stock picks: a daily news research pass and a stock-news pass, a list of
 *  candidates from both, a verdict per ticker (Jev, or Golem's model), then
 *  you approve or decline with an amount. Every pick, taken or not, is
 *  tracked afterwards so you can see what would have happened, and that
 *  record goes back into the next verdicts.
 *
 *  Orb never places orders. Robinhood has no public trading API for stocks,
 *  and the unofficial ones break its terms and can lock the account, so an
 *  approved pick links to the stock on Robinhood for you to buy there. */
export const PROMPT_VERSION = "picks-v1";
export const HORIZONS = [1, 5, 20, 60]; // trading days after the pick
export type MarketSettings = { on: boolean; hour: number; weekdaysOnly: boolean; maxPicks: number; notional: number; index: string; avoid: string[]; strategy: string };
export const MARKET_DEFAULTS: MarketSettings = { on: false, hour: 8, weekdaysOnly: true, maxPicks: 5, notional: 100, index: "SPY", avoid: [],
  strategy: "Long-only US stocks for a personal account. Prefer liquid, well-known companies with a clear, recent, verifiable catalyst. Avoid penny stocks, leveraged ETFs and anything that needs a story to be true." };
export const marketSettings = (records: Records): MarketSettings => {
  const s: any = (records.get("settings", "app") as any)?.market || {};
  return { ...MARKET_DEFAULTS, ...s, on: !!s.on, hour: Math.max(0, Math.min(23, Math.round(+s.hour) || MARKET_DEFAULTS.hour)), weekdaysOnly: s.weekdaysOnly !== false,
    maxPicks: Math.max(1, Math.min(10, Math.round(+s.maxPicks) || 5)), notional: Math.max(1, +s.notional || 100), index: cleanSymbol(s.index) || "SPY",
    avoid: Array.isArray(s.avoid) ? s.avoid.map(cleanSymbol).filter(Boolean) : [], strategy: String(s.strategy || MARKET_DEFAULTS.strategy).slice(0, 2000) };
};

/** The questions every candidate gets. The bands decide what counts as
 *  up / flat / down when the outcome is scored later. */
const BAND5 = 1, BAND20 = 3;
const questions = (asOf: string): Record<string, Question> => ({
  action: { instructions: `Using only the state (data through ${asOf}) and the strategy, decide what to do with this stock for a holding period of about 20 trading days.`,
    criteria: { buy: `Worth buying now: a better than even chance of beating the index over ~20 trading days, with risk acceptable under the strategy.`, hold: "Interesting but not now: wait for a better entry or more information.", skip: "Not worth buying: weak case, too risky, or the news is already priced in." } },
  direction_5d: { instructions: `Forecast the stock's close 5 trading days after ${asOf} compared with the as_of close. Give an unconditional forecast.`,
    criteria: { up: `More than +${BAND5}%.`, flat: `Between -${BAND5}% and +${BAND5}%, inclusive.`, down: `Less than -${BAND5}%.` } },
  direction_20d: { instructions: `Forecast the stock's close 20 trading days after ${asOf} compared with the as_of close. This is a separate endpoint forecast, not a sum of daily moves.`,
    criteria: { up: `More than +${BAND20}%.`, flat: `Between -${BAND20}% and +${BAND20}%, inclusive.`, down: `Less than -${BAND20}%.` } },
  conviction: { instructions: "How strong is the case for the action you chose?", criteria: { weak: "Mostly a guess.", fair: "Some real evidence.", strong: "Clear evidence from several sources.", overwhelming: "Hard to argue with." } },
});
const FALLBACK = { action: "skip", direction_5d: "flat", direction_20d: "flat", conviction: "weak" };
const dirOf = (ret: number, band: number) => (ret > band ? "up" : ret < -band ? "down" : "flat");

export function marketApi(app: FastifyInstance, deps: { records: Records; cfg: () => OrbConfig; guard: any; who: (req: any) => string }) {
  const { records, cfg, guard } = deps;
  const golem = () => { const g = cfg().golem; return { baseUrl: g.baseUrl, model: g.model, key: secret(g.keyEnv) }; };

  // Read-only tools for the research passes.
  const researchTools: Tool[] = [
    { name: "news_search", description: "Search recent news headlines (Google News). Returns title, source, date and link. Search several times with different queries.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      run: async ({ query }: any) => (await newsSearch(String(query || "").slice(0, 200), 12)).map(n => ({ title: n.title, source: n.source, date: n.published ? new Date(n.published).toISOString().slice(0, 10) : "", link: n.link })) },
    { name: "read_page", description: "Read the text of a public news article by its link (first 8,000 characters).", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      run: ({ url }: any) => readPage(String(url)) },
    { name: "stock_quote", description: "Latest price, day change and recent returns for a US ticker.", parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
      run: async ({ symbol }: any) => { const q = await quote(symbol); return { symbol: q.symbol, name: q.name, price: q.price, changePct: +q.changePct.toFixed(2), indicators: indicators(q.history) }; } },
  ];

  /** What happened to past picks, in a few numbers, for the next verdicts. */
  function trackRecord() {
    const scored = (records.list("picks") as any[]).filter(p => p.outcomes?.d20);
    const by = (a: string) => scored.filter(p => p.verdict?.answers?.action?.choice === a);
    const avg = (xs: number[]) => (xs.length ? +(xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(2) : null);
    const buys = by("buy");
    return { picks_scored_20d: scored.length, buy_count: buys.length, buy_beat_zero_rate: buys.length ? +(buys.filter(p => p.outcomes.d20.retPct > 0).length / buys.length).toFixed(2) : null,
      buy_avg_20d_ret_pct: avg(buys.map(p => p.outcomes.d20.retPct)), skip_avg_20d_ret_pct: avg(by("skip").map(p => p.outcomes.d20.retPct)),
      direction_20d_accuracy: scored.length ? +(scored.filter(p => p.verdict?.answers?.direction_20d?.choice === dirOf(p.outcomes.d20.retPct, BAND20)).length / scored.length).toFixed(2) : null,
      recent: scored.slice(-8).map(p => ({ symbol: p.symbol, date: p.date, action: p.verdict?.answers?.action?.choice, ret_20d_pct: p.outcomes.d20.retPct })) };
  }

  async function verdictFor(c: { symbol: string; thesis: string; catalyst: string; sources: string[] }, day: string, s: MarketSettings, idx: Bar[]) {
    const q = await quote(c.symbol);
    // Leakage control: judge from closes up to the last finished session.
    const history = q.history.filter(b => b.date < day || q.at < Date.now() - 6 * 3600e3);
    const ind = indicators(history.length > 1 ? history : q.history, idx.filter(b => b.date <= (history.at(-1)?.date || day)));
    const headlines = (await newsSearch(`${c.symbol} stock`, 8).catch(() => [])).map(n => ({ title: n.title, source: n.source, date: n.published ? new Date(n.published).toISOString().slice(0, 10) : "" }));
    const state = { as_of: ind?.as_of || day, symbol: q.symbol, name: q.name, price: +q.price.toFixed(2), strategy: s.strategy, thesis: c.thesis, catalyst: c.catalyst, indicators: ind,
      index: { symbol: s.index, ...(indicators(idx) || {}) }, headlines, track_record: trackRecord() };
    const qs = questions(state.as_of), key = secret("JEV_API_KEY");
    let verdict: Verdict;
    try { verdict = key ? await askJev(key, state, qs, FALLBACK) : await askLlm(golem(), state, qs, FALLBACK); }
    catch (e: any) { verdict = key ? { ...(await askLlm(golem(), state, qs, FALLBACK)), error: `Jev failed (${e.message}); Golem's model answered.` } : { answers: {}, source: "llm", model: "", error: e.message }; }
    return { q, state, verdict };
  }

  let running = false;
  async function run(day = today(), who = "orb") {
    if (running) throw new HttpError(409, "Research is already running.");
    running = true;
    const s = marketSettings(records), id = day, g = golem();
    const save = (patch: Record<string, unknown>) => { const cur: any = records.get("research", id); const { id: _i, version: _v, ...rest } = cur || {}; return records.put("research", id, { ...rest, ...patch }); };
    save({ date: day, status: "news", startedAt: Date.now(), finishedAt: 0, error: "", by: who, promptVersion: PROMPT_VERSION });
    try {
      // 1. Deep research: the day's market-moving news.
      const news = await chat({ ...g, who: "market", tools: researchTools, maxRounds: 10, messages: [
        { role: "system", content: `You are a markets research analyst. Today is ${day}. Research what is moving US markets today: macro and rates, earnings season, geopolitics, sectors, big company news. Call news_search at least 5 times with different queries, and read_page on the 2–4 most important articles. Then write a report in Markdown: the key stories (one paragraph each, with the date and source link), which sectors they affect and why, and every ticker that comes up. Only report what the sources say; mark anything uncertain.` },
        { role: "user", content: "Write today's market news report." }] });
      save({ status: "stocks", newsReport: news.text });
      // 2. Stock news: individual companies in play.
      const stocks = await chat({ ...g, who: "market", tools: researchTools, maxRounds: 10, messages: [
        { role: "system", content: `You are a stock research analyst. Today is ${day}. Find individual US stocks in the news: earnings beats and misses, guidance changes, analyst upgrades and downgrades, M&A, product news, unusual movers. Call news_search at least 5 times (e.g. "stock upgrade", "earnings beat", "shares jump", "guidance raised") and stock_quote on the most interesting tickers. Write a Markdown report: for each stock, the ticker, what happened, the source link, and the price move.` },
        { role: "user", content: "Write today's stock news report." }] });
      save({ status: "candidates", stockReport: stocks.text });
      // 3. Candidates from both reports.
      const pickText = (await chat({ ...g, who: "market", tools: [], maxRounds: 1, messages: [
        { role: "system", content: `From the two research reports, choose up to ${s.maxPicks} US stock tickers worth a closer look under this strategy: ${s.strategy} Never include: ${s.avoid.join(", ") || "(none)"}. Respond ONLY with JSON: {"picks":[{"symbol":"TICKER","thesis":"one or two sentences","catalyst":"the specific news","sources":["link", "..."]}]}` },
        { role: "user", content: `NEWS REPORT:\n${news.text.slice(0, 12000)}\n\nSTOCK REPORT:\n${stocks.text.slice(0, 12000)}` }] })).text;
      let cands: any[] = []; try { cands = JSON.parse(/\{[\s\S]*\}/.exec(pickText)?.[0] || "{}").picks || []; } catch { /* none */ }
      const seen = new Set<string>(), list = cands.map(c => ({ symbol: cleanSymbol(c?.symbol), thesis: String(c?.thesis || "").slice(0, 600), catalyst: String(c?.catalyst || "").slice(0, 400),
        sources: (Array.isArray(c?.sources) ? c.sources : []).map(String).filter((u: string) => /^https?:\/\//.test(u)).slice(0, 5) }))
        .filter(c => c.symbol && !s.avoid.includes(c.symbol) && !seen.has(c.symbol) && seen.add(c.symbol)).slice(0, s.maxPicks);
      save({ status: "verdicts", candidates: list.map(c => c.symbol) });
      // 4. A verdict per candidate, saved as a pick waiting for you.
      const idx = (await quote(s.index).catch(() => null))?.history || [];
      const made: string[] = [], failed: string[] = [];
      for (const c of list) {
        try {
          const { q, state, verdict } = await verdictFor(c, day, s, idx);
          const pid = `${day}-${c.symbol}`;
          const pick = { date: day, symbol: q.symbol, name: q.name, thesis: c.thesis, catalyst: c.catalyst, sources: c.sources, priceAtPick: q.price, pickedAt: Date.now(),
            state, verdict, promptVersion: PROMPT_VERSION, decision: "pending", amount: 0, decidedAt: 0, outcomes: {} };
          // A second run the same day refreshes the verdict but keeps what you decided.
          const old: any = records.get("picks", pid);
          if (old) records.put("picks", pid, { ...pick, decision: old.decision, amount: old.amount, note: old.note || "", decidedAt: old.decidedAt, outcomes: old.outcomes || {}, priceAtPick: old.decision !== "pending" ? old.priceAtPick : pick.priceAtPick });
          else records.create("picks", pick, pid);
          made.push(q.symbol);
        } catch (e: any) { failed.push(`${c.symbol}: ${e.message}`); }
      }
      return save({ status: "done", finishedAt: Date.now(), picks: made, error: failed.join("; ") });
    } catch (e: any) { return save({ status: "failed", finishedAt: Date.now(), error: e.message }); }
    finally { running = false; }
  }

  /** Fill in what each pick did after 1, 5, 20 and 60 trading days. */
  async function updateOutcomes() {
    const open = (records.list("picks") as any[]).filter(p => !p.outcomes?.[`d${HORIZONS.at(-1)}`] && p.priceAtPick > 0);
    let n = 0;
    for (const sym of [...new Set(open.map(p => p.symbol))]) {
      let h: Bar[]; try { h = (await quote(sym, "2y")).history; } catch { continue; }
      for (const p of open.filter(x => x.symbol === sym)) {
        // Day 0 is the pick day's session (or the next one, for a pick made before the open or on a weekend).
        const start = h.findIndex(b => b.date >= p.date); if (start < 0) continue;
        const outcomes: Record<string, any> = { ...(p.outcomes || {}) };
        for (const k of HORIZONS) { const b = h[start + k]; if (b && !outcomes[`d${k}`]) outcomes[`d${k}`] = { date: b.date, close: +b.close.toFixed(2), retPct: +(((b.close / p.priceAtPick) - 1) * 100).toFixed(2) }; }
        if (JSON.stringify(outcomes) !== JSON.stringify(p.outcomes || {})) { records.patch("picks", p.id, { outcomes }); n++; }
      }
    }
    return { updated: n };
  }

  /** How the verdicts have done, against simple baselines, and what your
   *  yes and no decisions made or would have made. */
  function scorecard() {
    const s = marketSettings(records), all = records.list("picks") as any[];
    const money = (p: any, k: string) => (p.outcomes?.[k] ? ((p.amount || s.notional) * p.outcomes[k].retPct) / 100 : null);
    const sum = (xs: (number | null)[]) => +xs.filter((x): x is number => x !== null).reduce((a, b) => a + b, 0).toFixed(2);
    const horizons = HORIZONS.map(k => {
      const done = all.filter(p => p.outcomes?.[`d${k}`]);
      const yes = done.filter(p => p.decision === "yes"), no = done.filter(p => p.decision === "no");
      return { days: k, scored: done.length, yesPnl: sum(yes.map(p => money(p, `d${k}`))), noWouldHave: sum(no.map(p => money(p, `d${k}`))),
        buyAvgRet: done.filter(p => p.verdict?.answers?.action?.choice === "buy").length ? +(done.filter(p => p.verdict?.answers?.action?.choice === "buy").reduce((a, p) => a + p.outcomes[`d${k}`].retPct, 0) / done.filter(p => p.verdict?.answers?.action?.choice === "buy").length).toFixed(2) : null };
    });
    // Direction forecasts: accuracy and Brier score, against "always flat" and "momentum" (the sign of the last 20 days).
    const dir = (k: 5 | 20, band: number) => {
      const done = all.filter(p => p.outcomes?.[`d${k}`] && p.verdict?.answers?.[`direction_${k}d`]);
      if (!done.length) return { n: 0 };
      const actual = (p: any) => dirOf(p.outcomes[`d${k}`].retPct, band), a = (p: any) => p.verdict.answers[`direction_${k}d`];
      const brier = done.reduce((t, p) => t + ["up", "flat", "down"].reduce((u, l) => u + ((a(p).probabilities?.[l] ?? 0) - (actual(p) === l ? 1 : 0)) ** 2, 0), 0) / done.length;
      const mom = (p: any) => { const r = p.state?.indicators?.ret_20d_pct; return r == null ? "flat" : dirOf(r, band); };
      return { n: done.length, accuracy: +(done.filter(p => a(p).choice === actual(p)).length / done.length).toFixed(3), brier: +brier.toFixed(3),
        alwaysFlat: +(done.filter(p => actual(p) === "flat").length / done.length).toFixed(3), momentum: +(done.filter(p => mom(p) === actual(p)).length / done.length).toFixed(3) };
    };
    return { picks: all.length, pending: all.filter(p => p.decision === "pending").length, yes: all.filter(p => p.decision === "yes").length, no: all.filter(p => p.decision === "no").length,
      notional: s.notional, horizons, direction5d: dir(5, BAND5), direction20d: dir(20, BAND20), sources: { jev: all.filter(p => p.verdict?.source === "jev").length, llm: all.filter(p => p.verdict?.source === "llm").length } };
  }

  const you = (req: any) => { if (deps.who(req) !== "you") throw new HttpError(403, "Only a signed-in person can run research or decide on picks."); };
  app.post("/api/market/run", { preHandler: guard }, async (req: any, reply) => {
    you(req); if (running) throw new HttpError(409, "Research is already running.");
    run(today(), "you").catch(() => {}); reply.code(202); return { started: true };
  });
  app.post("/api/market/picks/:id/decide", { preHandler: guard }, async (req: any) => {
    you(req);
    const p: any = records.get("picks", req.params.id); if (!p) throw new HttpError(404, "No such pick.");
    const decision = String(req.body?.decision || ""), amount = Number(req.body?.amount ?? 0);
    if (!["yes", "no", "pending"].includes(decision)) throw new HttpError(422, "decision is yes, no or pending.");
    if (!(Number.isFinite(amount) && amount >= 0 && amount <= 1e7)) throw new HttpError(422, "amount is a dollar amount from 0 to 10,000,000.");
    return records.patch("picks", p.id, { decision, amount: Math.round(amount * 100) / 100, decidedAt: decision === "pending" ? 0 : Date.now(), note: String(req.body?.note || "").slice(0, 500) });
  });
  app.post("/api/market/outcomes", { preHandler: guard }, async () => updateOutcomes());
  app.get("/api/market/scorecard", { preHandler: guard }, async () => scorecard());
  app.get("/api/market/status", { preHandler: guard }, async () => ({ running, jev: !!secret("JEV_API_KEY"), settings: marketSettings(records) }));
  app.get("/api/market/chart/:symbol", { preHandler: guard }, async (req: any) => { const q = await quote(req.params.symbol); return { symbol: q.symbol, name: q.name, price: q.price, history: q.history.slice(-130) }; });

  let lastOutcomes = 0;
  async function tick() {
    const s = marketSettings(records), d = new Date(), day = today();
    if (Date.now() - lastOutcomes > 6 * 3600e3) { lastOutcomes = Date.now(); await updateOutcomes().catch(() => {}); }
    if (!s.on || running || records.get("research", day) || d.getHours() < s.hour || (s.weekdaysOnly && (d.getDay() === 0 || d.getDay() === 6))) return;
    await run(day);
  }
  return { run, updateOutcomes, scorecard, tick, trackRecord };
}
