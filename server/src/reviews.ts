import type { FastifyInstance } from "fastify";
import type { Records } from "./records.js";
import { HttpError } from "./records.js";
import type { OrbConfig } from "./config.js";
import { secret } from "./config.js";
import { askJev, askLlm, type Question, type Verdict } from "./integrations/jev.js";
import { quote, cleanSymbol } from "./integrations/daily.js";
import { indicators } from "./integrations/research.js";
import { ratedNews, coinpileHoldings } from "./stocks.js";
import { marketSettings } from "./market.js";
import { dailySettings } from "./daily.js";
import { today } from "./dates.js";

/** Stock reviews: at the times you set (or when you ask), every stock you
 *  hold (from Coinpile) and every stock on your watchlist gets
 *  - its recent news, read and rated by Golem's model (a chat model), then
 *  - a decision from your decision model (Jev-format or OpenAI-compatible,
 *    self-hosted): add / hold / trim / sell for what you hold, buy / watch /
 *    skip for the rest, with a 20-day direction and how strong the case is.
 *  Ideas only: nothing trades. Kept in "reviews" (id = date + time). */

export type ReviewSettings = { on: boolean; times: string[]; weekdaysOnly: boolean; include: "both" | "holdings" | "watchlist"; max: number };
export const REVIEW_DEFAULTS: ReviewSettings = { on: false, times: ["08:45", "12:30", "15:45"], weekdaysOnly: true, include: "both", max: 12 };
export const reviewSettings = (records: Records): ReviewSettings => {
  const r: any = ((records.get("settings", "app") as any)?.market || {}).reviews || {};
  const times = (Array.isArray(r.times) ? r.times : REVIEW_DEFAULTS.times).map(String).filter((t: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)).sort().slice(0, 8);
  return { on: r.on === true, times: times.length ? [...new Set<string>(times)] : REVIEW_DEFAULTS.times, weekdaysOnly: r.weekdaysOnly !== false,
    include: ["holdings", "watchlist"].includes(r.include) ? r.include : "both", max: Math.max(1, Math.min(30, Math.round(+r.max) || REVIEW_DEFAULTS.max)) };
};

const HELD: Record<string, Question> = {
  action: { instructions: "You hold this stock. Using only the state (prices through as_of, the rated news, your position), decide what to do with the position over the next few weeks.",
    criteria: { add: "Buy more: the case got clearly stronger.", hold: "Keep it as it is.", trim: "Sell part: risk went up or the gain is worth locking in.", sell: "Sell it all: the case is broken." } },
};
const NEW: Record<string, Question> = {
  action: { instructions: "You don't hold this stock. Using only the state, decide whether it is worth buying now for a holding period of a few weeks.",
    criteria: { buy: "Worth buying now.", watch: "Interesting, but wait for a better entry or more news.", skip: "Not worth it now." } },
};
const COMMON: Record<string, Question> = {
  direction_20d: { instructions: "Forecast the close 20 trading days after as_of compared with the as_of close.", criteria: { up: "More than +3%.", flat: "Between -3% and +3%.", down: "Less than -3%." } },
  conviction: { instructions: "How strong is the case for the action you chose?", criteria: { weak: "Mostly a guess.", fair: "Some real evidence.", strong: "Clear evidence from several sources." } },
};

