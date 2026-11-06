import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { sources, clearDailyCache } from "../src/integrations/daily.js";
import { buildOrder, orderDollars } from "../src/robinhood.js";

const cfg = () => loadConfig("/nonexistent.yaml", {});

/** A fake Robinhood: OAuth (metadata, registration, PKCE token) and a Trading MCP. */
function fakeRobinhood() {
  const calls: any[] = []; let verifierChallenge = "", base = "";
  const tools = [
    { name: "get_account", description: "Agentic account balances", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
    { name: "place_equity_order", description: "Place a stock order", inputSchema: { type: "object", required: ["symbol", "side", "order_type", "dollar_amount"],
      properties: { symbol: { type: "string" }, side: { type: "string", enum: ["buy", "sell"] }, order_type: { type: "string", enum: ["market", "limit"] }, dollar_amount: { type: "number" }, time_in_force: { type: "string", enum: ["gfd", "gtc"] } } } },
  ];
  const s = createServer((req, res) => {
    let body = ""; req.on("data", d => (body += d)); req.on("end", () => {
      const u = new URL(req.url!, "http://x"), J = (code: number, o: unknown, h: Record<string, string> = {}) => { res.writeHead(code, { "content-type": "application/json", ...h }); res.end(JSON.stringify(o)); };
      if (u.pathname.startsWith("/.well-known/oauth-protected-resource")) return J(200, { resource: `${base}/mcp/trading`, authorization_servers: [`${base}/oauth`] });
      if (u.pathname === "/.well-known/oauth-authorization-server/oauth") return J(200, { authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register` });
      if (u.pathname === "/oauth/register") return J(201, { client_id: "orb-client" });
      if (u.pathname === "/oauth/token") {
        const f = new URLSearchParams(body);
        if (f.get("grant_type") === "authorization_code" && f.get("code") === "good" && createHash("sha256").update(f.get("code_verifier")!).digest("base64url") === verifierChallenge)
          return J(200, { access_token: "tok", refresh_token: "ref", expires_in: 3600 });
        return J(400, { error: "invalid_grant" });
      }
      if (u.pathname === "/mcp/trading") {
        if (req.headers.authorization !== "Bearer tok") return J(401, {}, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp/trading"` });
        const m = JSON.parse(body);
        if (m.id === undefined) { res.writeHead(202); return res.end(); }
        if (m.method === "initialize") return J(200, { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } }, { "mcp-session-id": "s1" });
        if (m.method === "tools/list") { res.writeHead(200, { "content-type": "text/event-stream" }); return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools } })}\n\n`); }
        if (m.method === "tools/call") { calls.push(m.params); return J(200, { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: m.params.name === "get_account" ? "Buying power: $1,000" : "Order queued: id abc" }] } }); }
      }
      if (u.pathname.startsWith("/chart/")) { const ts = [1, 2, 3].map(i => 1.7e9 + i * 864e2); return J(200, { chart: { result: [{ meta: { regularMarketPrice: 50, chartPreviousClose: 49 }, timestamp: ts, indicators: { quote: [{ close: [48, 49, 50] }] } }] } }); }
      J(404, {});
    });
  });
  return new Promise<{ base: string; close: () => void; calls: any[]; setChallenge: (c: string) => void }>(ok => s.listen(0, "127.0.0.1", () => {
    base = `http://127.0.0.1:${(s.address() as any).port}`; ok({ base, close: () => s.close(), calls, setChallenge: c => (verifierChallenge = c) });
  }));
}

test("TestRobinhood_BuildsOrderFromSchema", () => {
  const t: any = { name: "x", inputSchema: { required: ["ticker", "qty", "account_id"], properties: { ticker: {}, qty: { type: "number" }, side: { enum: ["BUY", "SELL"] }, account_id: { type: "string" } } } };
  const b = buildOrder(t, "ACME", 100, 40);
  assert.deepEqual(b.args, { ticker: "ACME", qty: 2.5, side: "BUY" });
  assert.match(b.warnings.join(" "), /account_id/); assert.match(b.warnings.join(" "), /shares/);
  assert.equal(orderDollars({ qty: 2.5 }, 40), 100); assert.equal(orderDollars({ dollar_amount: 75 }, 40), 75);
});

