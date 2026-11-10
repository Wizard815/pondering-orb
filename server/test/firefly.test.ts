import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { clearFireflyCache } from "../src/integrations/firefly.js";
import { localDay } from "../src/dates.js";

const cfg = () => loadConfig("/nonexistent.yaml", {});
const day = (k: number) => localDay(Date.now() + k * 864e5);

test("TestFirefly_ReadOnlySummaryBillsBudgetsAndTools", async () => {
  process.env.FIREFLY_TOKEN = "pat";
  const hits: { method: string; url: string; auth?: string }[] = [];
  const s = createServer((req, res) => {
    hits.push({ method: req.method!, url: req.url!, auth: req.headers.authorization });
    const J = (o: unknown, c = 200) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== "Bearer pat") return J({ message: "Unauthenticated." }, 401);
    const u = new URL(req.url!, "http://x"), page = { meta: { pagination: { total_pages: 1 } } };
    const box = (key: string, v: string) => ({ [key]: { key, monetary_value: v, currency_code: "USD" } });
    if (u.pathname === "/api/v1/summary/basic") return J({ ...box("balance-in-USD", "1200.50"), ...box("spent-in-USD", "-845.10"), ...box("earned-in-USD", "4100.00"),
      ...box("left-to-spend-in-USD", "312.40"), ...box("net-worth-in-USD", "48210.77"), ...box("bills-paid-in-USD", "-1300.00"), ...box("bills-unpaid-in-USD", "-95.49"), ...box("spent-in-EUR", "-10") });
    if (u.pathname === "/api/v1/bills") return J({ ...page, data: [
      { id: "1", attributes: { name: "Rent", amount_min: "1300", amount_max: "1300", amount_avg: "1300", currency_code: "USD", repeat_freq: "monthly", active: true, pay_dates: [`${day(0)}T00:00:00-06:00`], paid_dates: [{ date: `${day(0)}T00:00:00-06:00` }] } },
      { id: "2", attributes: { name: "Netflix", amount_min: "15.49", amount_max: "15.49", currency_code: "USD", repeat_freq: "monthly", active: true, pay_dates: [`${day(2)}T00:00:00-06:00`], paid_dates: [] } },
      { id: "3", attributes: { name: "Old gym", amount_min: "30", amount_max: "30", active: false, pay_dates: [`${day(1)}T00:00:00-06:00`], paid_dates: [] } }] });
    if (u.pathname === "/api/v1/budget-limits") return J({ ...page, data: [{ id: "9", attributes: { budget_id: "5", amount: "400", spent: "-388.00", currency_code: "USD" } }, { id: "10", attributes: { budget_id: "6", amount: "200", spent: [{ sum: "-50", currency_code: "USD" }], currency_code: "USD" } }] });
    if (u.pathname === "/api/v1/budgets") return J({ ...page, data: [{ id: "5", attributes: { name: "Groceries" } }, { id: "6", attributes: { name: "Fun" } }] });
    if (u.pathname === "/api/v1/piggy-banks") return J({ ...page, data: [{ id: "1", attributes: { name: "New NAS drives", current_amount: "610", target_amount: "900", percentage: 67, target_date: "2026-12-20", currency_code: "USD", active: true } }] });
    if (u.pathname === "/api/v1/accounts") return J({ ...page, data: u.searchParams.get("type") === "asset"
      ? [{ id: "1", attributes: { name: "Checking", type: "asset", current_balance: "1200.50", currency_code: "USD", include_net_worth: true, active: true } }]
      : [{ id: "2", attributes: { name: "Car loan", type: "liabilities", current_balance: "-8400", currency_code: "USD", include_net_worth: true, active: true } }] });
    const tx = { ...page, data: [{ id: "77", attributes: { transactions: [{ date: `${day(-1)}T09:00:00-06:00`, description: "Groceries run", amount: "84.12", type: "withdrawal", category_name: "Groceries", budget_name: "Groceries", source_name: "Checking", destination_name: "Market", currency_code: "USD" }] } }] };
    if (u.pathname === "/api/v1/transactions" || u.pathname === "/api/v1/search/transactions") return J(tx);
    J({}, 404);
  }).listen(0, "127.0.0.1");
  await new Promise(r => s.once("listening", r));
  const url = `http://127.0.0.1:${(s.address() as any).port}`;
  clearFireflyCache();
  try {
    const { app, daily } = await buildApp({ config: cfg() });
    await app.inject({ method: "PUT", url: "/api/c/settings/apps", payload: { yaml: `groups:\n  - name: Home\n    apps:\n      - name: Firefly\n        url: ${url}\n        widget: { type: firefly, key_env: FIREFLY_TOKEN, page: true }\n` } });
    const w = (await app.inject({ method: "GET", url: "/api/widgets/Firefly" })).json();
    assert.equal(w.type, "firefly");
    assert.deepEqual({ ...w.summary, from: "", to: "" }, { currency: "USD", netWorth: 48210.77, balance: 1200.5, spent: 845.1, earned: 4100, leftToSpend: 312.4, billsPaid: 1300, billsUnpaid: 95.49, from: "", to: "" });
    assert.deepEqual(w.bills.map((b: any) => [b.name, b.paid]), [["Rent", true], ["Netflix", false]], "inactive bills are left out; a matched payment is paid");
    assert.deepEqual(w.budgets.map((b: any) => [b.name, b.spent, b.pct]), [["Groceries", 388, 97], ["Fun", 50, 25]], "spent as a number or a list, both read");
    assert.equal(w.piggies[0].pct, 67, "Firefly's percentage is already 0-100");
    // The Daily page gets unpaid bills only.
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/daily/bills?days=7" })).json().map((b: any) => b.name), ["Netflix"]);
    // The full page's routes.
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/apps/Firefly/firefly/accounts" })).json().map((a: any) => [a.name, a.balance]), [["Checking", 1200.5], ["Car loan", -8400]]);
    const t = (await app.inject({ method: "GET", url: "/api/apps/Firefly/firefly/transactions?q=groceries" })).json();
    assert.equal(t[0].amount, -84.12); assert.equal(t[0].counterparty, "Market");
    // The brief gets the month, this week's unpaid bills and budgets near their limit.
    const g: any = await daily.gather();
    assert.equal(g.finances.leftToSpend, 312.4); assert.deepEqual(g.finances.billsThisWeek.map((b: any) => b.name), ["Netflix"]);
    assert.deepEqual(g.finances.budgetsNearLimit.map((b: any) => b.name), ["Groceries"]);
    // Only GETs, always with the token.
    assert.ok(hits.length > 0 && hits.every(h => h.method === "GET" && h.auth === "Bearer pat"));
  } finally { s.close(); clearFireflyCache(); delete process.env.FIREFLY_TOKEN; }
});
