import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { parseTodo, writeTodo, rruleDays } from "../src/integrations/ical.js";

const cfg = (over: any = {}) => ({ ...loadConfig("/nonexistent.yaml", {}), ...over });
const ics = (uid: string, extra: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:${uid}\r\n${extra}\r\nX-OTHER-APP:keep me\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`;
const wait = (ms = 60) => new Promise(r => setTimeout(r, ms));

/** A tiny CalDAV server: two lists (Homelab, Chores) held in memory. */
function fakeDav(): Promise<{ url: string; server: Server; files: Map<string, { ics: string; etag: string }>; puts: any[] }> {
  const files = new Map<string, { ics: string; etag: string }>(); let n = 0; const puts: any[] = [];
  files.set("/dav/homelab/a.ics", { ics: ics("a", "SUMMARY:Release notes\r\nPRIORITY:1\r\nDUE;VALUE=DATE:20261110\r\nSTATUS:NEEDS-ACTION"), etag: '"1"' });
  files.set("/dav/chores/b.ics", { ics: ics("b", "SUMMARY:Check backups\r\nRRULE:FREQ=WEEKLY;INTERVAL=1\r\nDUE;VALUE=DATE:20261108"), etag: '"2"' });
  return new Promise(res => {
    const server = createServer((req, resp) => {
      let body = ""; req.on("data", d => (body += d)); req.on("end", () => {
        const u = req.url!;
        if (req.method === "PROPFIND") {
          const r = (href: string, name: string) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:displayname>${name}</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response>`;
          resp.writeHead(207, { "Content-Type": "application/xml" }); return resp.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>${r("/dav/homelab/", "Homelab")}${r("/dav/chores/", "Chores")}</d:multistatus>`);
        }
        if (req.method === "REPORT") {
          const items = [...files].filter(([h]) => h.startsWith(u)).map(([h, f]) => `<d:response><d:href>${h}</d:href><d:propstat><d:prop><d:getetag>${f.etag}</d:getetag><c:calendar-data>${f.ics.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</c:calendar-data></d:prop></d:propstat></d:response>`).join("");
          resp.writeHead(207, { "Content-Type": "application/xml" }); return resp.end(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${items}</d:multistatus>`);
        }
        if (req.method === "PUT") {
          const cur = files.get(u); puts.push({ url: u, ifMatch: req.headers["if-match"], ifNone: req.headers["if-none-match"], body });
          if (req.headers["if-match"] && cur?.etag !== req.headers["if-match"]) { resp.writeHead(412); return resp.end(); }
          if (req.headers["if-none-match"] === "*" && cur) { resp.writeHead(412); return resp.end(); }
          const etag = `"e${++n}"`; files.set(u, { ics: body, etag }); resp.writeHead(cur ? 204 : 201, { ETag: etag }); return resp.end();
        }
        if (req.method === "DELETE") { files.delete(u); resp.writeHead(204); return resp.end(); }
        resp.writeHead(405); resp.end();
      });
    }).listen(0, () => res({ url: `http://127.0.0.1:${(server.address() as any).port}/dav/`, server, files, puts }));
  });
}

test("TestIcal_WriteKeepsOtherProperties", () => {
  const base = ics("x", "SUMMARY:Old\r\nPRIORITY:9\r\nSTATUS:NEEDS-ACTION");
  const out = writeTodo(base, { uid: "x", summary: "New, title", done: true, due: "2026-11-20", priority: 1 });
  const t = parseTodo(out)!;
  assert.equal(t.summary, "New, title"); assert.equal(t.status, "COMPLETED"); assert.equal(t.priority, 1); assert.equal(t.due, "2026-11-20");
  assert.match(out, /X-OTHER-APP:keep me/); assert.equal((out.match(/^SUMMARY/gm) || []).length, 1);
  assert.equal(rruleDays("FREQ=WEEKLY;INTERVAL=2"), 14);
});