test("TestRobinhood_ConnectsAndPlacesGuardedOrders", async () => {
  const rh = await fakeRobinhood(), was = { ...sources };
  sources.yahoo = rh.base + "/chart"; clearDailyCache();
  try {
    const built = await buildApp({ config: cfg(), tokens: "bot:t", password: "pw" }), records = built.records;
    const login = await built.app.inject({ method: "POST", url: "/api/login", payload: { password: "pw" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    // Requests as you (signed in), unless the test sends its own Authorization.
    const app = { inject: (o: any) => built.app.inject({ ...o, headers: { ...(o.headers?.authorization ? {} : { cookie }), ...(o.headers || {}) } }) };
    const put = (o: any) => app.inject({ method: "PUT", url: "/api/c/settings/app", payload: { robinhood: { url: `${rh.base}/mcp/trading`, ...o } } });
    await put({});
    // Agents can't touch any of it.
    assert.equal((await app.inject({ method: "POST", url: "/api/robinhood/connect", headers: { authorization: "Bearer t" } })).statusCode, 403);
    // Connect: discovery, registration, then the person signs in at Robinhood and comes back with a code.
    const c = await app.inject({ method: "POST", url: "/api/robinhood/connect", headers: { host: "orb.local:8095" } });
    assert.equal(c.statusCode, 200, c.body);
    const auth = new URL(c.json().url);
    assert.equal(auth.searchParams.get("client_id"), "orb-client"); assert.equal(auth.searchParams.get("redirect_uri"), "http://orb.local:8095/api/robinhood/callback");
    assert.equal(auth.searchParams.get("code_challenge_method"), "S256"); assert.equal(auth.searchParams.get("resource"), `${rh.base}/mcp/trading`);
    rh.setChallenge(auth.searchParams.get("code_challenge")!);
    assert.equal((await app.inject({ method: "GET", url: `/api/robinhood/callback?code=good&state=forged` })).statusCode, 400, "a forged state is refused");
    const back = await app.inject({ method: "GET", url: `/api/robinhood/callback?code=good&state=${auth.searchParams.get("state")}` });
    assert.equal(back.statusCode, 302);
    assert.equal((await app.inject({ method: "GET", url: `/api/robinhood/callback?code=good&state=${auth.searchParams.get("state")}` })).statusCode, 400, "a state works once");
    const st = (await app.inject({ method: "GET", url: "/api/robinhood/status" })).json();
    assert.equal(st.connected, true, st.lastError); assert.equal(JSON.stringify(records.list("settings")).includes("tok"), false, "tokens never sit in a readable collection");
    // Tools, with guesses for which is which; the account through the read-only one.
    const tl = (await app.inject({ method: "GET", url: "/api/robinhood/tools" })).json();
    assert.deepEqual(tl.guess, { orderTool: "place_equity_order", accountTool: "get_account" });
    await put({ orderTool: "place_equity_order", accountTool: "get_account", maxOrder: 100, maxDay: 150 });
    assert.match((await app.inject({ method: "GET", url: "/api/robinhood/account" })).json().text, /Buying power/);
    // A pick you said yes to.
    const pick: any = records.create("picks", { date: "2026-11-06", symbol: "ACME", decision: "pending", amount: 80, priceAtPick: 50, outcomes: {} }, "2026-11-06-ACME");
    const order = (args: any, extra: any = {}) => app.inject({ method: "POST", url: "/api/robinhood/order", payload: { pickId: pick.id, tool: "place_equity_order", args, confirm: true, ...extra } });
    const good = { symbol: "ACME", side: "buy", order_type: "market", dollar_amount: 80, time_in_force: "gfd" };
    assert.equal((await order(good)).statusCode, 403, "trading is off by default");
    await put({ orderTool: "place_equity_order", accountTool: "get_account", maxOrder: 100, maxDay: 150, tradingOn: true });
    assert.equal((await order(good)).statusCode, 409, "only for a pick you said yes to");
    records.patch("picks", pick.id, { decision: "yes" });
    const pv = (await app.inject({ method: "POST", url: "/api/robinhood/order/preview", payload: { pickId: pick.id } })).json();
    assert.deepEqual(pv.args, good);
    assert.equal((await order({ ...good, symbol: "TSLA" })).statusCode, 422, "ticker must be the pick's");
    assert.equal((await order({ ...good, side: "sell" })).statusCode, 422, "buys only");
    assert.equal((await order({ ...good, dollar_amount: 500 })).statusCode, 422, "per-order cap");
    assert.equal((await order(good, { confirm: false })).statusCode, 400, "needs confirmation");
    assert.equal(rh.calls.filter(x => x.name === "place_equity_order").length, 0, "nothing sent so far");
    const ok = await order(good); assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().status, "sent"); assert.match(ok.json().result, /queued/);
    assert.equal((await order(good)).statusCode, 422, "the daily cap counts what was sent today");
    assert.equal(rh.calls.filter(x => x.name === "place_equity_order").length, 1);
    assert.equal((records.get("picks", pick.id) as any).orderStatus, "sent");
    // Orders can't be edited or deleted through the API.
    const oid = ok.json().id;
    assert.equal((await app.inject({ method: "DELETE", url: `/api/c/orders/${oid}` })).statusCode, 403);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/c/orders/${oid}`, payload: { status: "x" } })).statusCode, 403);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/c/picks/${pick.id}`, headers: { authorization: "Bearer t" } })).statusCode, 403);
  } finally { Object.assign(sources, was); clearDailyCache(); rh.close(); }
});
