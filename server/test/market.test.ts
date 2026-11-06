import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { parseFeed, sources, clearDailyCache } from "../src/integrations/daily.js";
import { parseEvents } from "../src/integrations/ical.js";
import { indicators, publicIp, readPage } from "../src/integrations/research.js";
import { askJev, JEV } from "../src/integrations/jev.js";

const cfg = (over: any = {}) => ({ ...loadConfig("/nonexistent.yaml", {}), ...over });
const serve = (h: (req: any, body: string, res: any) => void) => new Promise<{ url: string; close: () => void; hits: any[] }>(ok => {
  const hits: any[] = [];
  const s = createServer((req, res) => { let b = ""; req.on("data", d => (b += d)); req.on("end", () => { hits.push({ url: req.url, body: b, headers: req.headers }); h(req, b, res); }); })
    .listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(s.address() as any).port}`, close: () => s.close(), hits }));
});

test("TestDaily_ParsesRssAndAtom", () => {
  const rss = `<rss><channel><title>Wire</title><item><title><![CDATA[Fed holds &amp; signals cut]]></title><link>https://ex.com/a</link><pubDate>Thu, 05 Nov 2026 12:00:00 GMT</pubDate><description>&lt;p&gt;Rates&lt;/p&gt;</description></item>
    <item><title>Bad link</title><link>javascript:alert(1)</link></item></channel></rss>`;
  const atom = `<feed><title>Atom</title><entry><title>Chips rally</title><link href="https://ex.com/b"/><updated>2026-11-06T09:00:00Z</updated><summary>Up</summary></entry></feed>`;
  const a = parseFeed(rss), b = parseFeed(atom);
  assert.equal(a.length, 1, "javascript: links are dropped");
  assert.equal(a[0].title, "Fed holds & signals cut"); assert.equal(a[0].source, "Wire"); assert.equal(a[0].summary, "Rates");
  assert.equal(b[0].link, "https://ex.com/b"); assert.equal(b[0].source, "Atom");
});

test("TestDaily_ParsesExpandedEvents", () => {
  const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Standup\r\nDTSTART:20261106T150000Z\r\nDTEND:20261106T151500Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:2\r\nSUMMARY:Trip\r\nDTSTART;VALUE=DATE:20261107\r\nDTEND;VALUE=DATE:20261109\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:3\r\nSUMMARY:Gone\r\nSTATUS:CANCELLED\r\nDTSTART:20261106T150000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const e = parseEvents(ics);
  assert.deepEqual(e.map(x => x.title), ["Standup", "Trip"]);
  assert.equal(e[0].start, "2026-11-06T15:00:00.000Z"); assert.equal(e[1].allDay, true); assert.equal(e[1].end, "2026-11-09");
});

test("TestMarket_IndicatorsAndPublicIp", () => {
  const h = Array.from({ length: 60 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, "0")}`, close: 100 + i }));
  const ind = indicators(h)!;
  assert.equal(ind.close, 159); assert.equal(ind.ret_1d_pct, +((159 / 158 - 1) * 100).toFixed(2)); assert.equal(ind.rsi14, 100); assert.equal(ind.from_52w_high_pct, 0);
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.20.10", "172.20.0.5", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:192.168.1.1"]) assert.equal(publicIp(ip), false, ip);
  assert.equal(publicIp("93.184.216.34"), true);
});

test("TestMarket_ReadPageRefusesLan", async () => {
  await assert.rejects(readPage("http://127.0.0.1:8095/api/config"), /public address/);
  await assert.rejects(readPage("file:///etc/passwd"), /http/);
});

test("TestJev_SendsTypedQuestionsAndChecksAnswers", async () => {
  const jev = await serve((_q, _b, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ model: "jev-latest", answers: { action: { type: "choice", choice: "buy", probabilities: { buy: 0.6, hold: 0.3, skip: 0.1 }, confidence: 0.6 }, d: { choice: "moon" } } })); });
  const was = JEV.endpoint; JEV.endpoint = jev.url;
  try {
    const qs = { action: { instructions: "Do it?", criteria: { buy: "b", hold: "h", skip: "s" } }, d: { instructions: "Dir?", criteria: { up: "u", flat: "f", down: "d" } } };
    const v = await askJev("k", { x: 1 }, qs, { action: "skip", d: "flat" });
    const sent = JSON.parse(jev.hits[0].body);
    assert.equal(jev.hits[0].headers.authorization, "Bearer k");
    assert.deepEqual(sent.questions.action, { type: "choice", instructions: "Do it?", criteria: { buy: "b", hold: "h", skip: "s" } });
    assert.equal(v.answers.action.choice, "buy"); assert.equal(v.answers.action.probabilities.buy, 0.6);
    assert.equal(v.answers.d.choice, "flat", "an off-menu answer falls back"); assert.equal(v.answers.d.confidence, 0);
  } finally { JEV.endpoint = was; jev.close(); }
});

