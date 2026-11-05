import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeDav, wait } from "./support/fakes.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Outbox } from "../src/outbox.js";
import { Store } from "../src/db.js";
import { Wiki } from "../src/integrations/wiki.js";
import { logCommits } from "../src/pollers.js";

const cfg = (over: any = {}) => ({ ...loadConfig("/nonexistent.yaml", {}), ...over });
const T = { authorization: "Bearer agent-token" };

test("TestAudit_SecretExfil_keyEnvCanNameAnyEnvVar", async () => {
  process.env.ORB_PASSWORD = "hunter2";
  const evil = await fake((_q, _b, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"data":[]}'); });
  try {
    const { app } = await buildApp({ config: cfg(), password: "hunter2", tokens: "bot:agent-token" });
    // an agent token (not the owner) rewrites settings
    const put = await app.inject({ method: "PUT", url: "/api/c/settings/app", headers: T, payload: { golem: { baseUrl: evil.url, keyEnv: "ORB_PASSWORD" } } });
    assert.equal(put.statusCode, 403, "agents can't change settings");
    // Even the owner can't point a key at one of Orb's own variables.
    const open = await buildApp({ config: cfg() });
    await open.app.inject({ method: "PUT", url: "/api/c/settings/app", payload: { golem: { baseUrl: evil.url, keyEnv: "ORB_PASSWORD" } } });
    await open.app.inject({ method: "POST", url: "/api/connections/test/golem" });
    const leaked = evil.hits.map(h => h.headers.authorization).filter(Boolean);
    assert.deepEqual(leaked, [], `ORB_PASSWORD sent to settings-controlled host: ${leaked}`);
  } finally { evil.server.close(); delete process.env.ORB_PASSWORD; }
});

test("TestAudit_Auth_EmptyTokenInEnvAuthenticatesEmptyBearer", async () => {
  const { app } = await buildApp({ config: cfg(), password: "pw", tokens: "ci:" });
  const r = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: "Bearer " } });
  assert.equal(r.statusCode, 401, `empty bearer accepted: ${r.body}`);
});

test("TestAudit_Wiki_CreateProjectNameTraversesIntoRaw", async () => {
  const wiki = await fake((req, _b, res) => { if (req.method === "GET") { res.writeHead(404); return res.end(); } res.writeHead(200); res.end("{}"); });
  try {
    const { app, records } = await buildApp({ config: cfg({ wiki: { baseUrl: wiki.url, tokenEnv: "X", vault: "/nonexistent-vault" } }) });
    assert.throws(() => records.create("projects", { name: "../../raw/pwned" }), /project name/);
    // A name stored before the check (older data) is refused by the wiki client too.
    const p: any = records.store.set("projects", "old", { name: "../../raw/pwned", status: "next" });
    const r = await app.inject({ method: "POST", url: "/api/wiki/project", payload: { projectId: p.id, area: "ai" } });
    assert.equal(r.statusCode, 422);
    const writes = wiki.hits.filter(h => h.method !== "GET").map(h => h.method + " " + h.url);
    assert.ok(!writes.some(w => w.includes("/vault/raw/")), `wrote under raw/: ${JSON.stringify(writes)} (status ${r.statusCode} ${r.body})`);
  } finally { wiki.server.close(); }
});

test("TestAudit_Wiki_ProjectWikiNoteNotValidatedOnStatusWrite", async () => {
  const wiki = await fake((req, _b, res) => { if (req.method === "GET") { res.writeHead(404); return res.end(); } res.writeHead(200); res.end("{}"); });
  try {
    const { records } = await buildApp({ config: cfg({ wiki: { baseUrl: wiki.url, tokenEnv: "X", vault: "/nonexistent-vault" } }) });
    assert.throws(() => records.create("projects", { name: "P", status: "active", wikiNote: "raw/sources/secret.md" }), /wikiNote/);
    assert.throws(() => records.create("projects", { name: "P", status: "active", wikiNote: "wiki/../raw/x.md" }), /wikiNote/);
    // Stored before the check: the REST client still refuses raw/.
    const p: any = records.store.set("projects", "old", { name: "P", status: "active", wikiNote: "wiki/../raw/x.md" });
    records.patch("projects", p.id, { name: "P" }); // seed lastStatus
    records.patch("projects", p.id, { status: "paused" });
    await wait(200);
    const writes = wiki.hits.filter(h => h.method === "PATCH").map(h => h.url);
    assert.ok(!writes.some(w => w.startsWith("/vault/raw/")), `PATCHed raw/: ${JSON.stringify(writes)}`);
  } finally { wiki.server.close(); }
});

