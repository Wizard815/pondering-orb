import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.js";
import { Scripts, parseCron, cronMatches, nextRun } from "../src/scripts.js";
import { sitesFrom, plan, ORB_MARK, appSites, serverSites, APP_OK } from "../src/integrations/kumasync.js";

const at = (s: string) => new Date(s); // local time, no zone suffix

test("TestScripts_Cron", () => {
  assert.equal(parseCron("* * *"), null, "five fields");
  assert.equal(parseCron("60 * * * *"), null, "minute out of range");
  assert.equal(parseCron("*/0 * * * *"), null, "zero step");
  const q = parseCron("*/15 * * * *")!;
  assert.ok(cronMatches(q, at("2026-11-19T10:30:00")));
  assert.ok(!cronMatches(q, at("2026-11-19T10:31:00")));
  const work = parseCron("0 8-18/2 * * 1-5")!;
  assert.ok(cronMatches(work, at("2026-11-19T10:00:00")), "Thursday 10:00");
  assert.ok(!cronMatches(work, at("2026-11-22T10:00:00")), "Sunday");
  assert.ok(cronMatches(parseCron("0 0 * * 7")!, at("2026-11-22T00:00:00")), "7 is Sunday");
  // Both day fields restricted: either one matches, like cron.
  const either = parseCron("0 0 1 * 1")!;
  assert.ok(cronMatches(either, at("2026-11-01T00:00:00")) && cronMatches(either, at("2026-11-23T00:00:00")));
  assert.equal(nextRun(parseCron("30 6 * * *")!, at("2026-11-19T07:00:00"))!.toString(), at("2026-11-20T06:30:00").toString());
});

test("TestScripts_KumaPlan", () => {
  const sites = sitesFrom([
    { names: ["a.example.com", "www.a.example.com"], https: true },
    { names: ["b.example.com"], https: false },
    { names: ["skip.example.com"], https: true },
    { names: ["*.example.com"], https: true },
  ], ["skip"]);
  assert.deepEqual(sites.map(s => s.url), ["https://a.example.com/", "http://b.example.com/", "https://www.a.example.com/"]);
  const p = plan(sites, [
    { id: 1, name: "a", url: "https://A.example.com", active: 1 },                       // yours, already there
    { id: 2, name: "gone", url: "https://gone.example.com/", description: ORB_MARK, active: 1 }, // Orb's, no longer proxied
    { id: 3, name: "mine", url: "https://mine.example.com/", active: 1 },                // yours, never touched
    { id: 4, name: "b", url: "http://b.example.com/", description: `${ORB_MARK} Group: Websites.`, active: 0 }, // Orb's (with its group), back again
  ]);
  assert.deepEqual(p.add.map(s => s.name), ["www.a.example.com"]);
  assert.deepEqual(p.pause.map(m => m.id), [2]);
  assert.deepEqual(p.resume.map(m => m.id), [4]);
  assert.equal(p.kept, 2);
});

test("TestScripts_RunsAreKeptAndOverlapRefused", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  const settings = { slow: { on: true, cron: "* * * * *" } };
  const s = new Scripts(new Store(":memory:"), [
    { id: "slow", name: "Slow", description: "", defaultCron: "0 * * * *", run: async () => { await gate; return { summary: "done" }; } },
    { id: "bad", name: "Bad", description: "", defaultCron: "0 * * * *", run: async () => { throw new Error("broke"); } },
  ], () => settings);
  const first = s.run("slow", "you");
  await assert.rejects(s.run("slow", "you"), /already running/);
  release();
  assert.equal((await first).summary, "done");
  const bad = await s.run("bad", "you");
  assert.equal(bad.ok, false); assert.equal(bad.summary, "broke");
  await s.tick(at("2026-11-19T10:00:00"));
  await s.tick(at("2026-11-19T10:00:30")); // same minute: not again
  const list = s.list();
  assert.equal(list.find(x => x.id === "slow")!.runs.length, 2);
  assert.equal(list.find(x => x.id === "slow")!.runs[0].by, "cron");
  assert.equal(list.find(x => x.id === "bad")!.on, false);
});

