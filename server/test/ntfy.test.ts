import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { scrub } from "../src/integrations/ntfy.js";

const cfg = (over: any = {}) => ({ ...loadConfig("/nonexistent.yaml", {}), ...over });
const wait = (ms = 80) => new Promise(r => setTimeout(r, ms));
function serve(h: (req: any, body: string, res: any) => void): Promise<{ url: string; server: Server }> {
  return new Promise(r => { const server = createServer((req, res) => { let b = ""; req.on("data", d => (b += d)); req.on("end", () => h(req, b, res)); }).listen(0, () => r({ url: `http://127.0.0.1:${(server.address() as any).port}`, server })); });
}
const J = (res: any, o: any, c = 200) => { res.writeHead(c, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };

test("TestNtfy_UptimeDownAndBackUp", async () => {
  const sent: any[] = [];
  const ntfy = await serve((req, body, res) => {
    if (req.headers.authorization !== "Bearer tk_orbtest") return J(res, { code: 40301, http: 403, error: "forbidden" }, 403);
    sent.push(JSON.parse(body)); J(res, { id: "x", event: "message" });
  });
  let plex = 0;
  const kuma = await serve((req, body, res) => {
    if (req.url === "/api/status-page/orb") return J(res, { publicGroupList: [{ name: "Media", monitorList: [{ id: 1, name: "Plex" }, { id: 2, name: "Flaky" }] }] });
    if (req.url === "/api/status-page/heartbeat/orb") return J(res, { heartbeatList: { 1: [{ status: plex }], 2: [{ status: 0 }] }, uptimeList: {} });
    J(res, {}, 404);
  });
  process.env.TEST_NTFY_TOKEN = "tk_orbtest";
  try {
    const { app, notifier, outbox } = await buildApp({ config: cfg({ uptime: { ...cfg().uptime, baseUrl: kuma.url }, ntfy: { url: ntfy.url, topic: "orb-wizard", tokenEnv: "TEST_NTFY_TOKEN", events: "" } }) });
    await app.inject({ method: "PUT", url: "/api/c/settings/app", payload: { uptimeIgnore: ["Flaky"] } });
    // Settings → Connections → ntfy → Test sends a test message.
    const t = (await app.inject({ method: "POST", url: "/api/connections/test/ntfy" })).json();
    assert.equal(t.ok, true, t.detail); assert.equal(sent[0].topic, "orb-wizard"); assert.match(sent[0].title, /Test/);
    sent.length = 0;
    await notifier.uptimeTick();
    assert.deepEqual(sent.map(s => s.title), ["Plex is down"], "ignored monitors never alert");
    await notifier.uptimeTick();
    assert.equal(sent.length, 1, "once per outage");
    plex = 1; await notifier.uptimeTick();
    assert.deepEqual(sent.map(s => s.title), ["Plex is down", "Plex is back up"]);
    // A write stuck in the outbox: one alert after its third failed retry, with no amount or key in it.
    outbox.on("wiki-test", async () => { throw new Error("wiki answered 503 (apikey=tk_orbtest)"); });
    outbox.add("wiki-test", "Log: paid rent $1,250.00", {}, "down", "k");
    for (let i = 0; i < 4; i++) await outbox.flush(true);
    await wait();
    const stuck = sent.filter(s => /isn't getting through/.test(s.title));
    assert.equal(stuck.length, 1);
    assert.ok(!/1,250|tk_orbtest/.test(JSON.stringify(stuck)), JSON.stringify(stuck));
    // A wrong token says so in plain words.
    process.env.TEST_NTFY_TOKEN = "tk_wrong";
    const bad = (await app.inject({ method: "POST", url: "/api/connections/test/ntfy" })).json();
    assert.equal(bad.ok, false); assert.match(bad.detail, /ntfy refused the token in TEST_NTFY_TOKEN/);
    // /api/config shows the variable's name, never its value.
    const c = (await app.inject({ url: "/api/config" })).json();
    assert.deepEqual([c.ntfy.tokenEnv, c.ntfy.tokenSet], ["TEST_NTFY_TOKEN", true]); assert.ok(!JSON.stringify(c).includes("tk_wrong"));
  } finally { ntfy.server.close(); kuma.server.close(); delete process.env.TEST_NTFY_TOKEN; }
});

test("TestNtfy_OffUntilSetUpAndScrubbed", async () => {
  const { app, notifier } = await buildApp({ config: cfg({ uptime: { ...cfg().uptime, baseUrl: "http://127.0.0.1:9" } }) });
  assert.equal(notifier.ready, false);
  assert.deepEqual(await notifier.uptimeTick(), { sent: 0 }, "nothing is called without ntfy");
  const t = (await app.inject({ method: "POST", url: "/api/connections/test/ntfy" })).json();
  assert.equal(t.ok, false); assert.match(t.detail, /Set ntfy's address first/);
  const s = scrub("Bill €40 and $1,200.50 and 300 USD; token=abc123 Bearer xyz http://u:p@host/x?apikey=k " + "a".repeat(40));
  for (const bad of ["€40", "1,200", "300 USD", "abc123", "xyz", "u:p@", "apikey=k", "a".repeat(40)]) assert.ok(!s.includes(bad), `${bad} left in: ${s}`);
});
