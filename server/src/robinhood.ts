import type { FastifyInstance } from "fastify";
import type { Records } from "./records.js";
import type { Store } from "./db.js";
import { HttpError } from "./records.js";
import { McpClient, discover, authorizeUrl, exchange, refresh, type OAuthState, type McpTool } from "./integrations/mcpclient.js";
import { quote } from "./integrations/daily.js";
import { today } from "./dates.js";

/** Robinhood's Trading MCP: Orb signs in with OAuth (you approve it on
 *  Robinhood) and can then read your agentic account and place orders in it.
 *
 *  Safety, all enforced here on the server:
 *  - only a signed-in person can connect, see tools or place an order; Golem
 *    and API-token agents never get these tools;
 *  - placing orders is off until you turn it on in Settings;
 *  - an order is only for a pick you said "I'm buying" to, for that pick's
 *    ticker, a buy, and within the per-order and per-day dollar caps;
 *  - you see the exact order Orb will send and confirm it each time;
 *  - every order and Robinhood's answer is kept in "orders".
 *  Robinhood also keeps agent trades in a separate account you fund, and
 *  has its own "Trade approvals" setting: turn it on for a second check. */
export const RH_MCP = "https://agent.robinhood.com/mcp/trading";
export type RhSettings = { tradingOn: boolean; maxOrder: number; maxDay: number; orderTool: string; accountTool: string; url: string };
export const rhSettings = (records: Records): RhSettings => {
  const s: any = (records.get("settings", "app") as any)?.robinhood || {};
  return { tradingOn: s.tradingOn === true, maxOrder: Math.max(1, Number(s.maxOrder) || 100), maxDay: Math.max(1, Number(s.maxDay) || 300),
    orderTool: String(s.orderTool || ""), accountTool: String(s.accountTool || ""),
    // https only (plain http just for a server on this machine, e.g. a test double).
    url: /^https:\/\//.test(s.url || "") || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(s.url || "") ? s.url : RH_MCP };
};

const AMOUNT = /^(amount|notional|dollar_?amount|dollars|amount_?usd|cash_?amount|notional_?amount|dollar_?value)$/i;
const QTY = /^(quantity|qty|shares|share_?quantity)$/i;
const SYMBOL = /^(symbol|ticker|instrument_?symbol|stock_?symbol|stock)$/i;
const SIDE = /^(side|direction|action|order_?side)$/i;
const TYPE = /^(type|order_?type)$/i;
const TIF = /^(time_?in_?force|tif)$/i;
const enumPick = (p: any, re: RegExp, dflt: string) => (Array.isArray(p?.enum) ? p.enum.find((x: string) => re.test(String(x))) ?? dflt : dflt);

/** Order arguments for a tool's input schema, from a pick and an amount. */
export function buildOrder(tool: McpTool, symbol: string, amount: number, price: number) {
  const props: Record<string, any> = tool.inputSchema?.properties || {}, req: string[] = tool.inputSchema?.required || [], args: Record<string, unknown> = {}, warnings: string[] = [];
  const hasAmount = Object.keys(props).some(k => AMOUNT.test(k));
  for (const [k, p] of Object.entries(props)) {
    if (SYMBOL.test(k)) args[k] = symbol;
    else if (SIDE.test(k)) args[k] = enumPick(p, /^buy$/i, "buy");
    else if (TYPE.test(k)) args[k] = enumPick(p, /market/i, "market");
    else if (AMOUNT.test(k)) args[k] = p?.type === "string" ? amount.toFixed(2) : +amount.toFixed(2);
    else if (QTY.test(k) && !hasAmount) { const q = +(amount / price).toFixed(6); args[k] = p?.type === "string" ? String(q) : q; warnings.push(`This tool takes shares, so ${money(amount)} at ${money(price)} is ${q} shares; the price may move before it fills.`); }
    else if (TIF.test(k)) args[k] = enumPick(p, /^(gfd|day)$/i, "gfd");
    else if (Array.isArray(p?.enum) && p.enum.length === 1) args[k] = p.enum[0];
  }
  for (const k of req) if (!(k in args)) warnings.push(`Robinhood needs “${k}”${props[k]?.description ? ` (${props[k].description})` : ""}; fill it in before sending.`);
  return { args, warnings };
}
const money = (n: number) => `$${n.toFixed(2)}`;
/** Dollars an order is for, read back from its arguments (amount, or shares × price). */
export function orderDollars(args: Record<string, unknown>, price: number) {
  for (const [k, v] of Object.entries(args)) if (AMOUNT.test(k)) return Number(v);
  for (const [k, v] of Object.entries(args)) if (QTY.test(k)) return Number(v) * price;
  return NaN;
}

export function robinhoodApi(app: FastifyInstance, deps: { records: Records; store: Store; guard: any; who: (req: any) => string }) {
  const { records, store, guard } = deps;
  // Tokens stay in the server's own store, never in a collection the API can read.
  const load = () => (store.get("secrets", "robinhood") as any as OAuthState & { id?: string; version?: number }) || null;
  const keep = (o: OAuthState | null) => { if (!o) store.delete("secrets", "robinhood"); else { const { id: _i, version: _v, ...rest } = o as any; store.set("secrets", "robinhood", rest); } };
  const pending = new Map<string, { verifier: string; at: number; o: OAuthState }>();
  let lastError = "";
  const token = async () => {
    let o = load(); if (!o?.access) throw new HttpError(409, "Robinhood isn't connected. Connect it in Settings → Robinhood.");
    if ((o.expiresAt || 0) < Date.now() + 60000) { o = await refresh(o); keep(o); }
    return o.access!;
  };
  const client = new McpClient(() => rhSettings(records).url, token, async () => { const o = load(); if (o) keep(await refresh(o)); });
  let toolCache: { at: number; tools: McpTool[] } | null = null;
  const tools = async () => { if (toolCache && Date.now() - toolCache.at < 10 * 60000) return toolCache.tools; const t = await client.tools(); toolCache = { at: Date.now(), tools: t }; return t; };
  const you = (req: any) => { if (deps.who(req) !== "you") throw new HttpError(403, "Only a signed-in person can use Robinhood from Orb."); };
  const guess = (ts: McpTool[], re: RegExp, not?: RegExp) => ts.find(t => re.test(t.name) && !(not && not.test(t.name)))?.name || "";

  app.get("/api/robinhood/status", { preHandler: guard }, async (req: any) => {
    you(req);
    const o = load(), s = rhSettings(records);
    return { connected: !!o?.access, url: s.url, tradingOn: s.tradingOn, maxOrder: s.maxOrder, maxDay: s.maxDay, orderTool: s.orderTool, accountTool: s.accountTool, lastError,
      spentToday: (records.list("orders") as any[]).filter(x => x.day === today() && !x.isError).reduce((a, x) => a + (x.dollars || 0), 0) };
  });
  app.post("/api/robinhood/connect", { preHandler: guard }, async (req: any) => {
    you(req);
    // Robinhood sends you back to this Orb; behind a tunnel use its https address.
    const proto = String(req.headers["x-forwarded-proto"] || req.protocol).split(",")[0], host = String(req.headers["x-forwarded-host"] || req.headers.host).split(",")[0];
    const o = await discover(rhSettings(records).url, `${proto}://${host}/api/robinhood/callback`);
    const a = authorizeUrl(o); pending.set(a.state, { verifier: a.verifier, at: Date.now(), o });
    for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60000) pending.delete(k);
    return { url: a.url };
  });
  // No cookie check here: the SameSite cookie isn't sent on the way back
  // from Robinhood. The one-time `state` from /connect proves who started it.
  app.get("/api/robinhood/callback", async (req: any, reply) => {
    const p = pending.get(String(req.query.state || "")); pending.delete(String(req.query.state || ""));
    if (!p || Date.now() - p.at > 10 * 60000) return reply.code(400).type("text/html").send("<p>That sign-in link has expired. Go back to Orb and press Connect again.</p>");
    if (req.query.error) { lastError = String(req.query.error_description || req.query.error); return reply.redirect("/#config"); }
    try { keep(await exchange(p.o, String(req.query.code || ""), p.verifier)); client.reset(); toolCache = null; lastError = ""; }
    catch (e: any) { lastError = e.message; }
    return reply.redirect("/#config");
  });
  app.post("/api/robinhood/disconnect", { preHandler: guard }, async (req: any) => { you(req); keep(null); client.reset(); toolCache = null; return { ok: true }; });
  app.get("/api/robinhood/tools", { preHandler: guard }, async (req: any) => {
    you(req);
    const t = await tools();
    return { tools: t.map(x => ({ name: x.name, description: x.description || "", readOnly: !!x.annotations?.readOnlyHint, schema: x.inputSchema })),
      guess: { orderTool: guess(t, /(place|create|submit).*order|order.*(place|create|submit)|^buy/i, /cancel|get|list/i), accountTool: guess(t, /account|portfolio|buying_?power|positions/i, /order/i) } };
  });
  /** The agentic account, through the tool you picked (read only). */
  app.get("/api/robinhood/account", { preHandler: guard }, async (req: any) => {
    you(req);
    const s = rhSettings(records), t = (await tools()).find(x => x.name === s.accountTool);
    if (!t) throw new HttpError(409, "Pick the account tool in Settings → Robinhood.");
    if (t.annotations?.destructiveHint) throw new HttpError(403, "That tool can change things; Orb only reads the account with a read-only tool.");
    return client.call(t.name, {});
  });

  async function forPick(id: string) {
    const p: any = records.get("picks", id); if (!p) throw new HttpError(404, "No such pick.");
    if (p.decision !== "yes") throw new HttpError(409, "Say “I'm buying” on this pick first.");
    return p;
  }
  app.post("/api/robinhood/order/preview", { preHandler: guard }, async (req: any) => {
    you(req);
    const s = rhSettings(records), p = await forPick(String(req.body?.pickId || "")), amount = Number(req.body?.amount ?? p.amount);
    const t = (await tools()).find(x => x.name === s.orderTool); if (!t) throw new HttpError(409, "Pick the order tool in Settings → Robinhood.");
    const price = (await quote(p.symbol)).price, b = buildOrder(t, p.symbol, amount, price);
    return { tool: t.name, description: t.description || "", schema: t.inputSchema, args: b.args, warnings: b.warnings, price, tradingOn: s.tradingOn, maxOrder: s.maxOrder, maxDay: s.maxDay };
  });
  app.post("/api/robinhood/order", { preHandler: guard }, async (req: any) => {
    you(req);
    const s = rhSettings(records);
    if (!s.tradingOn) throw new HttpError(403, "Placing orders is off. Turn it on in Settings → Robinhood.");
    if (req.body?.confirm !== true) throw new HttpError(400, "Confirm the order first.");
    const p = await forPick(String(req.body?.pickId || "")), args = req.body?.args;
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new HttpError(400, "Send the order's arguments.");
    const t = (await tools()).find(x => x.name === s.orderTool); if (!t || req.body?.tool !== t.name) throw new HttpError(409, "That isn't the order tool chosen in Settings.");
    // The order must be what the pick says: its ticker, a buy, within the caps.
    for (const [k, v] of Object.entries(args)) {
      if (SYMBOL.test(k) && String(v).toUpperCase() !== p.symbol) throw new HttpError(422, `This pick is ${p.symbol}, not ${v}.`);
      if (SIDE.test(k) && !/^buy$/i.test(String(v))) throw new HttpError(422, "Orb only places buys for picks; sell on Robinhood.");
    }
    if (!Object.keys(args).some(k => SYMBOL.test(k))) throw new HttpError(422, "The order has no ticker Orb can check.");
    const price = (await quote(p.symbol)).price, dollars = orderDollars(args, price);
    if (!(dollars > 0)) throw new HttpError(422, "Orb can't tell how many dollars this order is for, so it won't send it.");
    if (dollars > s.maxOrder * 1.02) throw new HttpError(422, `${money(dollars)} is over your per-order cap of ${money(s.maxOrder)}.`);
    const spent = (records.list("orders") as any[]).filter(x => x.day === today() && !x.isError).reduce((a, x) => a + (x.dollars || 0), 0);
    if (spent + dollars > s.maxDay * 1.02) throw new HttpError(422, `That would make ${money(spent + dollars)} today, over your daily cap of ${money(s.maxDay)}.`);
    // Write the order down before sending it, so nothing is ever sent unrecorded.
    const o: any = records.create("orders", { day: today(), at: Date.now(), pickId: p.id, symbol: p.symbol, dollars: +dollars.toFixed(2), price, tool: t.name, args, status: "sending", isError: false, result: "" });
    let r: { isError: boolean; text: string; structured?: unknown };
    try { r = await client.call(t.name, args); } catch (e: any) { r = { isError: true, text: e.message }; }
    const done = records.patch("orders", o.id, { status: r.isError ? "failed" : "sent", isError: r.isError, result: r.text.slice(0, 4000), structured: r.structured ?? null });
    records.patch("picks", p.id, { orderId: o.id, orderStatus: r.isError ? "failed" : "sent" });
    if (r.isError) throw new HttpError(502, `Robinhood didn't take the order: ${r.text.slice(0, 300)}`);
    return done;
  });
  return { tools };
}
