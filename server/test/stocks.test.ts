import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { sources, clearDailyCache } from "../src/integrations/daily.js";
import { clearCoinpileCache } from "../src/integrations/coinpile.js";

const serve = (h: (req: any, res: any, body: string) => void) => new Promise<{ url: string; close: () => void }>(ok => {
  const s = createServer((req, res) => { let b = ""; req.on("data", c => (b += c)); req.on("end", () => h(req, res, b)); }).listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(s.address() as any).port}`, close: () => s.close() }));
});
const J = (res: any, o: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };

test("TestStocks_HoldingsNewsAndFeeds", async () => {
  const fake = await serve((req, res, body) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname.startsWith("/chart/")) { const ts = [0, 1, 2].map(k => Math.floor(Date.now() / 1000) - (2 - k) * 86400); return J(res, { chart: { result: [{ meta: { shortName: "Acme Corp", regularMarketPrice: 25, chartPreviousClose: 24, regularMarketTime: ts[2] }, timestamp: ts, indicators: { quote: [{ close: [23, 24, 25] }] } }] } }); }
    if (u.pathname === "/news") { res.writeHead(200, { "content-type": "application/rss+xml" }); return res.end(`<rss><channel><title>GN</title><item><title>Acme beats estimates</title><link>https://example.com/a</link><pubDate>${new Date().toUTCString()}</pubDate></item><item><title>Acme faces lawsuit</title><link>https://example.com/b</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`); }
    if (u.pathname === "/feed/world") { res.writeHead(200, { "content-type": "application/rss+xml" }); return res.end(`<rss><channel><title>World Desk</title><link>https://world.example.com/</link><item><title>Headline one</title><link>https://world.example.com/1</link></item></channel></rss>`); }
    if (u.pathname === "/cp/api/v1/summary") return J(res, { goblins: { me: shareHoldings ? { holdings: [{ symbol: "ACME", quantity: 10, net_cost: 200, equity: 240, account: "rh:main" }, { symbol: "acme", quantity: 5, net_cost: 100, equity: 120, account: "rh:agent" }, { symbol: "<bad>", quantity: 1 }], ...(shareTrading ? { trading: TRADING } : {}) } : {} } });
    if (u.pathname === "/v1/chat/completions") { const m = JSON.parse(body).messages; assert.match(m[1].content, /Stock: ACME/);
      return J(res, { choices: [{ message: { content: JSON.stringify({ items: [{ n: 1, rating: "good", why: "Beat" }, { n: 2, rating: "bad", why: "Legal risk" }, { n: 9, rating: "good" }], overall: "mixed", summary: "Beat, but a lawsuit." }) } }] }); }
    res.writeHead(404); res.end();
  });
  let shareHoldings = false, shareTrading = false;
  const TRADING = { enabled: true, wallet: "paper", value: 1012.5, cash: 900, start_of_day: 1000, stopped: null, next_session: "2026-11-20T09:45-05:00", running: false, waiting: 1,
    positions: [{ symbol: "nvda", quantity: 2, price: 56.25, value: 112.5 }], last_session: { day: "2026-11-19", slot: "15:30", mode: "auto", status: "done", summary: "1 order(s) done.", finished: "x" },
    orders: [{ ts: "2026-11-19T20:31:00+00:00", symbol: "NVDA", side: "buy", quantity: 2, price: 50, status: "filled", reason: "", rating: "Buy" }, { symbol: "<x>", side: "buy" }],
    ideas: [{ account: "main", symbol: "ACME", rating: "Underweight", action: "trim", summary: "Margins slipping.", ts: "2026-11-19T20:31:00+00:00" }, { account: "agent", symbol: "NVDA", rating: "Buy", action: "add" }] };
  const saved = { ...sources };
  Object.assign(sources, { yahoo: `${fake.url}/chart`, tiingo: `${fake.url}/none`, stooq: `${fake.url}/none`, googleNews: `${fake.url}/news` });
  clearDailyCache();
  try {
    const { app, records } = await buildApp({ password: "pw", tokens: "bot:tok", config: { ...loadConfig("/nonexistent.yaml", {}), golem: { baseUrl: `${fake.url}/v1`, model: "m", keyEnv: "", canWrite: false } } });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: "pw" } }), cookie = { orb_session: String(login.cookies.find((c: any) => c.name === "orb_session")?.value) };
    // Holdings come from Coinpile; until Coinpile shares them, Orb says so.
    process.env.CPT = "cp";
    await app.inject({ method: "PUT", url: "/api/c/settings/apps", cookies: cookie, payload: { yaml: `groups:\n  - name: M\n    apps:\n      - name: Coinpile\n        url: ${fake.url}/cp\n        widget: { type: coinpile, key_env: CPT }\n` } });
    const h0 = (await app.inject({ method: "GET", url: "/api/holdings", cookies: cookie })).json();
    assert.equal(h0.source, null); assert.match(h0.note, /isn't sharing holdings/);
    shareHoldings = true; clearCoinpileCache();
    const h = (await app.inject({ method: "GET", url: "/api/holdings", cookies: cookie })).json();
    assert.equal(h.source, "coinpile"); assert.equal(h.positions.length, 1, "one line per symbol, bad symbols dropped");
    const p = h.positions[0]; assert.deepEqual([p.symbol, p.shares, p.cost, p.avgCost, p.price, p.value, p.unrealized, p.account], ["ACME", 15, 300, 20, 25, 375, 75, "several"]);
    // Coinpile's auto wallet, read only, once Coinpile shares it
    assert.match((await app.inject({ method: "GET", url: "/api/trading", cookies: cookie })).json().note, /isn't sharing trading/);
    shareTrading = true; clearCoinpileCache();
    const tr = (await app.inject({ method: "GET", url: "/api/trading", cookies: cookie })).json();
    assert.equal(tr.url, `${fake.url}/cp`); assert.equal(tr.trading.value, 1012.5); assert.equal(tr.trading.waiting, 1);
    assert.deepEqual(tr.trading.positions[0], { symbol: "NVDA", quantity: 2, price: 56.25, value: 112.5 });
    assert.equal(tr.trading.orders.length, 1, "an order without a proper symbol is dropped");
    assert.deepEqual(tr.trading.ideas.map((i: any) => [i.account, i.symbol, i.action]), [["main", "ACME", "trim"], ["agent", "NVDA", "add"]]);
    assert.equal((await app.inject({ method: "POST", url: "/api/robinhood/csv", cookies: cookie, headers: { "content-type": "text/csv" }, payload: "a,b" })).statusCode, 404, "Robinhood history is Coinpile's now");
    const n = (await app.inject({ method: "GET", url: "/api/market/news/acme", cookies: cookie })).json();
    assert.equal(n.symbol, "ACME"); assert.equal(n.price, 25); assert.equal(n.position.shares, 15);
    assert.deepEqual(n.items.map((i: any) => i.rating), ["good", "bad"]); assert.equal(n.overall, "mixed");
    assert.equal((await app.inject({ method: "GET", url: "/api/market/news/%3Cx%3E", cookies: cookie })).statusCode, 400);

    // Feeds: names and sites; one feed at a time only if it's yours.
    await app.inject({ method: "PUT", url: "/api/c/settings/app", cookies: cookie, payload: { daily: { feeds: [`${fake.url}/feed/world`], favFeed: `${fake.url}/feed/world`, location: "Here", places: ["Here", "There"] } } });
    const f = (await app.inject({ method: "GET", url: "/api/daily/feeds", cookies: cookie })).json();
    assert.deepEqual([f.feeds[0].title, f.feeds[0].site, f.feeds[0].count, f.favourite], ["World Desk", "https://world.example.com/", 1, `${fake.url}/feed/world`]);
    assert.equal(f.coverage.label, "Ground News"); assert.match(f.coverage.template, /\{q\}/);
    assert.equal((await app.inject({ method: "GET", url: `/api/daily/news?feed=${encodeURIComponent(fake.url + "/feed/world")}`, cookies: cookie })).json()[0].title, "Headline one");
    assert.equal((await app.inject({ method: "GET", url: `/api/daily/news?feed=${encodeURIComponent("http://169.254.169.254/")}`, cookies: cookie })).statusCode, 400, "only your own feeds");
    assert.equal((await app.inject({ method: "GET", url: "/api/daily/weather?place=Elsewhere", cookies: cookie })).statusCode, 400, "only your own places");
    await app.close();
  } finally { Object.assign(sources, saved); clearDailyCache(); clearCoinpileCache(); delete process.env.CPT; fake.close(); }
});
