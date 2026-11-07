import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const cfg = (over: any = {}) => ({ ...loadConfig("/nonexistent.yaml", {}), ...over });

function fakeServer(handler: (req: any, body: any) => [number, any]): Promise<{ url: string; server: Server; seen: any[] }> {
  const seen: any[] = [];
  return new Promise(res => {
    const server = createServer((req, resp) => {
      let b = ""; req.on("data", d => (b += d)); req.on("end", () => {
        const body = b ? JSON.parse(b) : null; seen.push({ method: req.method, url: req.url, body, type: req.headers["content-type"] });
        const [code, out] = handler(req, body); resp.writeHead(code, { "Content-Type": "application/json" }); resp.end(JSON.stringify(out));
      });
    }).listen(0, () => res({ url: `http://127.0.0.1:${(server.address() as any).port}`, server, seen }));
  });
}

test("TestRecords_LogLengthIsEnforced", async () => {
  const { app } = await buildApp({ config: cfg() });
  const ok = await app.inject({ method: "POST", url: "/api/c/logs", payload: { project: "Argos", text: "Fixed the watcher" } });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().date.length, 10);
  const long = await app.inject({ method: "POST", url: "/api/c/logs", payload: { project: "Argos", text: "x".repeat(51) } });
  assert.equal(long.statusCode, 422);
  assert.match(long.json().error, /at most 50/);
  await app.inject({ method: "PUT", url: "/api/c/settings/app", payload: { logMax: 80 } });
  const now = await app.inject({ method: "POST", url: "/api/c/logs", payload: { text: "y".repeat(70) } });
  assert.equal(now.statusCode, 201);
});

test("TestRecords_PatchWithStaleVersionIsRefused", async () => {
  const { app } = await buildApp({ config: cfg() });
  const p = (await app.inject({ method: "POST", url: "/api/c/projects", payload: { name: "Orb" } })).json();
  assert.equal(p.status, "next");
  const a = await app.inject({ method: "PATCH", url: `/api/c/projects/${p.id}`, headers: { "if-match": String(p.version) }, payload: { status: "active" } });
  assert.equal(a.statusCode, 200);
  const b = await app.inject({ method: "PATCH", url: `/api/c/projects/${p.id}`, headers: { "if-match": String(p.version) }, payload: { status: "paused" } });
  assert.equal(b.statusCode, 409);
  const bad = await app.inject({ method: "PATCH", url: `/api/c/projects/${p.id}`, payload: { status: "done" } });
  assert.equal(bad.statusCode, 422);
  assert.equal((await app.inject({ url: "/api/c/nope" })).statusCode, 404);
});

test("TestAuth_PasswordAndTokens", async () => {
  const { app } = await buildApp({ config: cfg(), password: "pw", tokens: "hermes:tok123" });
  assert.equal((await app.inject({ url: "/api/c/projects" })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/login", payload: { password: "nope" } })).statusCode, 401);
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: "pw" } });
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  assert.equal((await app.inject({ url: "/api/c/projects", headers: { cookie } })).statusCode, 200);
  const log = await app.inject({ method: "POST", url: "/api/c/logs", headers: { authorization: "Bearer tok123" }, payload: { text: "From an agent" } });
  assert.equal(log.json().by, "hermes");
  assert.equal((await app.inject({ url: "/api/c/projects", headers: { authorization: "Bearer wrong" } })).statusCode, 401);
});

test("TestMcp_ToolsListAndCall", async () => {
  const { app, records } = await buildApp({ config: cfg(), tokens: "claude:t" });
  records.create("projects", { name: "Argos", status: "active" });
  records.create("tasks", { title: "Release notes", list: "Argos" });
  const h = { authorization: "Bearer t" };
  const init = await app.inject({ method: "POST", url: "/mcp", headers: h, payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } } });
  assert.equal(init.json().result.serverInfo.name, "pondering-orb");
  const list = await app.inject({ method: "POST", url: "/mcp", headers: h, payload: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
  assert.ok(list.json().result.tools.some((t: any) => t.name === "orb_complete_task"));
  const done = await app.inject({ method: "POST", url: "/mcp", headers: h, payload: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "orb_complete_task", arguments: { title: "release notes" } } } });
  assert.equal(done.json().result.isError, undefined);
  const logs = records.list("logs") as any[];
  assert.equal(logs[0].text, "Done: Release notes"); assert.equal(logs[0].by, "claude"); assert.equal(logs[0].project, "Argos");
  const tooLong = await app.inject({ method: "POST", url: "/mcp", headers: h, payload: { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "orb_add_log", arguments: { project: "Argos", text: "z".repeat(60) } } } });
  assert.equal(tooLong.json().result.isError, true);
});

test("TestUpstream_DecideSendsJsonAndSplitsComponents", async () => {
  const reqs = [{ id: "ag:main:c", repo_id: "ag", type: "components", components: [{ name: "apps/a" }, { name: "apps/b" }], status: "pending" }];
  const fake = await fakeServer((req, body) => {
    if (req.url === "/api/requests") return [200, reqs];
    if (req.url.endsWith("/components/request")) return [200, { ok: true, request: { id: "ag:main:c2" } }];
    if (req.url.includes("/decide")) return [200, { ok: true, request: { id: req.url.split("/")[3], status: body.decision === "approve" ? "approved" : "denied" } }];
    return [404, { error: "nope" }];
  });
  try {
    const { app } = await buildApp({ config: cfg({ upstream: { baseUrl: fake.url } }) });
    const r = await app.inject({ method: "POST", url: "/api/upstream/request/ag:main:c/decide", payload: { decision: "approve", only: ["apps/a"], comment: "ok" } });
    assert.equal(r.statusCode, 200);
    const posts = fake.seen.filter(s => s.method === "POST");
    assert.deepEqual(posts.map(p => p.url), ["/api/request/ag%3Amain%3Ac/decide", "/api/repo/ag/components/request", "/api/request/ag%3Amain%3Ac2/decide"]);
    assert.deepEqual(posts.map(p => p.body.decision ?? p.body.names), ["deny", ["apps/a"], "approve"]);
    assert.ok(posts.every(p => p.type === "application/json"));
  } finally { fake.server.close(); }
});

