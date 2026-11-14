import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Records } from "./records.js";
import { HttpError } from "./records.js";
import type { OrbConfig } from "./config.js";
import { secret } from "./config.js";
import { chat } from "./integrations/llm.js";
import { newsSearch, quote, cleanSymbol, type NewsItem } from "./integrations/daily.js";
import { localDay, today } from "./dates.js";

/** Stocks you watch and own:
 *  - news about one ticker, each headline rated good, bad or neutral for the
 *    stock by Golem's model (your own endpoint), with an overall read;
 *  - your Robinhood history from its account-activity CSV export, turned into
 *    positions (shares, average cost, gains) and a history list. Read only:
 *    nothing is sent to Robinhood. */

// ---------------- rated news ----------------
export type Rated = NewsItem & { rating: "good" | "bad" | "neutral" | ""; why: string };
const RATINGS = ["good", "bad", "neutral"] as const;
const rateCache = new Map<string, { at: number; v: unknown }>();

// ---------------- Robinhood CSV ----------------
/** RFC 4180: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], f = "", q = false;
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; } else if (c === "\n" || c === "\r") { if (c === "\r" && t[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; } else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
/** "$1,234.56" → 1234.56, "($1,234.56)" → -1234.56, "1.5S" → 1.5. */
const num = (s: string) => { const v = String(s || "").trim(); if (!v) return 0; const neg = /^\(.*\)$/.test(v) || v.startsWith("-"); const n = Number(v.replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? (neg ? -n : n) : 0; };
const isoDate = (s: string) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || "").trim()); return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : /^\d{4}-\d{2}-\d{2}$/.test(String(s).trim()) ? String(s).trim() : ""; };

export type Trade = { date: string; symbol: string; code: string; description: string; quantity: number; price: number; amount: number };
/** Rows from Robinhood's account activity report (Activity Date, Instrument, Description, Trans Code, Quantity, Price, Amount). */
export function robinhoodRows(text: string): Trade[] {
  const rows = parseCsv(text); if (!rows.length) return [];
  const head = rows[0].map(h => h.trim().toLowerCase()), col = (n: string) => head.indexOf(n);
  const at = { date: col("activity date"), sym: col("instrument"), desc: col("description"), code: col("trans code"), qty: col("quantity"), price: col("price"), amt: col("amount") };
  if (at.date < 0 || at.code < 0 || at.amt < 0) throw new HttpError(422, "That isn't Robinhood's account activity CSV (it needs Activity Date, Trans Code and Amount columns). In Robinhood: Account → Reports and statements → Reports, and download an activity report.");
  return rows.slice(1).map(r => ({ date: isoDate(r[at.date]), symbol: cleanSymbol(r[at.sym] || ""), code: String(r[at.code] || "").trim().toUpperCase(), description: String(r[at.desc] || "").replace(/\s+/g, " ").trim().slice(0, 200),
    quantity: Math.abs(num(r[at.qty])), price: Math.abs(num(r[at.price])), amount: num(r[at.amt]) })).filter(t => t.date && t.code); // the disclaimer at the end has no date
}

export type Position = { symbol: string; shares: number; avgCost: number; cost: number; realized: number; dividends: number; price: number | null; value: number | null; unrealized: number | null; unrealizedPct: number | null };
/** Positions by average cost, oldest row first. Splits add shares at no cost. */
export function positions(trades: Trade[]) {
  const by = new Map<string, Position>();
  const p = (s: string) => { let x = by.get(s); if (!x) { x = { symbol: s, shares: 0, avgCost: 0, cost: 0, realized: 0, dividends: 0, price: null, value: null, unrealized: null, unrealizedPct: null }; by.set(s, x); } return x; };
  for (const t of [...trades].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!t.symbol) continue;
    const x = p(t.symbol);
    if (t.code === "BUY") { x.shares += t.quantity; x.cost += Math.abs(t.amount) || t.quantity * t.price; }
    else if (t.code === "SELL") { const avg = x.shares ? x.cost / x.shares : 0, q = Math.min(t.quantity, x.shares); x.realized += (Math.abs(t.amount) || t.quantity * t.price) - avg * q; x.cost -= avg * q; x.shares -= q; }
    else if (t.code === "CDIV" || t.code === "MDIV") x.dividends += t.amount;
    else if (t.code === "SPL" || t.code === "SPR") x.shares += t.code === "SPR" ? -t.quantity : t.quantity;
  }
  for (const x of by.values()) { if (x.shares < 1e-6) { x.shares = 0; x.cost = 0; } x.avgCost = x.shares ? x.cost / x.shares : 0;
    for (const k of ["shares", "cost", "avgCost", "realized", "dividends"] as const) x[k] = +x[k].toFixed(k === "shares" ? 6 : 2); }
  return [...by.values()];
}

