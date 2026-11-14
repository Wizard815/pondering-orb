import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { resolveWebui } from "../src/integrations/unraid.js";

const serve = (h: (req: any, res: any) => void) => new Promise<{ url: string; port: number; close: () => void }>(ok => {
  const s = createServer(h).listen(0, "127.0.0.1", () => { const port = (s.address() as any).port; ok({ url: `http://127.0.0.1:${port}`, port, close: () => s.close() }); });
});
const J = (res: any, o: unknown, c = 200) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };

test("TestUnraid_LinksFromAgentAndDockerLabels", async () => {
  process.env.UN_TOKEN = "secret";
  // The agent: containers with port mappings, no WebUI or icon.
  const agent = await serve((req, res) => {
    if (req.headers.authorization !== "Bearer secret") return J(res, { error: "unauthorized" }, 401);
    if (req.url === "/api/v1/system") return J(res, { hostname: "tower", version: "7.2.0" });
    if (req.url === "/api/v1/docker") return J(res, [
      { name: "plex", image: "plexinc/pms-docker", state: "running", network_mode: "host", ports: [] },
      { name: "uptime-kuma", image: "louislam/uptime-kuma", state: "running", network_mode: "bridge", ports: [{ private_port: 3001, public_port: 3011, type: "tcp" }] },
      { name: "sonarr", image: "linuxserver/sonarr", state: "stopped", network_mode: "bridge", ports: [{ private_port: 8989, public_port: 8990, type: "tcp" }], update_available: true },
      { name: "mosquitto", image: "eclipse-mosquitto", state: "running", network_mode: "bridge", ports: [{ private_port: 1883, public_port: 1883, type: "udp" }] },
    ]);
    J(res, {}, 404);
  });
  // The Docker socket proxy: the Unraid labels.
  const dock = await serve((req, res) => {
    if (String(req.url).startsWith("/containers/json")) return J(res, [
      { Names: ["/plex"], State: "running", Image: "plex", Ports: [], HostConfig: { NetworkMode: "host" }, Labels: { "net.unraid.docker.webui": "http://[IP]:[PORT:32400]/web", "net.unraid.docker.icon": "https://example.com/plex.png" } },
      { Names: ["/uptime-kuma"], State: "running", Image: "kuma", Ports: [{ PrivatePort: 3001, PublicPort: 3011, Type: "tcp" }, { PrivatePort: 3001, PublicPort: 3011, Type: "tcp" }], Labels: { "net.unraid.docker.icon": "javascript:alert(1)" } },
    ]);
    J(res, {}, 404);
  });
  try {
    const { app } = await buildApp({ config: loadConfig("/nonexistent.yaml", { UNRAID_URL: agent.url, DOCKER_HOST: `tcp://127.0.0.1:${dock.port}` }) });
    await app.inject({ method: "PUT", url: "/api/c/settings/app", payload: { connections: { unraid: { tokenEnv: "UN_TOKEN" } } } });
    const t = (await app.inject({ method: "POST", url: "/api/connections/test/unraid" })).json();
    assert.equal(t.ok, true); assert.match(t.detail, /tower.*7\.2\.0.*4 containers/);

    const r = (await app.inject({ method: "GET", url: "/api/links?host=evil%20host" })).json();
    assert.equal(r.host, "127.0.0.1", "links use the agent's host when no link address is set");
    assert.deepEqual(r.sources, { unraid: true, docker: true });
    const by = Object.fromEntries(r.apps.map((a: any) => [a.name, a]));
    assert.equal(by.plex.url, "http://127.0.0.1:32400/web", "Unraid's WebUI label, with the host-network port");
    assert.equal(by.plex.icon, "https://example.com/plex.png");
    assert.equal(by["uptime-kuma"].url, "http://127.0.0.1:3011", "no WebUI: the first TCP host port");
    assert.equal(by["uptime-kuma"].icon, "", "only http(s) icons");
    assert.equal(by.sonarr.updateAvailable, true); assert.equal(by.mosquitto.url, "", "no TCP port, no link");

    // Suggestions only for connections that are empty.
    const s = (await app.inject({ method: "GET", url: "/api/links/suggest" })).json();
    assert.deepEqual(s.map((x: any) => [x.conn, x.url, x.container]), [["uptime", "http://127.0.0.1:3011", "uptime-kuma"]]);

    // A link address set in Settings wins.
    await app.inject({ method: "PUT", url: "/api/c/settings/app", payload: { connections: { unraid: { tokenEnv: "UN_TOKEN", linkHost: "tower.lan" } } } });
    assert.equal((await app.inject({ method: "GET", url: "/api/links" })).json().apps.find((a: any) => a.name === "plex").url, "http://tower.lan:32400/web");
    // A wrong token is reported, and Docker still gives the list.
    process.env.UN_TOKEN = "nope";
    await app.inject({ method: "PUT", url: "/api/c/settings/app", payload: { connections: { unraid: { tokenEnv: "UN_TOKEN", linkHost: "x.lan" } } } });
    const bad = (await app.inject({ method: "GET", url: "/api/links" })).json();
    assert.match(bad.notes.join(" "), /refused the token/); assert.deepEqual(bad.apps.map((a: any) => a.name), ["plex", "uptime-kuma"]);
    await app.close();
  } finally { agent.close(); dock.close(); delete process.env.UN_TOKEN; }
});

test("TestUnraid_WebuiTemplates", () => {
  const ports = [{ private: 8080, public: 8081, type: "tcp" }];
  assert.equal(resolveWebui("http://[IP]:[PORT:8080]/", "tower", ports), "http://tower:8081/");
  assert.equal(resolveWebui("https://[IP]:[PORT:443]", "tower", ports), "https://tower:443", "unmapped: the container port");
  assert.equal(resolveWebui("http://[IP]:[PORT:8080]/", "", ports), "", "no host, no link");
});
