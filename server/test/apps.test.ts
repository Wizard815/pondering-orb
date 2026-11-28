import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { mediaAlerts } from "../src/notify.js";
import { headline, mediaLine } from "../src/apps.js";
import { today } from "../src/dates.js";

const cfg = (over: any = {}) => ({ ...loadConfig("/nonexistent.yaml", {}), ...over });
function serve(h: (req: any, res: any) => void): Promise<{ url: string; server: Server }> {
  return new Promise(r => { const server = createServer(h).listen(0, () => r({ url: `http://127.0.0.1:${(server.address() as any).port}`, server })); });
}
const J = (res: any, o: any, c = 200) => { res.writeHead(c, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };

test("TestApps_DeviceSignInKeySessionAndRemove", async () => {
  const { app } = await buildApp({ config: cfg(), password: "hunter22" });
  // Wrong password: refused, and counted like the web sign-in.
  const bad = await app.inject({ method: "POST", url: "/api/devices", payload: { password: "nope", name: "Laptop", platform: "linux" } });
  assert.equal(bad.statusCode, 401);
  const ok = await app.inject({ method: "POST", url: "/api/devices", payload: { password: "hunter22", name: "Laptop", platform: "linux" } });
  assert.equal(ok.statusCode, 200);
  const dev = ok.json();
  assert.match(dev.token, /^orbd_/); assert.equal(dev.name, "Laptop"); assert.equal(dev.platform, "linux");
  const H = { authorization: `Bearer ${dev.token}` };
  // The key acts as you: it can read and change settings-level things.
  assert.equal((await app.inject({ url: "/api/me", headers: H })).json().who, "you");
  const list = (await app.inject({ url: "/api/devices", headers: H })).json();
  assert.deepEqual(list.map((d: any) => d.name), ["Laptop"]);
  assert.ok(!JSON.stringify(list).includes(dev.token), "keys are never listed");
  // The key buys the web view a session cookie, which works on its own.
  const s = await app.inject({ method: "POST", url: "/api/devices/session", headers: H });
  assert.equal(s.statusCode, 200);
  const cookie = s.cookies.find((c: any) => c.name === "orb_session");
  assert.ok(cookie && cookie.httpOnly);
  assert.equal(s.json().session, cookie!.value);
  assert.equal((await app.inject({ url: "/api/me", cookies: { orb_session: cookie!.value } })).statusCode, 200);
  // Removing the device signs its key out.
  assert.equal((await app.inject({ method: "DELETE", url: `/api/devices/${dev.id}`, headers: H })).statusCode, 204);
  assert.equal((await app.inject({ url: "/api/me", headers: H })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/devices/session", headers: H })).statusCode, 401);
  // A made-up key, or an agent token, can't buy a session.
  assert.equal((await app.inject({ method: "POST", url: "/api/devices/session", headers: { authorization: "Bearer orbd_madeup" } })).statusCode, 401);
});

test("TestApps_DeviceSignInIsRateLimited", async () => {
  const { app } = await buildApp({ config: cfg(), password: "hunter22" });
  for (let i = 0; i < 10; i++) await app.inject({ method: "POST", url: "/api/devices", payload: { password: "wrong" + i } });
  const r = await app.inject({ method: "POST", url: "/api/devices", payload: { password: "hunter22" } });
  assert.equal(r.statusCode, 429); assert.match(r.json().error, /Too many wrong passwords/);
  // The web sign-in shares the same count.
  assert.equal((await app.inject({ method: "POST", url: "/api/login", payload: { password: "hunter22" } })).statusCode, 429);
});

test("TestApps_AgentTokensCantManageDevices", async () => {
  const { app } = await buildApp({ config: cfg(), password: "hunter22", tokens: "hermes:tk_agent" });
  const r = await app.inject({ url: "/api/devices", headers: { authorization: "Bearer tk_agent" } });
  assert.equal(r.statusCode, 403);
});

test("TestApps_AlertsReachAppsWithoutNtfy", async () => {
  let plex = 0;
  const kuma = await serve((req, res) => {
    if (req.url === "/api/status-page/orb") return J(res, { publicGroupList: [{ name: "Media", monitorList: [{ id: 1, name: "Plex" }] }] });
    if (req.url === "/api/status-page/heartbeat/orb") return J(res, { heartbeatList: { 1: [{ status: plex }] }, uptimeList: {} });
    J(res, {}, 404);
  });
  try {
    const { app, notifier } = await buildApp({ config: cfg({ uptime: { ...cfg().uptime, baseUrl: kuma.url } }), password: "pw" });
    // No ntfy and no device: nothing is checked.
    assert.deepEqual(await notifier.uptimeTick(), { sent: 0 });
    const dev = (await app.inject({ method: "POST", url: "/api/devices", payload: { password: "pw", name: "Phone", platform: "android" } })).json();
    const H = { authorization: `Bearer ${dev.token}` };
    const start = Date.now() - 1;
    await notifier.uptimeTick();
    const a = (await app.inject({ url: `/api/alerts?since=${start}`, headers: H })).json();
    assert.deepEqual(a.alerts.map((x: any) => x.title), ["Plex is down"]);
    assert.equal(a.alerts[0].event, "uptime");
    // since= leaves out what the app has already shown.
    assert.equal((await app.inject({ url: `/api/alerts?since=${a.alerts[0].at}`, headers: H })).json().alerts.length, 0);
    // The glance shows the outage too.
    const g = (await app.inject({ url: "/api/glance", headers: H })).json();
    assert.deepEqual(g.uptime, { total: 1, down: ["Plex"] });
    assert.equal(g.alerts, 1);
  } finally { kuma.server.close(); }
});

test("TestApps_GlanceTasksAndTickOff", async () => {
  const { app, records } = await buildApp({ config: cfg() });
  const t1: any = records.create("tasks", { title: "Renew domain", priority: 2, due: "2020-01-01", done: false });
  records.create("tasks", { title: "Later thing", priority: 9, done: false });
  records.create("tasks", { title: "Old", done: true });
  records.create("daily", { date: today(), brief: "## Good morning, Wizard! Rain by noon.\n\n**Today** ..." }, today());
  const g = (await app.inject({ url: "/api/glance" })).json();
  assert.deepEqual(g.tasks.map((t: any) => t.title), ["Renew domain", "Later thing"]);
  assert.equal(g.tasks[0].overdue, true);
  assert.equal(g.brief.headline, "Good morning, Wizard! Rain by noon.");
  assert.equal(g.uptime, null, "parts that aren't set up are left out");
  assert.deepEqual(g.errors, []);
  assert.equal((await app.inject({ method: "POST", url: `/api/glance/tasks/${t1.id}/done` })).statusCode, 200);
  const done: any = records.get("tasks", t1.id);
  assert.equal(done.done, true); assert.equal(done.doneAt, today()); assert.equal(done.doneBy, "you");
  assert.equal((await app.inject({ method: "POST", url: "/api/glance/tasks/nope/done" })).statusCode, 404);
});

test("TestApps_MediaAlerts", () => {
  const first = mediaAlerts({}, [
    { name: "Seerr", type: "seerr", data: { pending: 2 } },
    { name: "Sonarr", type: "sonarr", data: { queue: [{ title: "Show S01E01" }, { title: "Show S01E02" }], queueTotal: 2 } },
  ]);
  assert.equal(first.notes.length, 0, "the first look only remembers");
  const next = mediaAlerts(first.state, [
    { name: "Seerr", type: "seerr", data: { pending: 3 } },
    { name: "Sonarr", type: "sonarr", data: { queue: [{ title: "Show S01E02", warning: true }], queueTotal: 1 } },
  ]);
  assert.deepEqual(next.notes.map(n => n.title), ["A new request on Seerr", "Downloaded: Show S01E01", "Show S01E02 is stuck"]);
  // Nothing new: nothing sent, and a stuck item is announced once.
  assert.equal(mediaAlerts(next.state, [{ name: "Sonarr", type: "sonarr", data: { queue: [{ title: "Show S01E02", warning: true }], queueTotal: 1 } }]).notes.length, 0);
  // A list that only got longer doesn't count items pushed off its end as downloaded.
  const s1 = mediaAlerts({}, [{ name: "Radarr", type: "radarr", data: { queue: [{ title: "A" }], queueTotal: 9 } }]).state;
  assert.equal(mediaAlerts(s1, [{ name: "Radarr", type: "radarr", data: { queue: [{ title: "B" }], queueTotal: 10 } }]).notes.length, 0);
});

test("TestApps_LinesForWidgets", () => {
  assert.equal(headline("# **Morning**, *Wizard*\nmore"), "Morning, Wizard");
  assert.equal(mediaLine("plex", { sessions: [] }), "Nothing playing");
  assert.equal(mediaLine("plex", { sessions: [{ title: "Dune", user: "Robin" }] }), "Playing: Dune (Robin)");
  assert.equal(mediaLine("sabnzbd", { queue: [{}, {}], speed: "4 MB/s", timeleft: "0:10:00" }), "4 MB/s · 2 in queue · 0:10:00 left");
  assert.equal(mediaLine("seerr", { pending: 1 }), "1 request waiting");
  assert.equal(mediaLine("radarr", { queue: [{ warning: true }], queueTotal: 1, upcoming: [{ title: "Film" }] }), "1 downloading (1 stuck) · next: Film");
});
