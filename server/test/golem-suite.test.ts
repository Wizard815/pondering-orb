import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp, cfg, serve, J, fakeLlm } from "./support/golem-money.js";

const WRITES = ["upstream_decide", "upstream_fetch", "upstream_run_daily", "caldav_sync", "wiki_edit_section", "wiki_daily_log", "allglance_add_event", "hermes_launch"];

test("TestGolemSuite_ToolsFollowTheConnectionsAndWritesAreWriteTools", async () => {
  const llm = await fakeLlm(() => ({ content: "ok" }));
  try {
    // Nothing connected: only the host, the apps list and Orb's own tools.
    const { app: bare } = await buildApp({ config: cfg({ golem: { baseUrl: llm.url + "/v1", model: "m", keyEnv: "", canWrite: true } }) });
    await bare.inject({ method: "POST", url: "/api/golem", payload: { messages: [{ role: "user", content: "hi" }] } });
    const none = llm.bodies[0].tools.map((t: any) => t.function.name);
    assert.ok(none.includes("system_status") && none.includes("apps_list"));
    for (const n of ["upstream_repos", "uptime_status", "milaclone_search", "hermes_launch", "proxy_sites", "app_live", "allglance_add_event"]) assert.ok(!none.includes(n), `${n} offered without its connection`);

    // Everything connected.
    const base = cfg({ golem: { baseUrl: llm.url + "/v1", model: "m", keyEnv: "", canWrite: true } });
    const all = { ...base, upstream: { baseUrl: "http://up" }, uptime: { ...base.uptime, baseUrl: "http://kuma" }, caldav: { ...base.caldav, url: "http://dav/" }, wiki: { ...base.wiki, baseUrl: "http://wiki" },
      allglance: { baseUrl: "http://glance", tokenEnv: "" }, npm: { ...base.npm, baseUrl: "http://npm" }, unraid: { ...base.unraid, baseUrl: "http://unraid" }, milaclone: { url: "http://mila" }, hermes: { ...base.hermes, baseUrl: "http://hermes" } };
    for (const canWrite of [true, false]) {
      const { app } = await buildApp({ config: { ...all, golem: { ...all.golem, canWrite } } });
      await app.inject({ method: "PUT", url: "/api/c/settings/apps", payload: { yaml: "groups:\n  - name: Media\n    apps:\n      - name: SABnzbd\n        url: http://sab\n        widget: { type: sabnzbd }\n" } });
      const before = llm.bodies.length;
      await app.inject({ method: "POST", url: "/api/golem", payload: { messages: [{ role: "user", content: "hi" }] } });
      const names = llm.bodies[before].tools.map((t: any) => t.function.name);
      for (const n of ["upstream_repos", "upstream_requests", "uptime_status", "calendar_events", "allglance_chores", "proxy_sites", "server_containers", "milaclone_search", "milaclone_todos", "milaclone_pipeline", "hermes_agents", "hermes_work", "hermes_search_chats", "apps_list", "app_live"])
        assert.ok(names.includes(n), `${n} missing`);
      for (const n of WRITES) assert.equal(names.includes(n), canWrite, `${n} ${canWrite ? "missing" : "offered while read-only"}`);
      const mcp = (await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).json().result.tools.map((t: any) => t.name);
      assert.ok(!mcp.some((n: string) => n.startsWith("upstream_") || n === "app_live" || n === "hermes_launch"), "agents on /mcp don't get the suite tools");
    }
  } finally { llm.close(); }
});

test("TestGolemSuite_LiveAppDataAndChangesGoWhereTheyShould", async () => {
  const hits: string[] = [];
  const world = await serve((req, body, res) => {
    hits.push(`${req.method} ${req.url} ${body}`);
    if (req.url.startsWith("/sab/api")) return J(res, { queue: { speed: "12.4 M", timeleft: "0:14:02", paused: false, sizeleft: "8.2 GB", slots: [{ filename: "Ubuntu.iso", percentage: "62", size: "5.1 GB", status: "Downloading" }] } });
    if (req.url === "/up/api/requests") return J(res, [{ id: "r1", repo_id: "orb", type: "merge", components: [] }]);
    if (req.url.startsWith("/up/api/request/r1/decide")) return J(res, { ok: true });
    J(res, {}, 404);
  });
  const script = [
    { tool_calls: [{ name: "app_live", args: { app: "sabnzbd" } }] },
    { tool_calls: [{ name: "upstream_decide", args: { request: "r1", decision: "approve" } }] },
    { tool_calls: [{ name: "allglance_add_event", args: { title: "Vet", date: "2026-02-31" } }] },
    { content: "done" },
  ];
  process.env.SAB_KEY = "k";
  const llm = await fakeLlm(n => script[Math.min(n - 1, script.length - 1)]);
  try {
    const base = cfg({ golem: { baseUrl: llm.url + "/v1", model: "m", keyEnv: "", canWrite: true } });
    const { app } = await buildApp({ config: { ...base, upstream: { baseUrl: world.url + "/up" }, allglance: { baseUrl: world.url + "/glance", tokenEnv: "" } } });
    await app.inject({ method: "PUT", url: "/api/c/settings/apps", payload: { yaml: `groups:\n  - name: Media\n    apps:\n      - name: SABnzbd\n        url: ${world.url}/sab\n        widget: { type: sabnzbd, key_env: SAB_KEY }\n` } });
    const r = (await app.inject({ method: "POST", url: "/api/golem", payload: { messages: [{ role: "user", content: "go" }] } })).json();
    const toolMsgs = llm.bodies[3].messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);
    assert.match(toolMsgs[0], /12\.4 M/); assert.match(toolMsgs[0], /8\.2 GB/); assert.match(toolMsgs[0], /Ubuntu\.iso/);
    // SABnzbd is outside text: the approval in the same turn waits for a yes.
    assert.match(toolMsgs[1], /Not done/); assert.ok(!hits.some(h => h.includes("/decide")));
    assert.match(toolMsgs[2], /Not done|date must be/);
    assert.ok(!hits.some(h => h.startsWith("POST /glance")), "no event with an impossible date");
    assert.deepEqual(r.did, []);
    // A turn that read nothing from outside: the approval goes to UpstreamManager.
    const llm2 = await fakeLlm(n => n === 1 ? { tool_calls: [{ name: "upstream_decide", args: { request: "r1", decision: "approve" } }] } : { content: "Approved." });
    const { app: app2 } = await buildApp({ config: { ...base, golem: { ...base.golem, baseUrl: llm2.url + "/v1" }, upstream: { baseUrl: world.url + "/up" } } });
    assert.deepEqual((await app2.inject({ method: "POST", url: "/api/golem", payload: { messages: [{ role: "user", content: "approve r1" }] } })).json().did, ["upstream_decide"]);
    assert.ok(hits.some(h => h.startsWith("POST /up/api/request/r1/decide") && h.includes('"approve"')));
    llm2.close();
  } finally { world.close(); llm.close(); delete process.env.SAB_KEY; }
});
