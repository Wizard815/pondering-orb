import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessHeaders, cleanUrl, Orb, OrbError, SignedOut, toNotify, trayLine, type Alert, type Glance } from "../src/orb.js";
import { Store } from "../src/store.js";
import { linuxAutostart } from "../src/autostart.js";

function serve(h: (req: any, res: any) => void): Promise<{ url: string; server: Server }> {
  return new Promise(r => { const server = createServer(h).listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${(server.address() as any).port}`, server })); });
}
const g = (over: Partial<Glance> = {}): Glance => ({ at: 1, day: "2026-11-27", uptime: { total: 5, down: [] }, events: [], tasks: [], chores: [], brief: null, media: [], alerts: 0, errors: [], ...over });

test("TestDesktop_CleanUrl", () => {
  assert.equal(cleanUrl("orb.thefellashub.com"), "https://orb.thefellashub.com");
  assert.equal(cleanUrl(" http://192.168.20.5:8095/ "), "http://192.168.20.5:8095");
  assert.equal(cleanUrl("https://example.com/orb/?x=1#y"), "https://example.com/orb");
  assert.throws(() => cleanUrl(""), OrbError);
  assert.throws(() => cleanUrl("https://me:pw@orb.example.com"), /user name and password/);
});

test("TestDesktop_AccessHeaders", () => {
  assert.deepEqual(accessHeaders({}), {});
  assert.deepEqual(accessHeaders({ clientId: "id.access", clientSecret: "s" }), { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "s" });
  assert.deepEqual(accessHeaders({ clientId: "id.access" }), {}, "half a token sends nothing");
  assert.deepEqual(accessHeaders({ cookie: "jwt" }), { Cookie: "CF_Authorization=jwt" });
});

test("TestDesktop_TrayLineAndNotify", () => {
  assert.equal(trayLine(undefined), "Pondering Orb");
  assert.equal(trayLine(g()), "Orb: all 5 up");
  assert.equal(trayLine(g({ uptime: { total: 5, down: ["Plex"] } })), "Orb: Plex is down");
  assert.equal(trayLine(g({ uptime: { total: 5, down: ["Plex", "Sonarr"] } })), "Orb: 2 services down");
  assert.equal(trayLine(g(), "Orb isn't answering at x. Check"), "Orb: Orb isn't answering at x");
  const a = (n: number): Alert[] => Array.from({ length: n }, (_, i) => ({ id: String(i), at: i, event: "uptime", title: `t${i}`, message: "", priority: 3, tags: [] }));
  assert.deepEqual(toNotify(a(2)), { show: a(2), more: 0 });
  const five = toNotify(a(5)); assert.deepEqual(five.show.map(x => x.title), ["t2", "t3", "t4"]); assert.equal(five.more, 2);
});

test("TestDesktop_ClientSendsKeyAndAccessToken", async () => {
  const seen: any[] = [];
  const s = await serve((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, cf: req.headers["cf-access-client-id"] });
    if (req.url === "/api/glance" && req.headers.authorization === "Bearer orbd_good") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(g())); }
    if (req.url === "/api/glance") { res.writeHead(401, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Sign in first" })); }
    if (req.url === "/page") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<html>hello</html>"); }
    if (req.url === "/cf") { res.writeHead(302, { Location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" }); return res.end(); }
    res.writeHead(404); res.end();
  });
  try {
    const o = new Orb(s.url, "orbd_good", () => ({ clientId: "cid", clientSecret: "sec" }));
    assert.equal((await o.glance()).uptime?.total, 5);
    assert.deepEqual(seen[0], { url: "/api/glance", auth: "Bearer orbd_good", cf: "cid" });
    await assert.rejects(new Orb(s.url, "orbd_removed").glance(), SignedOut);
    await assert.rejects((new Orb(s.url, "k") as any).call("GET", "/page"), /web page, not Orb/);
    await assert.rejects((new Orb(s.url, "k") as any).call("GET", "/cf"), /Cloudflare Access is asking/);
    await assert.rejects(new Orb("http://127.0.0.1:9", "k").glance(), /isn't answering/);
  } finally { s.server.close(); }
});

test("TestDesktop_StoreKeepsSecretsEncrypted", () => {
  const dir = mkdtempSync(join(tmpdir(), "orb-desk-"));
  const vault = { available: () => true, encrypt: (s: string) => Buffer.from(s.split("").reverse().join("")), decrypt: (b: Buffer) => b.toString().split("").reverse().join("") };
  const st = new Store(dir, vault);
  st.saveSecrets({ token: "orbd_secret", cfSecret: "cfs" });
  st.set({ url: "https://orb.example.com", deviceId: "d1" });
  assert.ok(!readFileSync(join(dir, "orb.key"), "utf8").includes("orbd_secret"));
  assert.ok(!readFileSync(join(dir, "settings.json"), "utf8").includes("orbd_secret"));
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "orb.key")).mode & 0o777, 0o600);
  const again = new Store(dir, vault);
  assert.deepEqual(again.secrets, { token: "orbd_secret", cfSecret: "cfs" });
  again.forget();
  assert.deepEqual(new Store(dir, vault).secrets, { cfSecret: "cfs" }, "signing out keeps the Cloudflare token, not the key");
  assert.equal(new Store(dir, vault).settings.deviceId, undefined);
  // No keychain and no plain file allowed: refuse rather than keep it in the clear.
  assert.throws(() => new Store(mkdtempSync(join(tmpdir(), "orb-desk-")), { ...vault, available: () => false }).saveSecrets({ token: "x" }), /no keychain/);
});

test("TestDesktop_LinuxAutostart", () => {
  const dir = mkdtempSync(join(tmpdir(), "orb-auto-"));
  const f = linuxAutostart(true, "/home/me/Apps/Pondering Orb.AppImage", dir);
  assert.match(readFileSync(f, "utf8"), /Exec="\/home\/me\/Apps\/Pondering Orb.AppImage" --hidden/);
  linuxAutostart(false, "", dir);
  assert.equal(existsSync(f), false);
});
