import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { CalDav } from "../src/integrations/caldav.js";
import { parseTodo, writeTodo } from "../src/integrations/ical.js";

const cfg = (over: any = {}) => ({ ...loadConfig("/nonexistent.yaml", {}), ...over });

test("TestCalDav_DecodesEscapedEtags", async () => {
  const seen: string[] = [];
  const s = createServer((req, res) => {
    if (req.method === "REPORT") { res.writeHead(207); return res.end(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/dav/l/a.ics</d:href><d:propstat><d:prop><d:getetag>&quot;abc&quot;</d:getetag><c:calendar-data>BEGIN:VCALENDAR&#xA;BEGIN:VTODO&#xA;UID:a&#xA;SUMMARY:Say &#34;hi&#34;&#xA;END:VTODO&#xA;END:VCALENDAR&#xA;</c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>`); }
    seen.push(String(req.headers["if-match"])); res.writeHead(204, { ETag: '"abd"' }); res.end();
  }).listen(0);
  const url = `http://127.0.0.1:${(s.address() as any).port}/dav/`;
  try {
    const dav = new CalDav(() => url, () => ({ user: "", pass: "" }));
    const [it] = await dav.todos({ href: "/dav/l/", name: "L" });
    assert.equal(it.etag, '"abc"');
    assert.equal(parseTodo(it.ics)?.summary, 'Say "hi"');
    await dav.put(it.href, it.ics, it.etag);
    assert.deepEqual(seen, ['"abc"']);
    await assert.rejects(dav.put("http://evil.example/x.ics", "x", '"1"'), /another server/);
  } finally { s.close(); }
});

test("TestICal_KeepsTimesExceptionsAndEscapes", () => {
  const base = "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:a\r\nSUMMARY:old\r\nDTSTART:20261104T090000Z\r\nDUE:20261105T170000Z\r\nRRULE:FREQ=DAILY\r\nEND:VTODO\r\nBEGIN:VTODO\r\nUID:a\r\nRECURRENCE-ID:20261106T170000Z\r\nSUMMARY:exc\r\nDTSTAMP:20261101T000000Z\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";
  const title = "path C:\\new, milk; eggs " + "x".repeat(80);
  const w = writeTodo(base, { uid: "a", summary: title, done: true, due: "2026-11-07", priority: 3 });
  assert.match(w, /DUE:20261107T170000Z/);
  assert.match(w, /RECURRENCE-ID:20261106T170000Z\r\nSUMMARY:exc\r\nDTSTAMP:20261101T000000Z/);
  assert.ok(w.split("\r\n").every(l => Buffer.byteLength(l) <= 75), "lines folded at 75 octets");
  assert.equal(parseTodo(w)?.summary, title);
  const again = writeTodo(w, { uid: "a", summary: title, done: true, due: "2026-11-07", priority: 3 });
  assert.equal(/COMPLETED:(\S+)/.exec(again)![1], /COMPLETED:(\S+)/.exec(w)![1], "COMPLETED kept");
});

test("TestAuth_RefusesCrossSiteAndPlainTextWrites", async () => {
  const { app } = await buildApp({ config: cfg() });
  const cross = await app.inject({ method: "POST", url: "/api/caldav/sync", headers: { origin: "http://evil.example", host: "orb:8095" } });
  assert.equal(cross.statusCode, 403);
  const fetchSite = await app.inject({ method: "POST", url: "/api/outbox/retry", headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(fetchSite.statusCode, 403);
  const plain = await app.inject({ method: "POST", url: "/api/c/logs", headers: { "content-type": "text/plain" }, payload: "hi" });
  assert.equal(plain.statusCode, 415);
  const same = await app.inject({ method: "POST", url: "/api/c/logs", headers: { origin: "http://orb:8095", host: "orb:8095" }, payload: { text: "ok", project: "General" } });
  assert.equal(same.statusCode, 201);
});

test("TestConfig_YamlBeatsEnvAndGolemProviders", () => {
  const dir = mkdtempSync(join(tmpdir(), "orb-")), f = join(dir, "orb.yaml");
  writeFileSync(f, "port: 9000\nupstream: { base_url: http://um:5000 }\ngolem:\n  provider: frontier\n  local: { base_url: http://argos:8080/v1 }\n  frontier: { base_url: https://openrouter.ai/api/v1, key_env: OPENROUTER_API_KEY }\n  can_write: false\n");
  const c = loadConfig(f, { PORT: "8095", UPSTREAM_URL: "http://placeholder:5000", ARGOS_URL: "http://other:8080", WIKI_URL: "http://w:1" });
  assert.equal(c.port, 9000);
  assert.equal(c.upstream.baseUrl, "http://um:5000");
  assert.equal(c.golem.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(c.golem.keyEnv, "OPENROUTER_API_KEY");
  assert.equal(c.golem.canWrite, false);
  assert.equal(c.wiki.baseUrl, "http://w:1", "env still fills what the YAML leaves out");
});