test("TestAudit_Outbox_StaleWikiStatusOverwritesNewer", async () => {
  let down = true; const values: string[] = [];
  const wiki = await fake((req, body, res) => {
    if (down) { res.writeHead(503); return res.end(); }
    if (req.method === "PATCH" && req.headers.target === "project_status") values.push(JSON.parse(body));
    if (req.method === "GET") { res.writeHead(404); return res.end(); }
    res.writeHead(200); res.end("{}");
  });
  try {
    const { records, outbox } = await buildApp({ config: cfg({ wiki: { baseUrl: wiki.url, tokenEnv: "X", vault: "/nonexistent-vault" } }) });
    const p: any = records.create("projects", { name: "P", status: "active", wikiNote: "wiki/1-projects/P.md" });
    records.patch("projects", p.id, { status: "paused" }); await wait(200);   // fails, queued "paused"
    assert.equal(outbox.list().length, 1);
    down = false;
    records.patch("projects", p.id, { status: "shipped" }); await wait(200);  // succeeds immediately: "done"
    await outbox.flush(true);                                                 // the stale "paused" replays
    assert.equal(values.at(-1), "done", `wiki ended with ${JSON.stringify(values)}`);
  } finally { wiki.server.close(); }
});

test("TestAudit_Sync_QuickEditOfNewTaskCreatesDuplicateVTODO", async () => {
  const dav = await fakeDav();
  try {
    const { app, records } = await buildApp({ config: cfg({ caldav: { ...cfg().caldav, url: dav.url } }) });
    await app.inject({ method: "POST", url: "/api/caldav/sync" });
    const t: any = records.create("tasks", { title: "New", list: "Homelab" });
    records.patch("tasks", t.id, { title: "New task" });
    await wait(300);
    const creates = dav.puts.filter(p => p.ifNone === "*");
    assert.equal(creates.length, 1, `created ${creates.length} VTODOs: ${creates.map(c => c.url)}`);
  } finally { dav.server.close(); }
});

test("TestAudit_Sync_UnrelatedEditRewritesVTODOAndBumpsCompleted", async () => {
  const dav = await fakeDav();
  try {
    const { app, records } = await buildApp({ config: cfg({ caldav: { ...cfg().caldav, url: dav.url } }) });
    await app.inject({ method: "POST", url: "/api/caldav/sync" });
    const t: any = records.list("tasks")[0];
    records.patch("tasks", t.id, { done: true }); await wait(200);
    const n = dav.puts.length;
    await wait(1100);
    records.patch("tasks", t.id, { notes: "only an Orb-side field" }); await wait(200);
    assert.equal(dav.puts.length, n, `extra PUT for an unmanaged field; COMPLETED now ${/COMPLETED:(\S+)/.exec(dav.puts.at(-1).body)?.[1]}`);
  } finally { dav.server.close(); }
});

test("TestAudit_Sync_DeleteAfterRemoteEditRetriesForever", async () => {
  const dav = await fakeDav();
  try {
    const { app, records, outbox } = await buildApp({ config: cfg({ caldav: { ...cfg().caldav, url: dav.url } }) });
    await app.inject({ method: "POST", url: "/api/caldav/sync" });
    const t: any = records.list("tasks")[0];
    dav.files.get("/dav/homelab/a.ics")!.etag = '"remote-edit"';
    records.remove("tasks", t.id); await wait(200);
    for (let i = 0; i < 3; i++) await outbox.flush(true);
    const it = outbox.list()[0];
    assert.equal(it, undefined, `delete stuck in outbox after ${it?.tries} retries, all with If-Match ${dav.dels.map(d => d.ifMatch)}`);
  } finally { dav.server.close(); }
});