export function reviewsApi(app: FastifyInstance, deps: { records: Records; cfg: () => OrbConfig; guard: any; who: (req: any) => string }) {
  const { records, cfg, guard } = deps;
  const golem = () => { const g = cfg().golem; return { baseUrl: g.baseUrl, model: g.model, key: secret(g.keyEnv) }; };
  let running = "";

  async function run(slot: string, by = "orb") {
    if (running) throw new HttpError(409, "A review is already running.");
    const day = today(), id = `${day}T${slot.replace(":", "")}`, r = reviewSettings(records), m = marketSettings(records), d = dailySettings(records);
    running = id;
    const save = (p: Record<string, unknown>) => { const cur: any = records.get("reviews", id); const { id: _i, version: _v, ...rest } = cur || {}; return records.put("reviews", id, { ...rest, ...p }); };
    save({ date: day, slot, by, status: "running", startedAt: Date.now(), items: [], note: "" });
    try {
      const { positions, note } = await coinpileHoldings(String((records.get("settings", "apps") as any)?.yaml || ""));
      const held = new Map((positions || []).map(p => [p.symbol, p]));
      const syms = [...new Set([...(r.include !== "watchlist" ? [...held.keys()] : []), ...(r.include !== "holdings" ? d.watchlist.map(cleanSymbol).filter(Boolean) : [])])].slice(0, r.max);
      const idx = (await quote(m.index).catch(() => null))?.history || [];
      const items: any[] = [];
      for (const sym of syms) {
        try {
          const [q, news] = await Promise.all([quote(sym), ratedNews(sym, golem())]);
          const ind = indicators(q.history, idx), pos = held.get(sym);
          const state = { as_of: ind?.as_of || day, symbol: sym, name: q.name, price: +q.price.toFixed(2), strategy: m.strategy, indicators: ind, index: { symbol: m.index, ...(indicators(idx) || {}) },
            news: { overall: news.overall, summary: news.summary, headlines: news.items.slice(0, 10).map(i => ({ title: i.title, rating: i.rating, why: i.why })) },
            ...(pos ? { you_own: { shares: pos.shares, avg_cost: pos.avgCost, gain_pct: pos.cost && pos.value != null ? +(((q.price * pos.shares) / pos.cost - 1) * 100).toFixed(2) : null } } : {}) };
          const qs = { ...(pos ? HELD : NEW), ...COMMON }, fb = { action: pos ? "hold" : "watch", direction_20d: "flat", conviction: "weak" }, dc = m.decider;
          let verdict: Verdict;
          try { verdict = dc.kind === "jev" && dc.baseUrl ? await askJev(dc.baseUrl, secret(dc.keyEnv), state, qs, fb, dc.model) : await askLlm(dc.baseUrl ? { baseUrl: dc.baseUrl, model: dc.model, key: secret(dc.keyEnv) } : golem(), state, qs, fb); }
          catch (e: any) { verdict = { answers: {}, source: dc.kind === "jev" ? "jev" : "llm", model: dc.model, error: e.message }; }
          items.push({ symbol: sym, name: q.name, held: !!pos, shares: pos?.shares ?? null, price: q.price, changePct: +q.changePct.toFixed(2), verdict,
            news: { overall: news.overall, summary: news.summary, error: news.error, top: news.items.filter(i => i.rating && i.rating !== "neutral").slice(0, 3).map(i => ({ title: i.title, link: i.link, rating: i.rating })) } });
        } catch (e: any) { items.push({ symbol: sym, held: held.has(sym), error: e.message }); }
        save({ items });
      }
      return save({ status: "done", finishedAt: Date.now(), items, note: !positions && r.include !== "watchlist" ? note : syms.length ? "" : "Nothing to review: no holdings from Coinpile and an empty watchlist." });
    } catch (e: any) { return save({ status: "failed", finishedAt: Date.now(), error: e.message }); }
    finally { running = ""; }
  }

  const you = (req: any) => { if (deps.who(req) !== "you") throw new HttpError(403, "Only a signed-in person can run a review."); };
  app.post("/api/market/review", { preHandler: guard }, async (req: any, reply) => {
    you(req); if (running) throw new HttpError(409, "A review is already running.");
    const d = new Date(), slot = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    run(slot, "you").catch(() => {}); reply.code(202); return { started: true, id: `${today()}T${slot.replace(":", "")}` };
  });
  /** The latest reviews, newest first (?limit=, at most 30). */
  app.get("/api/market/reviews", { preHandler: guard }, async (req: any) => {
    const n = Math.max(1, Math.min(30, Number(req.query.limit) || 5));
    return { running, settings: reviewSettings(records), reviews: (records.list("reviews") as any[]).sort((a, b) => String(b.id).localeCompare(String(a.id))).slice(0, n) };
  });

  /** Run a slot once its time has come (and not more than two hours late, e.g. after a restart). */
  async function tick() {
    const r = reviewSettings(records), d = new Date(), day = today();
    if (!r.on || running || (r.weekdaysOnly && (d.getDay() === 0 || d.getDay() === 6))) return;
    const now = d.getHours() * 60 + d.getMinutes();
    for (const slot of r.times) {
      const [h, mi] = slot.split(":").map(Number), at = h * 60 + mi;
      if (now >= at && now - at <= 120 && !records.get("reviews", `${day}T${slot.replace(":", "")}`)) { await run(slot); return; }
    }
  }
  return { run, tick };
}
