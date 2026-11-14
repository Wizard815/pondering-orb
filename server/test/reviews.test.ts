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

test("TestReviews_HoldingsAndWatchlistGetDecisions", async () => {
  const asked: any[] = [];
  const fake = await serve((req, res, body) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname.startsWith("/chart/")) { const ts = Array.from({ length: 30 }, (_, k) => Math.floor(Date.now() / 1000) - (29 - k) * 86400);
      return J(res, { chart: { result: [{ meta: { shortName: u.pathname.split("/")[2], regularMarketPrice: 50, chartPreviousClose: 49, regularMarketTime: ts.at(-1) }, timestamp: ts, indicators: { quote: [{ close: ts.map((_, k) => 40 + k / 3) }] } }] } }); }
    if (u.pathname === "/news") { res.writeHead(200, { "content-type": "application/rss+xml" }); return res.end(`<rss><channel><item><title>Big contract win</title><link>https://example.com/1</link></item></channel></rss>`); }
    if (u.pathname === "/cp/api/v1/summary") return J(res, { goblins: { me: { holdings: [{ symbol: "HELD", quantity: 4, net_cost: 160, equity: 200 }] } } });
    if (u.pathname === "/v1/chat/completions") return J(res, { choices: [{ message: { content: JSON.stringify({ items: [{ n: 1, rating: "good", why: "Revenue" }], overall: "good", summary: "Good news." }) } }] });
    if (u.pathname === "/jev") { const b = JSON.parse(body); asked.push(b);
      const a = Object.keys(b.questions.action.criteria).includes("add") ? "add" : "buy";
      return J(res, { model: "jev-x", answers: { action: { choice: a, confidence: 0.7 }, direction_20d: { choice: "up", confidence: 0.5 }, conviction: { choice: "fair", confidence: 0.6 } } }); }
    res.writeHead(404); res.end();
  });
  const saved = { ...sources }; Object.assign(sources, { yahoo: `${fake.url}/chart`, tiingo: `${fake.url}/none`, stooq: `${fake.url}/none`, googleNews: `${fake.url}/news` });
  clearDailyCache(); clearCoinpileCache(); process.env.CPR = "cp";
  try {
    const { app, records, reviews } = await buildApp({ password: "pw", tokens: "bot:tok", config: { ...loadConfig("/nonexistent.yaml", {}), golem: { baseUrl: `${fake.url}/v1`, model: "m", keyEnv: "", canWrite: false } } });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: "pw" } }), cookie = { orb_session: String(login.cookies.find((c: any) => c.name === "orb_session")?.value) };
    await app.inject({ method: "PUT", url: "/api/c/settings/apps", cookies: cookie, payload: { yaml: `groups:\n  - name: M\n    apps:\n      - name: Coinpile\n        url: ${fake.url}/cp\n        widget: { type: coinpile, key_env: CPR }\n` } });
    const d = new Date(), slot = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    await app.inject({ method: "PUT", url: "/api/c/settings/app", cookies: cookie, payload: { daily: { watchlist: ["WATCH", "HELD"] },
      market: { decider: { kind: "jev", baseUrl: `${fake.url}/jev`, model: "jev-x" }, reviews: { on: true, times: [slot], weekdaysOnly: false } } } });

    assert.equal((await app.inject({ method: "POST", url: "/api/market/review", headers: { authorization: "Bearer tok" } })).statusCode, 403, "agents can't run one");
    await reviews.tick();
    const list = (await app.inject({ method: "GET", url: "/api/market/reviews", cookies: cookie })).json();
    const r = list.reviews[0]; assert.equal(r.status, "done"); assert.equal(r.slot, slot);
    assert.deepEqual(r.items.map((i: any) => [i.symbol, i.held, i.verdict.answers.action.choice]), [["HELD", true, "add"], ["WATCH", false, "buy"]], "held first, each asked its own question, no symbol twice");
    const heldState = asked.find(a => a.state.symbol === "HELD").state;
    assert.deepEqual(heldState.you_own, { shares: 4, avg_cost: 40, gain_pct: 25 }); assert.equal(heldState.news.overall, "good");
    assert.deepEqual(Object.keys(asked.find(a => a.state.symbol === "WATCH").questions.action.criteria), ["buy", "watch", "skip"]);
    // The slot runs once.
    await reviews.tick(); assert.equal(asked.length, 2);
    assert.equal(records.list("reviews").length, 1);
    await app.close();
  } finally { Object.assign(sources, saved); clearDailyCache(); clearCoinpileCache(); delete process.env.CPR; fake.close(); }
});
