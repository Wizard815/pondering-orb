import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { parseNginx } from "../src/integrations/proxies.js";

const serve = (h: (req: any, res: any, body: string) => void) => new Promise<{ url: string; port: number; close: () => void }>(ok => {
  const s = createServer((req, res) => { let b = ""; req.on("data", c => (b += c)); req.on("end", () => h(req, res, b)); }).listen(0, "127.0.0.1", () => { const port = (s.address() as any).port; ok({ url: `http://127.0.0.1:${port}`, port, close: () => s.close() }); });
});
const J = (res: any, o: unknown, c = 200) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };

test("TestProxies_NginxConfigs", () => {
  const swag = `server {\n  listen 443 ssl;\n  server_name sonarr.*;\n  location / {\n    set $upstream_app sonarr;\n    set $upstream_port 8989;\n    set $upstream_proto http;\n    proxy_pass $upstream_proto://$upstream_app:$upstream_port;\n  }\n}`;
  const plain = `# a comment { with braces }\nserver {\n listen 80;\n server_name plex.example.com;\n location / { proxy_pass http://192.168.20.5:32400; }\n}\nserver { listen 80; server_name _; return 444; }`;
  assert.deepEqual(parseNginx(swag, "thefellashub.com"), [{ names: ["sonarr.thefellashub.com"], https: true, host: "sonarr", port: 8989, via: "nginx" }]);
  assert.deepEqual(parseNginx(plain), [{ names: ["plex.example.com"], https: false, host: "192.168.20.5", port: 32400, via: "nginx" }]);
  assert.deepEqual(parseNginx(swag), [], "app.* needs the domain");
});

