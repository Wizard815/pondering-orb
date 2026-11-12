import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { clearCoinpileCache } from "../src/integrations/coinpile.js";
import { clearFireflyCache } from "../src/integrations/firefly.js";
import { localDay } from "../src/dates.js";

const day = (k: number) => localDay(Date.now() + k * 864e5);
const serve = (h: (req: any, res: any) => void) => new Promise<{ url: string; close: () => void; hits: any[] }>(ok => {
  const hits: any[] = [];
  const s = createServer((req, res) => { hits.push({ method: req.method, url: req.url, auth: req.headers.authorization }); h(req, res); }).listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(s.address() as any).port}`, close: () => s.close(), hits }));
});
const J = (res: any, o: unknown, c = 200) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };

test("TestCoinpile_ReadOnlySummaryMaturitiesAndBills", async () => {
  process.env.CP_TOKEN = "cp_me_secret"; process.env.FF_TOKEN = "pat";
  // Exactly what Coinpile's orb_summary returns for a person sharing everything.
  const cp = await serve((req, res) => {
    if (req.headers.authorization === "Bearer cp_noscope") return J(res, { detail: "this token does not have the 'orb' scope" }, 403);
    if (req.url !== "/api/v1/summary" || req.headers.authorization !== "Bearer cp_me_secret") return J(res, { detail: "invalid token" }, 401);
    J(res, { goblins: { wiz: { name: "wiz", net_worth: 48210.77, subscriptions_monthly: 86.4,
      bills: { next_7d: 95.48, next_30d: 1475.47, next: { name: "Netflix", date: day(0), amount: 15.49 } }, alerts: { total: 4, critical: 1, warning: 2 },
      bill_list: [{ date: day(0), name: "Netflix", amount: 15.49, category: "Subscriptions" }, { date: day(3), name: "Rent", amount: 1300, category: "Housing" }, { date: day(40), name: "Far", amount: 1, category: "x" }],
      alert_list: [{ severity: "info", kind: "due_soon", title: "Netflix due", detail: "15.49", date: day(0) }, { severity: "critical", kind: "bank_login", title: "Ally needs you to sign in again", detail: "At the Plaid connector" },
        { severity: "warning", kind: "maturing", title: "12-mo CD matures in 4 days", detail: "Worth about 10,512.20", date: day(4) },
        { severity: "warning", kind: "matured_idle", title: "Old CD matured 12 days ago and is still sitting there", detail: "Roll it over or move it", date: day(-12) }],
      savings: { total: 9200, free: 1200, earmarked: 8000 }, goals: [{ name: "New NAS drives", target: 900, allocated: 610, pct: 0.678 }, { name: "", target: 1, allocated: 1, pct: 1 }],
      robinhood_agent: { value: 512.3, as_of: "2026-11-11T20:00:00" }, robinhood_main: null,
      spending: { so_far: 1840.2, projected: 3910, income_avg: 4250, left_after: 340 } } } });
  });
  const ff = await serve((req, res) => {
    const u = new URL(req.url, "http://x"), page = { meta: { pagination: { total_pages: 1 } } };
    if (u.pathname === "/api/v1/bills") return J(res, { ...page, data: [{ id: "2", attributes: { name: "Netflix (Firefly)", amount_avg: "15.49", currency_code: "USD", active: true, pay_dates: [`${day(0)}T00:00:00Z`], paid_dates: [] } }] });
    J(res, { ...page, data: [] });
  });
  clearCoinpileCache(); clearFireflyCache();
  try {
    const { app, daily } = await buildApp({ config: loadConfig("/nonexistent.yaml", {}) });
    const put = (apps: string) => app.inject({ method: "PUT", url: "/api/c/settings/apps", payload: { yaml: `groups:\n  - name: Money\n    apps:\n${apps}` } });
    const cpApp = `      - name: Coinpile\n        url: ${cp.url}\n        widget: { type: coinpile, key_env: CP_TOKEN, page: true }\n`;
    await put(cpApp);
    const w = (await app.inject({ method: "GET", url: "/api/widgets/Coinpile" })).json();
    assert.equal(w.type, "coinpile"); assert.equal(w.name, "wiz"); assert.equal(w.netWorth, 48210.77);
    assert.deepEqual(w.robinhoodAgent, { value: 512.3, asOf: "2026-11-11T20:00:00" }); assert.equal(w.robinhoodMain, null);
    assert.equal(w.spending.pctOfIncome, 0.92, "projected / average income, worked out by Orb");
    assert.deepEqual(w.goals.map((g: any) => g.name), ["New NAS drives"], "a goal without a name is dropped");
    assert.deepEqual(w.alertList.map((a: any) => a.severity), ["critical", "warning", "warning", "info"], "critical first");
    assert.deepEqual(w.maturities.map((m: any) => m.kind), ["matured_idle", "maturing"]);
    // Without Firefly, Daily's bills come from Coinpile's list; maturities show (an idle matured CD stays on Today).
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/daily/bills?days=7" })).json().map((b: any) => b.name), ["Netflix", "Rent"]);
    const mats = (await app.inject({ method: "GET", url: "/api/daily/maturities?days=7" })).json();
    assert.deepEqual(mats.map((m: any) => [m.kind, m.date]), [["matured_idle", day(0)], ["maturing", day(4)]]);
    // The brief gets savings, the forecast, alerts and this week's maturities.
    const g: any = await daily.gather();
    assert.equal(g.coinpile.spendingForecast.pctOfIncome, 92); assert.equal(g.coinpile.savings.free, 1200);
    assert.deepEqual(g.coinpile.alerts.map((a: any) => a.title)[0], "Ally needs you to sign in again");
    assert.deepEqual(g.coinpile.billsThisWeek.map((b: any) => b.name), ["Netflix", "Rent"]);
    // With Firefly too, bills come from Firefly only (Coinpile's list holds the same bills).
    await put(cpApp + `      - name: Firefly\n        url: ${ff.url}\n        widget: { type: firefly, key_env: FF_TOKEN }\n`);
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/daily/bills?days=7" })).json().map((b: any) => b.name), ["Netflix (Firefly)"]);
    assert.equal((await daily.gather() as any).coinpile.billsThisWeek, undefined);
    // A token without the orb scope says what to fix.
    process.env.CP_TOKEN = "cp_noscope"; clearCoinpileCache();
    assert.match((await app.inject({ method: "GET", url: "/api/apps/Coinpile/coinpile" })).json().error, /"orb" scope/);
    assert.ok(cp.hits.every(h => h.method === "GET"));
  } finally { cp.close(); ff.close(); clearCoinpileCache(); clearFireflyCache(); delete process.env.CP_TOKEN; delete process.env.FF_TOKEN; }
});