test("TestScripts_KumaWatchesOrbsAppsAndContainers", () => {
  const apps = appSites([
    { name: "Coinpile", url: "http://192.168.20.5:8190/", path: "/health" },
    { name: "Golem's model", url: "http://argos:8080/v1/models" },
    { name: "Hermes Studio", url: "http://192.168.20.5:3000" },
    { name: "Hermes again", url: "http://192.168.20.5:3000/" },
    { name: "Test thing", url: "http://test:1" },
    { name: "Broken", url: "not a url" },
    { name: "Mail", url: "mailto:x@y" },
  ], ["test"]);
  assert.deepEqual(apps.map(a => [a.name, a.url]), [["Coinpile", "http://192.168.20.5:8190/health"], ["Golem's model", "http://argos:8080/v1/models"], ["Hermes Studio", "http://192.168.20.5:3000/"]]);
  assert.ok(apps.every(a => a.group === "Pondering apps" && a.accept === APP_OK), "an app is up when it answers, even 401/404");
  const srv = serverSites([
    { name: "plex", url: "http://192.168.20.5:32400/web", via: "lan", state: "running" },
    { name: "radarr", url: "https://radarr.example.com", via: "npm", state: "running" },
    { name: "old", url: "http://192.168.20.5:9000", via: "lan", state: "exited" },
  ]);
  assert.deepEqual(srv.map(s => [s.name, s.group]), [["plex", "Server apps"]], "running, and not behind the proxy (that's a Website)");
});

test("TestScripts_KumaSyncPutsEachGroupInItsSection", async () => {
  const { Server } = await import("socket.io");
  const { createServer } = await import("node:http");
  const { syncKuma } = await import("../src/integrations/kumasync.js");
  // A stand-in for Uptime Kuma: the Socket.IO calls Orb makes, and the public status page.
  const monitors: Record<string, any> = { 1: { id: 1, name: "mine", url: "https://mine.example.com/", active: 1 } };
  let saved: any[] = [{ name: "My stuff", publicGroupList: undefined, monitorList: [{ id: 1 }] }], next = 2;
  const http = createServer((req, res) => {
    if (req.url === "/api/status-page/orb") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ publicGroupList: saved })); }
    res.writeHead(404); res.end();
  });
  const io = new Server(http);
  io.on("connection", s => {
    s.on("login", (b: any, cb: any) => { cb({ ok: b.username === "admin" && b.password === "pw" }); if (b.username === "admin") s.emit("monitorList", monitors); });
    s.on("add", (m: any, cb: any) => { const id = next++; monitors[id] = { ...m, id }; cb({ ok: true, monitorID: id }); });
    s.on("pauseMonitor", (_id: any, cb: any) => cb({ ok: true }));
    s.on("resumeMonitor", (_id: any, cb: any) => cb({ ok: true }));
    s.on("getStatusPage", (_slug: any, cb: any) => cb({ ok: true, config: { title: "Orb", icon: "/icon.svg" } }));
    s.on("saveStatusPage", (_slug: any, _cfg: any, _icon: any, groups: any[], cb: any) => { saved = groups; cb({ ok: true }); });
  });
  await new Promise<void>(r => http.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(http.address() as any).port}`;
  try {
    const r = await syncKuma({ base, user: "admin", password: "pw", slug: "orb", sites: [
      { name: "mine.example.com", url: "https://mine.example.com/", group: "Websites" },
      { name: "a.example.com", url: "https://a.example.com/", group: "Websites" },
      ...appSites([{ name: "Coinpile", url: "http://192.168.20.5:8190", path: "/health" }]),
    ] });
    assert.deepEqual(r.added, ["a.example.com", "Coinpile"]); assert.equal(r.kept, 1); assert.equal(r.onPage, 2);
    assert.deepEqual(monitors[3].accepted_statuscodes, APP_OK); assert.equal(monitors[3].description, `${ORB_MARK} Group: Pondering apps.`);
    assert.deepEqual(saved.map(g => [g.name, g.monitorList.map((m: any) => m.id)]), [["My stuff", [1]], ["Websites", [2]], ["Pondering apps", [3]]], "your section kept; one section per group");
    await assert.rejects(syncKuma({ base, user: "admin", password: "no", slug: "orb", sites: [] }), /refused the login|login failed/);
  } finally { io.close(); http.close(); }
});