test("TestPoller_LogsOnlyNewCommits", async () => {
  let items = [{ full: "c1", sha: "c1", subject: "first", date: "2026-11-01T10:00:00Z" }];
  const fake = await fakeServer(() => [200, { ok: true, items }]);
  try {
    const { app, records } = await buildApp({ config: cfg({ upstream: { baseUrl: fake.url } }) });
    records.create("projects", { name: "Argos", upstreamRepo: "argos", logCommits: true }, "argos");
    await app.inject({ method: "POST", url: "/api/upstream/poll" });
    assert.equal(records.list("logs").length, 0, "first run only remembers the branch tip");
    items = [{ full: "c3", sha: "c3", subject: "third commit with a very long subject line that goes on", date: "2026-11-03T10:00:00Z" }, { full: "c2", sha: "c2", subject: "second", date: "2026-11-02T10:00:00Z" }, ...items];
    await app.inject({ method: "POST", url: "/api/upstream/poll" });
    const logs = (records.list("logs") as any[]).sort((a, b) => a.created - b.created).map(l => l.text);
    assert.deepEqual(logs, ["second", "third commit with a very long subject line that g…"]);
    await app.inject({ method: "POST", url: "/api/upstream/poll" });
    assert.equal(records.list("logs").length, 2);
  } finally { fake.server.close(); }
});

test("TestUptime_NormalizesStatusPage", async () => {
  const fake = await fakeServer(req => req.url.includes("heartbeat")
    ? [200, { heartbeatList: { "1": [{ status: 1, ping: 12 }], "2": [{ status: 1 }, { status: 0, ping: null }] }, uptimeList: { "1_24": 0.999, "2_24": 0.9 } }]
    : [200, { publicGroupList: [{ name: "Tower", monitorList: [{ id: 1, name: "Argos" }, { id: 2, name: "Odysseus" }] }] }]);
  try {
    const { app } = await buildApp({ config: cfg({ uptime: { baseUrl: fake.url, statusPage: "orb" } }) });
    const r = (await app.inject({ url: "/api/uptime" })).json();
    assert.deepEqual(r.monitors.map((m: any) => [m.name, m.status, m.uptime24]), [["Argos", "up", 99.9], ["Odysseus", "down", 90]]);
  } finally { fake.server.close(); }
});

test("TestSystem_ReadsProc", async () => {
  const { app } = await buildApp({ config: cfg() });
  const r = (await app.inject({ url: "/api/system" })).json();
  assert.ok(r.hosts[0].cores.length > 0);
  assert.ok(r.hosts[0].mem >= 0 && r.hosts[0].mem <= 100);
});

test("TestMcp_StartTaskMarksInProgress", async () => {
  const { app, records } = await buildApp({ config: cfg(), tokens: "studio:t" });
  records.create("projects", { name: "Argos", status: "next" });
  const task: any = records.create("tasks", { title: "Fix flaky login", list: "Argos" });
  const h = { authorization: "Bearer t" };
  const call = (name: string, args: any) => app.inject({ method: "POST", url: "/mcp", headers: h, payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
  assert.equal((await call("orb_start_task", { title: "fix flaky login", list: "Argos" })).json().result.isError, undefined);
  assert.equal((records.get("tasks", task.id) as any).started, true);
  const listed = JSON.parse((await call("orb_list_tasks", {})).json().result.content[0].text);
  assert.equal(listed[0].inProgress, true);
  assert.equal((records.list("logs") as any[])[0].text, "Started: Fix flaky login");
  // A second start is a no-op; completing clears in progress.
  assert.match((await call("orb_start_task", { title: "Fix flaky login" })).json().result.content[0].text, /already/);
  assert.equal((records.list("logs") as any[]).length, 1);
  await call("orb_complete_task", { title: "Fix flaky login" });
  assert.equal((records.get("tasks", task.id) as any).started, false);
});

test("TestMcp_AgentStatusFollowsHerdr", async () => {
  const { app, records } = await buildApp({ config: cfg(), tokens: "studio:t" });
  const proj: any = records.create("projects", { name: "Argos", status: "next" });
  const task: any = records.create("tasks", { title: "Fix login", list: "Argos" });
  const h = { authorization: "Bearer t" };
  const call = async (args: any) => (await app.inject({ method: "POST", url: "/mcp", headers: h, payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "orb_set_agent_status", arguments: args } } })).json().result;
  const t = { title: "Fix login", list: "Argos" };
  await call({ task: t, status: "working", agent: "claude" });
  let cur: any = records.get("tasks", task.id);
  assert.equal(cur.started, true); assert.equal(cur.agent.status, "working"); assert.equal(cur.agent.name, "claude");
  await call({ task: t, status: "blocked" });
  assert.equal((records.get("tasks", task.id) as any).agent.status, "blocked");
  // The pane closed before the task was finished: open again.
  await call({ task: t, status: "gone" });
  cur = records.get("tasks", task.id);
  assert.equal(cur.agent, null); assert.equal(cur.started, false);
  // Projects: working moves next → active.
  await call({ project: "argos", status: "working", agent: "codex" });
  cur = records.get("projects", proj.id);
  assert.equal(cur.status, "active"); assert.equal(cur.agent.status, "working");
  assert.equal((await call({ task: t, status: "sleeping" })).isError, true);
});
