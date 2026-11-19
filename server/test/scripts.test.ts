import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.js";
import { Scripts, parseCron, cronMatches, nextRun } from "../src/scripts.js";
import { sitesFrom, plan, ORB_MARK } from "../src/integrations/kumasync.js";

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
    { id: 4, name: "b", url: "http://b.example.com/", description: ORB_MARK, active: 0 }, // Orb's, back again
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
