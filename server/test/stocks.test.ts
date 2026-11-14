import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { sources, clearDailyCache } from "../src/integrations/daily.js";
import { robinhoodRows, positions } from "../src/stocks.js";

const serve = (h: (req: any, res: any, body: string) => void) => new Promise<{ url: string; close: () => void }>(ok => {
  const s = createServer((req, res) => { let b = ""; req.on("data", c => (b += c)); req.on("end", () => h(req, res, b)); }).listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(s.address() as any).port}`, close: () => s.close() }));
});
const J = (res: any, o: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };

// The shape of Robinhood's account activity report, including a description over two lines and the closing disclaimer.
const CSV = `"Activity Date","Process Date","Settle Date","Instrument","Description","Trans Code","Quantity","Price","Amount"
"11/10/2026","11/10/2026","11/12/2026","ACME","Acme Corp
CUSIP: 000000000","Sell","5","$30.00","$150.00"
"11/01/2026","11/01/2026","11/01/2026","ACME","Cash Div: R/D 2026-10-20 P/D 2026-11-01 - 10 shares at 0.5","CDIV","","","$5.00"
"10/15/2026","10/15/2026","10/15/2026","ACME","Forward split","SPL","10","",""
"10/01/2026","10/01/2026","10/03/2026","ACME","Acme Corp","Buy","4","$40.00","($160.00)"
"09/01/2026","09/01/2026","09/03/2026","ACME","Acme Corp","Buy","6","$40.00","($240.00)"
"09/01/2026","09/01/2026","09/01/2026","","ACH Deposit","ACH","","","$1,000.00"
"","","","","","","","","","The data provided is for informational purposes only."
`;

test("TestStocks_RobinhoodCsvPositions", () => {
  const rows = robinhoodRows(CSV);
  assert.equal(rows.length, 6, "the disclaimer line is skipped");
  assert.equal(rows[0].description, "Acme Corp CUSIP: 000000000"); assert.equal(rows[3].amount, -160);
  const [p] = positions(rows);
  // Bought 10 for $400, split 2-for-1 (20 shares, $20 each), sold 5 at $30.
  assert.equal(p.shares, 15); assert.equal(p.avgCost, 20); assert.equal(p.cost, 300); assert.equal(p.realized, 50); assert.equal(p.dividends, 5);
  assert.throws(() => robinhoodRows("a,b\n1,2"), /activity CSV/);
});

test("TestStocks_ImportSummaryNewsAndFeeds", async () => {
  const fake = await serve((req, res, body) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname.startsWith("/chart/")) { const ts = [0, 1, 2].map(k => Math.floor(Date.now() / 1000) - (2 - k) * 86400); return J(res, { chart: { result: [{ meta: { shortName: "Acme Corp", regularMarketPrice: 25, chartPreviousClose: 24, regularMarketTime: ts[2] }, timestamp: ts, indicators: { quote: [{ close: [23, 24, 25] }] } }] } }); }
    if (u.pathname === "/news") { res.writeHead(200, { "content-type": "application/rss+xml" }); return res.end(`<rss><channel><title>GN</title><item><title>Acme beats estimates</title><link>https://example.com/a</link><pubDate>${new Date().toUTCString()}</pubDate></item><item><title>Acme faces lawsuit</title><link>https://example.com/b</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`); }
    if (u.pathname === "/feed/world") { res.writeHead(200, { "content-type": "application/rss+xml" }); return res.end(`<rss><channel><title>World Desk</title><link>https://world.example.com/</link><item><title>Headline one</title><link>https://world.example.com/1</link></item></channel></rss>`); }
    if (u.pathname === "/v1/chat/completions") { const m = JSON.parse(body).messages; assert.match(m[1].content, /Stock: ACME/);
      return J(res, { choices: [{ message: { content: JSON.stringify({ items: [{ n: 1, rating: "good", why: "Beat" }, { n: 2, rating: "bad", why: "Legal risk" }, { n: 9, rating: "good" }], overall: "mixed", summary: "Beat, but a lawsuit." }) } }] }); }
    res.writeHead(404); res.end();
  });
  const saved = { ...sources };
  Object.assign(sources, { yahoo: `${fake.url}/chart`, tiingo: `${fake.url}/none`, stooq: `${fake.url}/none`, googleNews: `${fake.url}/news` });
  clearDailyCache();
  try {
    const { app, records } = await buildApp({ password: "pw", tokens: "bot:tok", config: { ...loadConfig("/nonexistent.yaml", {}), golem: { baseUrl: `${fake.url}/v1`, model: "m", keyEnv: "", canWrite: false } } });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: "pw" } }), cookie = { orb_session: String(login.cookies.find((c: any) => c.name === "orb_session")?.value) };
    const up = (headers: any) => app.inject({ method: "POST", url: "/api/robinhood/csv", headers: { "content-type": "text/csv", ...headers.h }, cookies: headers.c, payload: CSV });
    assert.equal((await up({ h: { authorization: "Bearer tok" } })).statusCode, 403, "agents can't import");
    const r1 = (await up({ c: cookie, h: {} })).json(); assert.deepEqual([r1.rows, r1.added, r1.from, r1.to], [6, 6, "2026-09-01", "2026-11-10"]);
    assert.equal((await up({ c: cookie, h: {} })).json().added, 0, "importing the same file again adds nothing");
    assert.equal((await app.inject({ method: "POST", url: "/api/c/trades", headers: { authorization: "Bearer tok" }, payload: { symbol: "X" } })).statusCode, 403);
    const s = (await app.inject({ method: "GET", url: "/api/trades/summary", cookies: cookie })).json();
    assert.equal(s.count, 6); assert.equal(s.positions[0].symbol, "ACME"); assert.equal(s.positions[0].value, 375); assert.equal(s.positions[0].unrealized, 75);

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
  } finally { Object.assign(sources, saved); clearDailyCache(); fake.close(); }
});
