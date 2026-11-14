import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { clearCoinpileCache, clearCoinpileMcp, cpMcpTools } from "../src/integrations/coinpile.js";
import { localDay } from "../src/dates.js";

const cfg = (over: any = {}) => ({ ...loadConfig("/nonexistent.yaml", {}), ...over });
const day = (k: number) => localDay(Date.now() + k * 864e5);
function serve(h: (req: any, body: string, res: any) => void): Promise<{ url: string; server: Server }> {
  return new Promise(r => { const server = createServer((req, res) => { let b = ""; req.on("data", d => (b += d)); req.on("end", () => h(req, b, res)); }).listen(0, () => r({ url: `http://127.0.0.1:${(server.address() as any).port}`, server })); });
}
const J = (res: any, o: unknown, c = 200) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };

/** A Coinpile: the Orb summary with the newer shared parts, and its MCP endpoint (POST /api/v1/mcp). */
function fakeCoinpile(calls: any[]) {
  return serve((req, body, res) => {
    if (req.url === "/api/v1/summary") {
      if (req.headers.authorization !== "Bearer cp_orb") return J(res, { detail: "invalid token" }, 401);
      return J(res, { goblins: { wiz: { name: "wiz", goals: [{ name: "Vacation", target: 2000, allocated: 400, pct: 0.2, by: "2027-06-01" }],
        budgets: { month: day(0).slice(0, 7), limit: 400, spent: 372, left: 28, items: [{ name: "Groceries", limit: 400, spent: 372, left: 28 }] },
        paycheck: { date: day(2), amount: 2500, bills: 1500, piggy_banks: 228.57, left: 771.43, until: day(32) },
        week: { from: day(-6), to: day(0), money_in: 0, money_out: 80, out_change: 50, net_worth_change: -80, bills_next_7_days: 15.99, biggest: [{ name: "Costco run", amount: -60 }], alerts: 1 } } } });
    }
    if (req.url === "/api/v1/mcp" && req.method === "POST") {
      if (req.headers.authorization !== "Bearer cp_mcp") return J(res, { detail: "this token does not have the 'mcp' scope" }, 403);
      const m = JSON.parse(body); calls.push(m.method === "tools/call" ? m.params : m.method);
      if (m.id === undefined) { res.writeHead(202); return res.end(); }
      const ok = (result: unknown) => J(res, { jsonrpc: "2.0", id: m.id, result });
      if (m.method === "initialize") return ok({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "coinpile", version: "1" } });
      if (m.method === "tools/list") return ok({ tools: [
        { name: "calculate", description: "The calculator.", inputSchema: { type: "object", properties: { expression: { type: "string" } } }, annotations: { readOnlyHint: true } },
        { name: "record_transaction", description: "ASKS THE USER FIRST, nothing happens until they say yes. Record a transaction in Firefly III.", inputSchema: { type: "object", properties: { amount: { type: "number" } } }, annotations: { readOnlyHint: false } }] });
      if (m.method === "tools/call" && m.params.name === "calculate") return ok({ content: [{ type: "text", text: JSON.stringify({ expression: m.params.arguments.expression, result: 1500 }) }], isError: false });
      if (m.method === "tools/call") return ok({ content: [{ type: "text", text: JSON.stringify({ status: "waiting for the user's yes or no", action_id: 7 }) }], isError: false });
    }
    J(res, { detail: "not here" }, 404);
  });
}

test("TestCoinpile_BudgetsPaycheckWeekAndGoalDatesReachTheWidgetAndBrief", async () => {
  process.env.CP_ORB = "cp_orb";
  const cp = await fakeCoinpile([]);
  clearCoinpileCache();
  try {
    const { app, daily } = await buildApp({ config: cfg() });
    await app.inject({ method: "PUT", url: "/api/c/settings/apps", payload: { yaml: `groups:\n  - name: Money\n    apps:\n      - name: Coinpile\n        url: ${cp.url}\n        widget: { type: coinpile, key_env: CP_ORB }\n` } });
    const w = (await app.inject({ method: "GET", url: "/api/widgets/Coinpile" })).json();
    assert.deepEqual(w.goals[0], { name: "Vacation", target: 2000, allocated: 400, pct: 0.2, by: "2027-06-01" });
    assert.deepEqual(w.budgets.items, [{ name: "Groceries", limit: 400, spent: 372, left: 28 }]);
    assert.deepEqual(w.paycheck, { date: day(2), amount: 2500, bills: 1500, piggyBanks: 228.57, left: 771.43, until: day(32) });
    assert.equal(w.week.moneyOut, 80); assert.deepEqual(w.week.biggest, [{ name: "Costco run", amount: -60 }]);
    const g: any = await daily.gather();
    assert.deepEqual(g.coinpile.budgetsNearLimit, [{ name: "Groceries", spent: 372, limit: 400, pctUsed: 93 }], "93% used: near the limit");
    assert.equal(g.coinpile.nextPaycheck.left, 771.43, "it lands this week");
    assert.equal(g.coinpile.thisWeek.vsLastWeek, 50);
  } finally { cp.server.close(); }
});

