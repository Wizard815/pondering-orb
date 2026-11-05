import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { statsOf } from "../src/integrations/system.js";

const cfg = (over: any = {}) => ({ ...loadConfig("/nonexistent.yaml", {}), ...over });
const wait = (ms = 80) => new Promise(r => setTimeout(r, ms));
function serve(h: (req: any, body: string, res: any) => void): Promise<{ url: string; server: Server }> {
  return new Promise(r => { const server = createServer((req, res) => { let b = ""; req.on("data", d => (b += d)); req.on("end", () => h(req, b, res)); }).listen(0, () => r({ url: `http://127.0.0.1:${(server.address() as any).port}`, server })); });
}
const J = (res: any, o: any, c = 200, h: any = {}) => { res.writeHead(c, { "Content-Type": "application/json", ...h }); res.end(JSON.stringify(o)); };

test("TestOutbox_CalDavFailureIsQueuedAndRetried", async () => {
  let up = false; const puts: string[] = [];
  const dav = await serve((req, body, res) => {
    if (!up) { res.writeHead(503); return res.end(); }
    if (req.method === "PROPFIND") { res.writeHead(207); return res.end(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/dav/l/</d:href><d:propstat><d:prop><d:displayname>Homelab</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response></d:multistatus>`); }
    if (req.method === "REPORT") { res.writeHead(207); return res.end(`<d:multistatus xmlns:d="DAV:"/>`); }
    if (req.method === "PUT") { puts.push(req.url); res.writeHead(201, { ETag: '"1"' }); return res.end(); }
    res.writeHead(405); res.end();
  });
  try {
    const { app, outbox } = await buildApp({ config: cfg({ caldav: { ...cfg().caldav, url: dav.url + "/dav/" } }) });
    await app.inject({ method: "POST", url: "/api/c/tasks", payload: { title: "Ship it", list: "Homelab" } }); await wait();
    const q = (await app.inject({ url: "/api/outbox" })).json();
    assert.equal(q.length, 1); assert.match(q[0].label, /Ship it/);
    up = true;
    const r = (await app.inject({ method: "POST", url: "/api/outbox/retry" })).json();
    assert.equal(r.done, 1); assert.equal(puts.length, 1); assert.equal(outbox.list().length, 0);
  } finally { dav.server.close(); }
});

test("TestCalDav_DiscoversCalendarHome", async () => {
  const seen: string[] = [];
  const dav = await serve((req, body, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.depth}`);
    res.writeHead(207, { "Content-Type": "application/xml" });
    if (req.url === "/" && req.headers.depth === "1") return res.end(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>`);
    if (req.url === "/" && body.includes("current-user-principal")) return res.end(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principals/me/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>`);
    if (req.url === "/principals/me/") return res.end(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/principals/me/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/cal/me/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>`);
    if (req.url === "/cal/me/" && req.method === "PROPFIND") return res.end(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/cal/me/tasks/</d:href><d:propstat><d:prop><d:displayname>Tasks</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response></d:multistatus>`);
    return res.end(`<d:multistatus xmlns:d="DAV:"/>`);
  });
  try {
    const { app } = await buildApp({ config: cfg({ caldav: { ...cfg().caldav, url: dav.url + "/" } }) });
    const r = (await app.inject({ method: "POST", url: "/api/caldav/sync" })).json();
    assert.equal(r.lists, 1);
    assert.ok(seen.some(s => s.startsWith("REPORT /cal/me/tasks/")), "reads the discovered list");
  } finally { dav.server.close(); }
});

test("TestSystem_ContainerStatsMath", () => {
  const s = statsOf({ cpu_stats: { cpu_usage: { total_usage: 300 }, system_cpu_usage: 2000, online_cpus: 4 }, precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
    memory_stats: { usage: 300 * 1048576, limit: 1000 * 1048576, stats: { inactive_file: 100 * 1048576 } } });
  assert.deepEqual(s, { cpu: 80, memMiB: 200, memPct: 20 });
});

test("TestWidgets_PlexAndSabnzbd", async () => {
  const app3 = await serve((req, body, res) => {
    if (req.url.startsWith("/status/sessions")) { if (req.headers["x-plex-token"] !== "pt") return J(res, {}, 401); return J(res, { MediaContainer: { Metadata: [{ type: "episode", grandparentTitle: "The Expanse", parentIndex: 3, index: 4, title: "Reload", viewOffset: 600, duration: 1000, User: { title: "wiz" }, Player: { title: "TV", state: "playing" } }] } }); }
    if (req.url.startsWith("/api?mode=queue")) return J(res, { queue: { speed: "38.2 M", timeleft: "0:07:41", slots: [{ filename: "Linux.iso", percentage: "71", size: "4 GB" }] } });
    J(res, {}, 404);
  });
  process.env.TEST_PLEX = "pt"; process.env.TEST_SAB = "sk";
  try {
    const { app } = await buildApp({ config: cfg() });
    await app.inject({ method: "PUT", url: "/api/c/settings/apps", payload: { yaml: `groups:\n  - name: Media\n    apps:\n      - name: Plex\n        url: ${app3.url}\n        widget: { type: plex, key_env: TEST_PLEX }\n      - name: SABnzbd\n        widget: { type: sabnzbd, url: ${app3.url}, key_env: TEST_SAB }\n      - name: Argos\n        url: http://x\n` } });
    const plex = (await app.inject({ url: "/api/widgets/Plex" })).json();
    assert.deepEqual([plex.sessions[0].title, plex.sessions[0].progress, plex.sessions[0].user], ["The Expanse · S03E04 Reload", 60, "wiz"]);
    const sab = (await app.inject({ url: "/api/widgets/SABnzbd" })).json();
    assert.deepEqual([sab.speed, sab.queue[0].pct], ["38.2 MB/s", 71]);
    assert.equal((await app.inject({ url: "/api/widgets/Argos" })).statusCode, 404);
  } finally { app3.server.close(); }
});

test("TestChores_UpstreamDailyActionAndDigest", async () => {
  const seen: string[] = [];
  const um = await serve((req, body, res) => { seen.push(`${req.method} ${req.url}`); J(res, { ok: true, results: [] }); });
  const wikiSeen: any[] = [];
  const wk = await serve((req, body, res) => { wikiSeen.push({ m: req.method, u: decodeURIComponent(req.url), b: body }); if (req.method === "GET") { res.writeHead(404); return res.end("{}"); } res.writeHead(204); res.end(); });
  try {
    const { app, records, writeDigest } = await buildApp({ config: cfg({ upstream: { baseUrl: um.url }, wiki: { baseUrl: wk.url, tokenEnv: "", vault: "/none" } }) });
    const c: any = records.create("chores", { name: "Upstream sync", everyDays: 7, action: "upstream-daily" });
    const r = (await app.inject({ method: "POST", url: `/api/chores/${c.id}/done` })).json();
    assert.equal(r.chore.lastDone.length, 10); assert.ok(seen.includes("POST /api/run-daily"));
    const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    records.create("projects", { name: "Argos", wikiNote: "wiki/1-projects/Argos.md" });
    records.create("logs", { project: "Argos", text: "one", date: y }); records.create("logs", { project: "Argos", text: "two", date: y });
    assert.equal(await writeDigest(), "", "off by default");
    await app.inject({ method: "PUT", url: "/api/c/settings/app", payload: { wikiDigest: true } });
    assert.equal(await writeDigest(), y); await wait(150);
    const put = wikiSeen.find(s => s.m === "PUT"); assert.match(put.b, new RegExp(`Orb, ${y}: 2 log entries \\(2 on \\[\\[Argos\\]\\]\\)`));
    assert.equal(await writeDigest(), "", "only once a day");
  } finally { um.server.close(); wk.server.close(); }
});

test("TestGolem_StreamsTextAndRunsTools", async () => {
  let n = 0;
  const llm = await serve((req, body, res) => {
    n++; res.writeHead(200, { "Content-Type": "text/event-stream" });
    const ev = (o: any) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (n === 1) { ev({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "orb_add_log", arguments: '{"project":"Argos",' } }] } }] }); ev({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"text":"Tested streaming"}' } }] } }] }); }
    else { ev({ choices: [{ delta: { content: "Logged " } }] }); ev({ choices: [{ delta: { content: "**it**." } }] }); }
    res.end("data: [DONE]\n\n");
  });
  try {
    const { app, records } = await buildApp({ config: cfg({ golem: { baseUrl: llm.url + "/v1", model: "m", keyEnv: "", canWrite: true } }) });
    records.create("projects", { name: "Argos" });
    const r = await app.inject({ method: "POST", url: "/api/golem/stream", payload: { messages: [{ role: "user", content: "log it" }] } });
    assert.match(r.body, /event: tool\ndata: {"name":"orb_add_log"}/);
    assert.match(r.body, /event: text\ndata: {"delta":"Logged "}/);
    assert.match(r.body, /event: done\ndata: {"text":"Logged \*\*it\*\*\.","did":\["orb_add_log"\]}/);
    assert.equal((records.list("logs")[0] as any).text, "Tested streaming");
  } finally { llm.server.close(); }
});