test("TestAudit_Digest_BackdatedForceRewindsIdempotencyMarker", async () => {
  const { app, records, store, writeDigest } = await buildApp({ config: cfg({ wiki: { baseUrl: "", tokenEnv: "X", vault: "/x" } }) });
  store.set("settings", "app", { wikiDigest: true });
  const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  records.create("logs", { text: "did a thing", date: y });
  assert.equal(await writeDigest(), y);
  assert.equal(await writeDigest(), "");                   // idempotent
  await app.inject({ method: "POST", url: "/api/wiki/digest", payload: { date: "2026-01-01" } });
  assert.equal(await writeDigest(), "", "yesterday's digest written a second time after a backdated manual digest");
});

test("TestAudit_Digest_GarbageDateDisablesForever", async () => {
  const { app, store, writeDigest } = await buildApp({ config: cfg({ wiki: { baseUrl: "", tokenEnv: "X", vault: "/x" } }) });
  store.set("settings", "app", { wikiDigest: true });
  const r = await app.inject({ method: "POST", url: "/api/wiki/digest", payload: { date: "zzz" } });
  assert.equal(r.statusCode, 400, `accepted date "zzz": ${r.body}`);
  assert.notEqual(await writeDigest(), "", "automatic digest now never runs");
});

test("TestAudit_LogMax_Above200CommitsSilentlyDropped", async () => {
  const { records, store, cfg: c } = await buildApp({ config: cfg() });
  store.set("settings", "app", { logMax: 500 });
  let items = [{ full: "s1", sha: "s1", subject: "init", date: "2026-11-01T00:00:00Z" }];
  const up: any = { commits: async () => ({ items }) };
  records.create("projects", { name: "P", upstreamRepo: "r", logCommits: true });
  await logCommits(records, up, c().logMax);
  items = [{ full: "s2", sha: "s2", subject: "x".repeat(250), date: "2026-11-02T00:00:00Z" }, ...items];
  await logCommits(records, up, c().logMax);
  const p: any = records.list("projects")[0];
  assert.equal(records.list("logs").length, 1, `commit dropped, lastLoggedSha advanced to ${p.lastLoggedSha}`);
});

test("TestAudit_Outbox_AddDuringFlushIsDeleted", async () => {
  const ob = new Outbox(new Store(":memory:"));
  let release!: () => void; const gate = new Promise<void>(r => (release = r));
  ob.on("wiki", async (p) => { if (p.v === 1) await gate; });
  ob.add("wiki", "x", { v: 1 }, "down", "status:p");
  const f = ob.flush(true); await wait(20);
  ob.add("wiki", "x", { v: 2 }, "down again", "status:p");     // newer failure lands while v1 retry is in flight
  release(); await f;
  assert.equal(ob.list().length, 1, "newer queued write (v2) was deleted when the v1 retry succeeded");
});

test("TestAudit_Wiki_ConcurrentLogCreationLosesALine", async () => {
  let file: string | null = null; const puts: string[] = [];
  const w = await fake(async (req, body, res) => {
    if (req.method === "GET") { const f = file; await wait(30); if (f === null) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": "text/markdown" }); return res.end(f); }
    if (req.method === "PUT") { puts.push(body); file = body; }
    if (req.method === "PATCH") file += body;
    res.writeHead(200); res.end("{}");
  });
  try {
    const wiki = new Wiki(() => w.url, () => "", () => "/nonexistent");
    await Promise.all([wiki.log("line A"), wiki.log("line B")]);
    assert.ok(file!.includes("line A") && file!.includes("line B"), `log file after two concurrent writes:\n${file}`);
  } finally { w.server.close(); }
});