test("TestCalDav_PullAndPushTasksAndChores", async () => {
  const dav = await fakeDav();
  try {
    const { app, records } = await buildApp({ config: cfg({ caldav: { ...cfg().caldav, url: dav.url } }) });
    const r = (await app.inject({ method: "POST", url: "/api/caldav/sync" })).json();
    assert.equal(r.lists, 2);
    const task: any = records.list("tasks")[0];
    assert.deepEqual([task.title, task.list, task.priority, task.due, task.done], ["Release notes", "Homelab", 1, "2026-11-10", false]);
    const chore: any = records.list("chores")[0];
    assert.deepEqual([chore.name, chore.everyDays], ["Check backups", 7]);

    // Done in Orb → PUT with If-Match and STATUS:COMPLETED, other app's field kept.
    await app.inject({ method: "PATCH", url: `/api/c/tasks/${task.id}`, payload: { done: true } }); await wait();
    const p1 = dav.puts.at(-1); assert.equal(p1.ifMatch, '"1"'); assert.match(p1.body, /STATUS:COMPLETED/); assert.match(p1.body, /X-OTHER-APP:keep me/);
    assert.equal((records.get("tasks", task.id) as any).caldav.etag, '"e1"');

    // New task in a CalDAV list → created there with If-None-Match.
    await app.inject({ method: "POST", url: "/api/c/tasks", payload: { title: "Write docs", list: "Homelab", priority: 5 } }); await wait();
    const p2 = dav.puts.at(-1); assert.equal(p2.ifNone, "*"); assert.match(p2.url, /^\/dav\/homelab\/.+\.ics$/); assert.match(p2.body, /PRIORITY:5/);
    // A task in a list that only lives in Orb is not sent anywhere.
    const before = dav.puts.length; await app.inject({ method: "POST", url: "/api/c/tasks", payload: { title: "Local only", list: "Orb only" } }); await wait();
    assert.equal(dav.puts.length, before);

    // Chore Done → due rolls forward by the interval.
    await app.inject({ method: "PATCH", url: `/api/c/chores/${chore.id}`, payload: { lastDone: "2026-11-05" } }); await wait();
    const p3 = dav.puts.at(-1); assert.match(p3.url, /chores\/b\.ics/); assert.match(p3.body, /DUE;VALUE=DATE:20261112/); assert.match(p3.body, /RRULE:FREQ=WEEKLY;INTERVAL=1/);

    // Pulling again doesn't push anything back.
    const n = dav.puts.length; await app.inject({ method: "POST", url: "/api/caldav/sync" }); await wait(); assert.equal(dav.puts.length, n);
  } finally { dav.server.close(); }
});

test("TestWiki_SectionEditPatchesAndLogs", async () => {
  const seen: any[] = []; const notes: Record<string, string> = { "/vault/wiki/1-projects/Argos.md": `---\ntitle: Argos\ntype: project\nproject_status: active\n---\n# Argos\n\n## Current state\n- old\n\n## Next steps\n- x\n` };
  const server = createServer((req, resp) => { let b = ""; req.on("data", d => (b += d)); req.on("end", () => {
    const u = decodeURIComponent(req.url!); seen.push({ m: req.method, u, h: req.headers, b });
    if (req.method === "GET") { if (notes[u]) { resp.writeHead(200, { "Content-Type": "text/markdown" }); return resp.end(notes[u]); } resp.writeHead(404); return resp.end("{}"); }
    resp.writeHead(204); resp.end(); }); }).listen(0);
  await new Promise(r => server.once("listening", r));
  try {
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const { app } = await buildApp({ config: cfg({ wiki: { baseUrl: url, tokenEnv: "", vault: "/nonexistent" } }) });
    const r = await app.inject({ method: "POST", url: "/api/wiki/section", payload: { path: "wiki/1-projects/Argos.md", heading: "Next steps", text: "- ship it" } });
    assert.equal(r.statusCode, 200);
    const patches = seen.filter(s => s.m === "PATCH");
    assert.equal(patches[0].h["target-type"], "heading"); assert.equal(decodeURIComponent(patches[0].h.target), "Argos::Next steps"); assert.equal(patches[0].h.operation, "replace");
    assert.equal(patches[1].h["target-type"], "frontmatter"); assert.equal(patches[1].h.target, "updated");
    const log = seen.find(s => s.m === "PUT"); assert.match(log.u, /wiki\/logs\/Log - \d{4}-\d{2}-\d{2}\.md/); assert.match(log.b, /## Pondering Orb\n- \[\[Argos\]\]: edited Next steps/); assert.match(log.b, /tags: \[wiki, log\]/);
    const bad = await app.inject({ method: "POST", url: "/api/wiki/section", payload: { path: "raw/x.md", heading: "Next steps", text: "no" } });
    assert.equal(bad.statusCode, 403);
  } finally { server.close(); }
});

test("TestIcal_InProgressIsInProcess", () => {
  const base = ics("y", "SUMMARY:Fix it\r\nSTATUS:NEEDS-ACTION");
  const started = writeTodo(base, { uid: "y", summary: "Fix it", done: false, started: true, due: "", priority: 0 });
  assert.equal(parseTodo(started)!.status, "IN-PROCESS");
  // Done wins over in progress; not started goes back to NEEDS-ACTION.
  assert.equal(parseTodo(writeTodo(started, { uid: "y", summary: "Fix it", done: true, started: true, due: "", priority: 0 }))!.status, "COMPLETED");
  assert.equal(parseTodo(writeTodo(started, { uid: "y", summary: "Fix it", done: false, due: "", priority: 0 }))!.status, "NEEDS-ACTION");
});