test("TestProxies_LinksUseProxyThenDnsThenLanAddress", async () => {
  // The Unraid agent: four containers. Its address is a name we can't resolve here, so the server's LAN address comes from its network answer.
  const agent = await serve((req, res) => {
    if (req.url === "/api/v1/system") return J(res, { hostname: "tower" });
    if (req.url === "/api/v1/network") return J(res, [{ name: "docker0", ip_address: "172.17.0.1" }, { name: "br0", ip_address: "192.168.20.5" }]);
    if (req.url === "/api/v1/docker") return J(res, [
      { name: "sonarr", state: "running", network_mode: "bridge", ports: [{ private_port: 8989, public_port: 8989, type: "tcp" }] },
      { name: "radarr", state: "running", network_mode: "bridge", ports: [{ private_port: 7878, public_port: 7878, type: "tcp" }] },
      { name: "Plex", state: "running", network_mode: "host", ports: [{ private_port: 32400, public_port: 0, type: "tcp" }] },
      { name: "uptime-kuma", state: "running", network_mode: "bridge", ports: [{ private_port: 3001, public_port: 3011, type: "tcp" }] },
      { name: "nginx-proxy-manager", state: "running", network_mode: "bridge", ports: [{ private_port: 81, public_port: 81, type: "tcp" }] },
    ]);
    J(res, {}, 404);
  });
  let signIns = 0;
  const npm = await serve((req, res, body) => {
    if (req.url === "/api/tokens") { const b = JSON.parse(body); signIns++; return b.identity === "me@x" && b.secret === "pw" ? J(res, { token: "t" }) : J(res, { error: "no" }, 401); }
    if (req.url === "/api/nginx/proxy-hosts" && req.headers.authorization === "Bearer t") return J(res, [
      { domain_names: ["radarr.thefellashub.com"], forward_host: "192.168.20.5", forward_port: 7878, certificate_id: 3, enabled: true },
      { domain_names: ["old.thefellashub.com"], forward_host: "192.168.20.5", forward_port: 3011, certificate_id: 0, enabled: false },
    ]);
    J(res, {}, 401);
  });
  const dns = await serve((req, res) => {
    const u = new URL(req.url, "http://x"); if (u.searchParams.get("token") !== "dt") return J(res, { status: "invalid-token" });
    if (u.pathname === "/api/zones/list") return J(res, { status: "ok", response: { zones: [{ name: "home.lan", type: "Primary" }, { name: "20.168.192.in-addr.arpa", type: "Primary" }] } });
    if (u.pathname === "/api/zones/records/get") return J(res, { status: "ok", response: { records: [{ name: "plex.home.lan", type: "A", rData: { ipAddress: "192.168.20.5" } }, { name: "tower.home.lan", type: "A", rData: { ipAddress: "192.168.20.5" } }] } });
    J(res, {}, 404);
  });
  const conf = mkdtempSync(join(tmpdir(), "orb-nginx-")); mkdirSync(join(conf, "proxy-confs"));
  writeFileSync(join(conf, "proxy-confs", "sonarr.subdomain.conf"), "server { listen 443 ssl; server_name sonarr.*; location / { set $upstream_app sonarr; set $upstream_port 8989; proxy_pass http://$upstream_app:$upstream_port; } }");
  writeFileSync(join(conf, "proxy-confs", "x.subdomain.conf.sample"), "server { listen 443 ssl; server_name uptime-kuma.*; location / { set $upstream_app uptime-kuma; set $upstream_port 3001; } }");
  Object.assign(process.env, { PX_A: "me@x", PX_B: "pw", PX_T: "dt", PX_U: "u" });
  try {
    const base = loadConfig("/nonexistent.yaml", { UNRAID_URL: agent.url.replace("127.0.0.1", "unraid-agent.invalid"), NPM_URL: npm.url, TECHNITIUM_URL: dns.url, NGINX_CONF_DIR: conf, NGINX_DOMAIN: "thefellashub.com" });
    // The agent's name doesn't resolve in the test, so point its traffic at the fake but keep the name for the address lookup.
    const cfg = { ...base, unraid: { ...base.unraid, baseUrl: agent.url, tokenEnv: "PX_U" }, npm: { ...base.npm, emailEnv: "PX_A", passwordEnv: "PX_B" }, technitium: { ...base.technitium, tokenEnv: "PX_T" } };
    const { app } = await buildApp({ config: cfg });
    const r = (await app.inject({ method: "GET", url: "/api/links?host=orb.thefellashub.com" })).json();
    const by = Object.fromEntries(r.apps.map((a: any) => [a.name, [a.url, a.via]]));
    assert.deepEqual(by.radarr, ["https://radarr.thefellashub.com", "npm"], "Nginx Proxy Manager knows it");
    assert.deepEqual(by.sonarr, ["https://sonarr.thefellashub.com", "nginx"], "a SWAG config knows it (by container name)");
    assert.deepEqual(by.Plex, ["http://plex.home.lan:32400", "dns"], "Technitium has a name for it on the server");
    assert.equal(by["uptime-kuma"][1], "lan", "a disabled proxy host and a .sample file don't count");
    assert.ok(!JSON.stringify(r.apps).includes("orb.thefellashub.com"), "never the address Orb was opened with");
    assert.deepEqual([r.sources.npm, r.sources.nginx, r.sources.dns], [1, 1, 2]);
    // The agent here is 127.0.0.1 (an IP), so that is the LAN address; with a setting, the setting wins.
    assert.equal(r.host, "127.0.0.1"); assert.deepEqual(by["uptime-kuma"], ["http://127.0.0.1:3011", "lan"]);
    // Suggestions for Orb's own connections use the LAN address, and find Nginx Proxy Manager's admin port.
    const sug = (await app.inject({ method: "GET", url: "/api/links/suggest" })).json();
    assert.ok(!sug.some((x: any) => x.conn === "npm"), "already set");
    assert.equal(signIns, 1, "signed in once and reused");
    const t = (await app.inject({ method: "POST", url: "/api/connections/test/npm" })).json(); assert.equal(t.ok, true);
    assert.match((await app.inject({ method: "POST", url: "/api/connections/test/technitium" })).json().detail, /2 A records/);
    assert.match((await app.inject({ method: "POST", url: "/api/connections/test/nginx" })).json().detail, /1 proxied site/);
    await app.close();

    // With the agent's address a name that doesn't resolve, the LAN address comes from the agent's network answer.
    const { serverAddress } = await import("../src/integrations/proxies.js");
    const a = await serverAddress("", "http://unraid-agent.invalid:8043", async () => "192.168.20.5");
    assert.deepEqual(a, { host: "192.168.20.5", how: "the Unraid agent's network" });
    assert.equal((await serverAddress("192.168.20.5:8043", "")).host, "192.168.20.5", "a port in the setting is dropped");
  } finally { agent.close(); npm.close(); dns.close(); for (const k of ["PX_A", "PX_B", "PX_T", "PX_U"]) delete process.env[k]; }
});