test("TestMarket_RunDecideTrackAndScore", async () => {
  // Prices: a year of closes rising 1 a day; news: one headline per search.
  const days = Array.from({ length: 300 }, (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 864e5).toISOString().slice(0, 10));
  const market = await serve((req, _b, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname.startsWith("/chart/")) {
      const sym = decodeURIComponent(u.pathname.split("/")[2]), ts = days.map(d => Date.parse(d + "T20:00:00Z") / 1000);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ chart: { result: [{ meta: { shortName: sym + " Inc", regularMarketPrice: 399, chartPreviousClose: 398, currency: "USD", regularMarketTime: ts.at(-1) }, timestamp: ts, indicators: { quote: [{ close: days.map((_, i) => 100 + i) }] } }] } }));
    }
    if (u.pathname === "/news") { res.writeHead(200); return res.end(`<rss><channel><title>GN</title><item><title>${u.searchParams.get("q")} news</title><link>https://ex.com/n</link><pubDate>Thu, 05 Nov 2026 12:00:00 GMT</pubDate></item></channel></rss>`); }
    res.writeHead(404); res.end();
  });
  // The model: research passes answer in text, the candidate pass in JSON, verdicts in JSON.
  const llm = await serve((_q, body, res) => {
    const m = JSON.parse(body).messages, sys = String(m[0].content), J = (content: string) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content } }] })); };
    if (sys.includes("choose up to")) return J(JSON.stringify({ picks: [{ symbol: "ACME", thesis: "Beat and raise.", catalyst: "Q3 earnings", sources: ["https://ex.com/n", "javascript:x"] }, { symbol: "BAD!", thesis: "x" }, { symbol: "TSLA" }] }));
    if (sys.includes("decision model")) return J(`Sure: {"action":{"choice":"buy","confidence":0.55},"direction_5d":{"choice":"up","confidence":0.5},"direction_20d":{"choice":"up","confidence":0.45},"conviction":{"choice":"fair","confidence":0.5}}`);
    return J("## Report\nACME beat earnings.");
  });
  const was = { ...sources }; sources.yahoo = market.url + "/chart"; sources.googleNews = market.url + "/news"; clearDailyCache();
  try {
    const { app, records, market: mk } = await buildApp({ config: cfg({ golem: { baseUrl: llm.url, model: "m", keyEnv: "", canWrite: false } }) });
    await app.inject({ method: "PUT", url: "/api/c/settings/app", payload: { market: { avoid: ["TSLA"], maxPicks: 3, notional: 200 } } });
    const r: any = await mk.run("2026-11-06");
    assert.equal(r.status, "done", r.error);
    assert.deepEqual(r.candidates, ["ACME"], "bad tickers and the avoid list are dropped");
    const p: any = records.get("picks", "2026-11-06-ACME");
    assert.equal(p.decision, "pending"); assert.equal(p.verdict.source, "llm"); assert.equal(p.verdict.answers.action.choice, "buy");
    assert.deepEqual(p.sources, ["https://ex.com/n"]); assert.equal(p.state.symbol, "ACME"); assert.ok(p.state.indicators.rsi14 !== undefined); assert.ok(p.state.track_record);
    // Agents can't decide; you can.
    assert.equal((await app.inject({ method: "POST", url: `/api/market/picks/${p.id}/decide`, headers: {}, payload: { decision: "maybe" } })).statusCode, 422);
    assert.equal((await app.inject({ method: "POST", url: `/api/market/picks/${p.id}/decide`, payload: { decision: "no", amount: 500 } })).statusCode, 200);
    // Running again the same day keeps the decision.
    await mk.run("2026-11-06");
    assert.equal((records.get("picks", p.id) as any).decision, "no"); assert.equal((records.get("picks", p.id) as any).amount, 500);
    // Pretend the pick was made 50 days into the price series, at 150: outcomes fill in.
    records.patch("picks", p.id, { date: days[50], priceAtPick: 150 });
    assert.equal((await mk.updateOutcomes()).updated, 1);
    const o: any = records.get("picks", p.id);
    assert.equal(o.outcomes.d20.close, 170); assert.equal(o.outcomes.d20.retPct, +((170 / 150 - 1) * 100).toFixed(2));
    const sc: any = mk.scorecard();
    const d20 = sc.horizons.find((h: any) => h.days === 20);
    assert.equal(d20.noWouldHave, +((500 * o.outcomes.d20.retPct) / 100).toFixed(2), "a declined pick shows what it would have made");
    assert.equal(sc.direction20d.n, 1); assert.equal(sc.direction20d.accuracy, 1);
  } finally { Object.assign(sources, was); clearDailyCache(); market.close(); llm.close(); }
});

test("TestMarket_AgentsCantTouchPicks", async () => {
  const { app } = await buildApp({ config: cfg(), tokens: "bot:t" });
  const H = { authorization: "Bearer t" };
  assert.equal((await app.inject({ method: "POST", url: "/api/market/run", headers: H })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/c/picks", headers: H, payload: { symbol: "X" } })).statusCode, 403);
});