test("TestCoinpile_OldSummaryStillWorks", async () => {
  process.env.CP_ORB = "cp_orb";
  const cp = await serve((req, _b, res) => J(res, { goblins: { me: { name: "me", net_worth: 10, goals: [{ name: "Old goal", target: 5, allocated: 1, pct: 0.2 }] } } }));
  clearCoinpileCache();
  try {
    const { app } = await buildApp({ config: cfg() });
    await app.inject({ method: "PUT", url: "/api/c/settings/apps", payload: { yaml: `groups:\n  - name: Money\n    apps:\n      - name: Old Coinpile\n        url: ${cp.url}\n        widget: { type: coinpile, key_env: CP_ORB }\n` } });
    const w = (await app.inject({ method: "GET", url: "/api/widgets/Old%20Coinpile" })).json();
    assert.equal(w.netWorth, 10); assert.equal(w.goals[0].by, null); assert.equal(w.budgets, null); assert.equal(w.paycheck, null); assert.equal(w.week, null);
  } finally { cp.server.close(); }
});

test("TestCoinpile_GolemUsesCoinpileToolsOverMcp", async () => {
  process.env.CP_ORB = "cp_orb"; process.env.CP_MCP = "cp_mcp";
  const calls: any[] = [];
  const cp = await fakeCoinpile(calls);
  let n = 0, toolsSeen: string[] = [];
  const llm = await serve((req, body, res) => {
    n++; const b = JSON.parse(body); if (n === 1) toolsSeen = (b.tools || []).map((t: any) => t.function.name);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const ev = (o: any) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (n === 1) ev({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "coinpile_calculate", arguments: '{"expression":"2500-1000"}' } }] } }] });
    else ev({ choices: [{ delta: { content: "1500 left." } }] });
    res.end("data: [DONE]\n\n");
  });
  clearCoinpileCache(); clearCoinpileMcp();
  try {
    const { app } = await buildApp({ config: cfg({ golem: { baseUrl: llm.url + "/v1", model: "m", keyEnv: "", canWrite: false } }) });
    await app.inject({ method: "PUT", url: "/api/c/settings/apps", payload: { yaml: `groups:\n  - name: Money\n    apps:\n      - name: Coinpile\n        url: ${cp.url}\n        widget: { type: coinpile, key_env: CP_ORB, mcp_key_env: CP_MCP }\n` } });
    const r = await app.inject({ method: "POST", url: "/api/golem/stream", payload: { messages: [{ role: "user", content: "how much is left after rent?" }] } });
    assert.ok(toolsSeen.includes("coinpile_calculate") && toolsSeen.includes("coinpile_record_transaction"), "Coinpile's tools join Golem's");
    assert.match(r.body, /event: tool\ndata: {"name":"coinpile_calculate"}/);
    assert.match(r.body, /1500 left\./);
    assert.deepEqual(calls.filter(c => typeof c === "object"), [{ name: "calculate", arguments: { expression: "2500-1000" } }]);
  } finally { cp.server.close(); llm.server.close(); }
});

test("TestCoinpile_McpToolsDescribeAskFirstAndNeedTheirOwnToken", async () => {
  process.env.CP_MCP = "cp_mcp"; process.env.CP_WRONG = "cp_orb";
  const cp = await fakeCoinpile([]);
  clearCoinpileMcp();
  try {
    assert.deepEqual(await cpMcpTools({ name: "Coinpile", url: cp.url }), [], "no mcp_key_env: no tools");
    assert.deepEqual(await cpMcpTools({ name: "Coinpile", url: cp.url, mcpKeyEnv: "CP_WRONG" }), [], "a token without the mcp scope: no tools, and Golem still works");
    const t = await cpMcpTools({ name: "Coinpile", url: cp.url, mcpKeyEnv: "CP_MCP" });
    const rec = t.find(x => x.name === "coinpile_record_transaction")!;
    assert.match(rec.description, /ASKS FIRST: only creates a request the user approves on Coinpile's Agent page/);
    assert.doesNotMatch(rec.description, /ASKS THE USER FIRST, nothing happens/);
    assert.equal(rec.write, undefined, "it changes nothing by itself, so it is offered even when Golem may not write");
    assert.deepEqual(await rec.run({ amount: -4 }, "you"), { status: "waiting for the user's yes or no", action_id: 7 });
  } finally { cp.server.close(); }
});
