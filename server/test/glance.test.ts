import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const cfg = (over: any = {}) => ({ ...loadConfig("/nonexistent.yaml", {}), ...over });

test("TestPriority_ToolsUseVikunjasFiveLevels", async () => {
  const { app, records } = await buildApp({ config: cfg(), tokens: "a:t" });
  const call = async (name: string, args: any) => (await app.inject({ method: "POST", url: "/mcp", headers: { authorization: "Bearer t" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } })).json().result;
  await call("orb_add_task", { title: "Ship", list: "Homelab", priority: "high" });
  assert.equal((records.list("tasks")[0] as any).priority, 3, "high is CalDAV 3, which vikunja reads as High");
  await call("orb_set_task_priority", { title: "ship", priority: "do_now" });
  assert.equal((records.list("tasks")[0] as any).priority, 1);
  const listed = JSON.parse((await call("orb_list_tasks", {})).content[0].text);
  assert.equal(listed[0].priority, "do_now");
  records.create("tasks", { title: "Other", list: "Homelab", priority: 7 });
  assert.equal(JSON.parse((await call("orb_list_tasks", {})).content[0].text)[1].priority, "low");
  assert.equal((await call("orb_set_task_priority", { title: "Ship", priority: "huge" })).isError, true);
});

test("TestAllGlance_ReadsDayInboxChoresWithToken", async () => {
  const seen: any[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    const J = (o: any, c = 200) => { res.writeHead(c, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== "Bearer gw") return J({ error: "no" }, 401);
    if (req.url!.startsWith("/api/allglance/days/2026-11-05")) return J({ date: "2026-11-05", blocks: [{ id: 2, title: "Lunch", startTime: "12:00", duration: 45 }, { id: 1, title: "Standup", start_time: "09:30", duration_minutes: 15 }], tasks: {} });
    if (req.url === "/api/allglance/tasks") return J({ vikunja: [{ id: 9, title: "skip me" }], dayglance: [{ id: "d1", title: "Plan trip", completed: false, priority: 3, priority_label: "high" }, { id: "d2", title: "Old gateway", completed: false, extra: { priority: 2 } }] });
    if (req.url === "/api/allglance/chores") return J({ chores: [{ id: "c1", title: "Dishes", last_completed: "2026-11-04T08:00:00Z" }] });
    J({ error: "nope" }, 404);
  }).listen(0);
  await new Promise(r => server.once("listening", r));
  process.env.TEST_GW_TOKEN = "gw";
  try {
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const { app } = await buildApp({ config: cfg({ allglance: { baseUrl: url, tokenEnv: "TEST_GW_TOKEN" } }) });
    const day = (await app.inject({ url: "/api/allglance/day?date=2026-11-05" })).json();
    assert.deepEqual(day.blocks.map((b: any) => [b.start, b.title, b.minutes]), [["09:30", "Standup", 15], ["12:00", "Lunch", 45]]);
    const inbox = (await app.inject({ url: "/api/allglance/dayglance-tasks" })).json();
    assert.deepEqual(inbox.map((t: any) => [t.title, t.priority]), [["Plan trip", 3], ["Old gateway", 2]], "only dayGLANCE tasks; priority read from either shape");
    const chores = (await app.inject({ url: "/api/allglance/chores" })).json();
    assert.equal(chores[0].lastDone, "2026-11-04");
    assert.ok(seen.every(s => s.auth === "Bearer gw"));
    assert.equal((await app.inject({ url: "/api/allglance/day?date=nope" })).statusCode, 400);
    delete process.env.TEST_GW_TOKEN;
    const r = await app.inject({ url: "/api/allglance/chores" });
    assert.equal(r.statusCode, 502); assert.match(r.json().error, /GATEWAY_TOKEN/);
  } finally { server.close(); }
});