export function stocksApi(app: FastifyInstance, deps: { records: Records; cfg: () => OrbConfig; guard: any; who: (req: any) => string }) {
  const { records, cfg, guard } = deps;
  const you = (req: any) => { if (deps.who(req) !== "you") throw new HttpError(403, "Only a signed-in person can change this."); };
  const trades = () => (records.list("trades") as any[]) as (Trade & { id: string })[];

  /** Your position in one stock, from the Robinhood history (null if none). */
  function positionOf(symbol: string) { const x = positions(trades().filter(t => t.symbol === symbol))[0]; return x && (x.shares || x.realized || x.dividends) ? x : null; }

  /** Recent news about a ticker, each headline rated for the stock by the model. */
  async function rated(symbol: string) {
    const items = await newsSearch(`${symbol} stock`, 12), key = `${symbol}:${today()}:${items.map(i => i.link).join("|")}`;
    const hit = rateCache.get(key); if (hit && Date.now() - hit.at < 30 * 60000) return hit.v as { items: Rated[]; overall: string; summary: string; model: string; error: string };
    const g = cfg().golem, base: Rated[] = items.map(i => ({ ...i, rating: "", why: "" }));
    let out = { items: base, overall: "", summary: "", model: g.model || "", error: "" };
    if (items.length) try {
      const list = items.map((i, k) => `${k + 1}. ${i.title} (${i.source}${i.published ? `, ${localDay(i.published)}` : ""})`).join("\n");
      const r = await chat({ baseUrl: g.baseUrl, model: g.model, key: secret(g.keyEnv), who: "market", tools: [], maxRounds: 1, messages: [
        { role: "system", content: "You rate news headlines for what they likely mean for one stock's price over the next few weeks. For each headline answer good, bad or neutral for the stock, with a short reason (under 15 words). Judge only from the headline; when it isn't clearly about the company or its prospects, say neutral. Then give an overall read (good, bad, mixed or neutral) and one or two sentences. Answer with JSON only." },
        { role: "user", content: `Stock: ${symbol}\nHeadlines:\n${list}\n\nRespond ONLY with JSON: {"items":[{"n":1,"rating":"good|bad|neutral","why":"..."}],"overall":"good|bad|mixed|neutral","summary":"..."}` }] });
      const j = JSON.parse(/\{[\s\S]*\}/.exec(r.text)?.[0] || "{}");
      for (const x of Array.isArray(j.items) ? j.items : []) { const k = Number(x?.n) - 1; if (base[k] && (RATINGS as readonly string[]).includes(x.rating)) { base[k].rating = x.rating; base[k].why = String(x.why || "").slice(0, 160); } }
      out = { ...out, items: base, overall: ["good", "bad", "mixed", "neutral"].includes(j.overall) ? j.overall : "", summary: String(j.summary || "").slice(0, 500) };
    } catch (e: any) { out.error = `Couldn't rate the news: ${e.message}`; }
    rateCache.set(key, { at: Date.now(), v: out });
    return out;
  }

  app.get("/api/market/news/:symbol", { preHandler: guard }, async (req: any) => {
    const symbol = cleanSymbol(req.params.symbol); if (!symbol) throw new HttpError(400, "That isn't a ticker.");
    const [q, news] = await Promise.all([quote(symbol).catch(() => null), rated(symbol)]);
    return { symbol, name: q?.name || symbol, price: q?.price ?? null, changePct: q ? +q.changePct.toFixed(2) : null, position: positionOf(symbol), ...news };
  });

  // Robinhood's CSV: its own body parser, only on this route, after sign-in.
  app.register(async scope => {
    scope.addContentTypeParser(/^text\/(csv|plain)$/, { parseAs: "string", bodyLimit: 10 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    scope.post("/api/robinhood/csv", { onRequest: [guard, async (req: any) => you(req)], bodyLimit: 10 * 1024 * 1024 }, async (req: any) => {
      const rows = robinhoodRows(String(req.body || "")); if (!rows.length) throw new HttpError(422, "No activity rows in that file.");
      let added = 0;
      // Each row gets an id from its content (and how many identical rows came before it), so importing an overlapping export adds nothing twice.
      const seen = new Map<string, number>();
      for (const t of rows) {
        const base = createHash("sha1").update(JSON.stringify([t.date, t.symbol, t.code, t.description, t.quantity, t.price, t.amount])).digest("hex").slice(0, 20), n = (seen.get(base) || 0) + 1; seen.set(base, n);
        const id = `rh-${base}-${n}`;
        if (!records.get("trades", id)) { records.create("trades", { ...t, source: "robinhood-csv" }, id, "import"); added++; }
      }
      const dates = rows.map(r => r.date).sort();
      return { rows: rows.length, added, skipped: rows.length - added, from: dates[0], to: dates.at(-1) };
    });
  });

  app.get("/api/trades/summary", { preHandler: guard }, async () => {
    const all = trades(), pos = positions(all), held = pos.filter(p => p.shares > 0);
    await Promise.all(held.map(async p => { try { const q = await quote(p.symbol); p.price = q.price; p.value = +(q.price * p.shares).toFixed(2); p.unrealized = +(p.value - p.cost).toFixed(2); p.unrealizedPct = p.cost ? +((p.unrealized / p.cost) * 100).toFixed(2) : null; } catch { /* no price */ } }));
    const dates = all.map(t => t.date).sort(), sum = (f: (p: Position) => number | null) => +pos.reduce((a, p) => a + (f(p) ?? 0), 0).toFixed(2);
    return { count: all.length, from: dates[0] || "", to: dates.at(-1) || "",
      positions: held.sort((a, b) => (b.value ?? b.cost) - (a.value ?? a.cost)), closed: pos.filter(p => !p.shares && (p.realized || p.dividends)).sort((a, b) => b.realized - a.realized),
      totals: { cost: sum(p => (p.shares ? p.cost : 0)), value: sum(p => p.value), unrealized: sum(p => p.unrealized), realized: sum(p => p.realized), dividends: sum(p => p.dividends) },
      history: [...all].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 300).map(({ id: _i, ...t }: any) => t) };
  });
  app.delete("/api/trades", { preHandler: guard }, async (req: any, reply) => { you(req); for (const t of trades()) records.remove("trades", t.id, "import"); reply.code(204).send(); });

  return { positionOf };
}
