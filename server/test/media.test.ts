import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const cfg = (over: any = {}) => ({ ...loadConfig("/nonexistent.yaml", {}), ...over });
function serve(h: (req: any, body: string, res: any) => void): Promise<{ url: string; server: Server }> {
  return new Promise(r => { const server = createServer((req, res) => { let b = ""; req.on("data", d => (b += d)); req.on("end", () => h(req, b, res)); }).listen(0, () => r({ url: `http://127.0.0.1:${(server.address() as any).port}`, server })); });
}
const J = (res: any, o: any, c = 200) => { res.writeHead(c, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
const soon = (days: number) => new Date(Date.now() + days * 864e5).toISOString();
async function appWith(name: string, type: string, url: string, env: string) {
  const { app } = await buildApp({ config: cfg() });
  await app.inject({ method: "PUT", url: "/api/c/settings/apps", payload: { yaml: `groups:\n  - name: Media\n    apps:\n      - name: ${name}\n        url: http://media.lan\n        widget: { type: ${type}, url: ${url}, key_env: ${env} }\n` } });
  return app;
}

test("TestWidgets_SonarrCalendarAndQueue", async () => {
  const seen: string[] = [];
  const s = await serve((req, body, res) => {
    seen.push(req.url);
    if (req.headers["x-api-key"] !== "sk1") return J(res, { error: "Unauthorized" }, 401);
    if (req.url.startsWith("/api/v3/calendar?")) return J(res, [
      { seasonNumber: 2, episodeNumber: 5, title: "Later", airDateUtc: soon(3), hasFile: false, series: { title: "Severance" } },
      { seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDateUtc: soon(1), hasFile: true, series: { title: "Andor" } },
    ]);
    if (req.url.startsWith("/api/v3/queue?")) return J(res, { totalRecords: 1, records: [{ title: "Andor.S01E02.1080p", size: 1000, sizeleft: 250, status: "downloading", trackedDownloadState: "downloading", trackedDownloadStatus: "ok", timeleft: "00:04:10" }] });
    J(res, {}, 404);
  });
  process.env.TEST_SONARR = "sk1";
  try {
    const app = await appWith("Sonarr", "sonarr", s.url, "TEST_SONARR");
    const w = (await app.inject({ url: "/api/widgets/Sonarr" })).json();
    assert.deepEqual(w.upcoming.map((u: any) => [u.title, u.detail]), [["Andor", "S01E01 Pilot"], ["Severance", "S02E05 Later"]], "soonest first");
    assert.deepEqual([w.queue[0].pct, w.queue[0].status, w.queue[0].timeleft, w.queueTotal], [75, "downloading", "00:04:10", 1]);
    assert.ok(seen.some(u => u.includes("includeSeries=true") && u.startsWith("/api/v3/calendar")));
    assert.ok(!JSON.stringify(w).includes("sk1"), "the key never reaches the page");
    process.env.TEST_SONARR = "wrong";
    const bad = await (await appWith("Sonarr wrong", "sonarr", s.url, "TEST_SONARR")).inject({ url: "/api/widgets/Sonarr%20wrong" });
    assert.equal(bad.statusCode, 502); assert.match(bad.json().error, /Sonarr refused the API key in TEST_SONARR/);
    process.env.TEST_SONARR = "";
    const none = await (await appWith("Sonarr empty", "sonarr", s.url, "TEST_SONARR")).inject({ url: "/api/widgets/Sonarr%20empty" });
    assert.equal(none.statusCode, 400); assert.match(none.json().error, /TEST_SONARR is empty/);
  } finally { s.server.close(); }
});

test("TestWidgets_RadarrReleasesAndAppDown", async () => {
  const day = (n: number) => soon(n).slice(0, 10) + "T00:00:00Z";
  const r = await serve((req, body, res) => {
    if (req.headers["x-api-key"] !== "rk") return J(res, {}, 401);
    if (req.url.startsWith("/api/v3/calendar?")) return J(res, [{ title: "Dune: Part Three", year: 2026, inCinemas: "2026-01-01T00:00:00Z", digitalRelease: day(2), hasFile: false }]);
    if (req.url.startsWith("/api/v3/queue?")) return J(res, { totalRecords: 0, records: [] });
    J(res, {}, 404);
  });
  process.env.TEST_RADARR = "rk";
  try {
    const w = (await (await appWith("Radarr", "radarr", r.url, "TEST_RADARR")).inject({ url: "/api/widgets/Radarr" })).json();
    assert.deepEqual([w.upcoming[0].title, w.upcoming[0].detail, w.queue.length], ["Dune: Part Three (2026)", "Digital", 0], "the release date in this week is the one shown");
    const port = new URL(r.url).port; r.server.close(); r.server.closeAllConnections();
    const down = await (await appWith("Radarr down", "radarr", `http://127.0.0.1:${port}`, "TEST_RADARR")).inject({ url: "/api/widgets/Radarr%20down" });
    assert.equal(down.statusCode, 502); assert.match(down.json().error, /Couldn't reach 127\.0\.0\.1/);
  } finally { r.server.close(); }
});

test("TestWidgets_TautulliActivityAndHistory", async () => {
  const t = await serve((req, body, res) => {
    const u = new URL(req.url, "http://x");
    if (u.searchParams.get("apikey") !== "tk") return J(res, { response: { result: "error", message: "Invalid apikey", data: {} } });
    if (u.searchParams.get("cmd") === "get_activity") return J(res, { response: { result: "success", data: { stream_count: "2", stream_count_transcode: 1, sessions: [
      { media_type: "episode", grandparent_title: "The Expanse", parent_media_index: "3", media_index: "4", title: "Reload", friendly_name: "wiz", player: "TV", state: "playing", progress_percent: "40", transcode_decision: "transcode" },
      { media_type: "movie", full_title: "Heat", title: "Heat", friendly_name: "kid", player: "iPad", state: "paused", progress_percent: "10", transcode_decision: "direct play" },
    ] } } });
    if (u.searchParams.get("cmd") === "get_history") { assert.equal(u.searchParams.get("length"), "5"); return J(res, { response: { result: "success", data: { recordsTotal: 812, data: [{ full_title: "Heat", friendly_name: "kid", date: 1764000000 }] } } }); }
    J(res, {}, 404);
  });
  process.env.TEST_TAUTULLI = "tk";
  try {
    const w = (await (await appWith("Tautulli", "tautulli", t.url, "TEST_TAUTULLI")).inject({ url: "/api/widgets/Tautulli" })).json();
    assert.deepEqual([w.streams, w.transcodes, w.sessions[0].title, w.sessions[0].user, w.sessions[0].transcode, w.sessions[1].transcode], [2, 1, "The Expanse · S03E04 Reload", "wiz", true, false]);
    assert.deepEqual([w.plays.total, w.plays.recent[0].title, w.plays.recent[0].at], [812, "Heat", new Date(1764000000 * 1000).toISOString()]);
    assert.ok(!JSON.stringify(w).includes("tk\""), "the key never reaches the page");
    process.env.TEST_TAUTULLI = "nope";
    const bad = await (await appWith("Tautulli wrong", "tautulli", t.url, "TEST_TAUTULLI")).inject({ url: "/api/widgets/Tautulli%20wrong" });
    assert.equal(bad.statusCode, 502); assert.match(bad.json().error, /Tautulli refused the API key/);
  } finally { t.server.close(); }
});

test("TestWidgets_SeerrRequests", async () => {
  let lookups = 0;
  const sr = await serve((req, body, res) => {
    if (req.headers["x-api-key"] !== "ok") return J(res, { message: "You do not have permission to access this endpoint." }, 403);
    if (req.url.startsWith("/api/v1/request/count")) return J(res, { total: 40, movie: 30, tv: 10, pending: 3, approved: 30, declined: 2, processing: 4, available: 30 });
    if (req.url.startsWith("/api/v1/request?")) { assert.match(req.url, /take=5/); assert.match(req.url, /sort=added/); return J(res, { pageInfo: { results: 40 }, results: [
      { id: 9, type: "movie", status: 1, createdAt: "2026-11-26T10:00:00.000Z", media: { tmdbId: 550, mediaType: "movie", status: 2 }, requestedBy: { displayName: "Kid" } },
      { id: 8, type: "tv", status: 2, createdAt: "2026-11-25T10:00:00.000Z", media: { tmdbId: 1399, mediaType: "tv", status: 5 }, requestedBy: { displayName: "Wizard" } },
    ] }); }
    if (req.url === "/api/v1/movie/550") { lookups++; return J(res, { title: "Fight Club" }); }
    if (req.url === "/api/v1/tv/1399") { lookups++; return J(res, { name: "Game of Thrones" }); }
    J(res, {}, 404);
  });
  process.env.TEST_SEERR = "ok";
  try {
    const app = await appWith("Seerr", "seerr", sr.url, "TEST_SEERR");
    const w = (await app.inject({ url: "/api/widgets/Seerr" })).json();
    assert.deepEqual([w.pending, w.processing, w.total], [3, 4, 40]);
    assert.deepEqual(w.requests.map((r: any) => [r.title, r.kind, r.status, r.media, r.user]), [["Fight Club", "movie", "pending", "pending", "Kid"], ["Game of Thrones", "tv", "approved", "available", "Wizard"]]);
    await (await appWith("Seerr again", "seerr", sr.url, "TEST_SEERR")).inject({ url: "/api/widgets/Seerr%20again" });
    assert.equal(lookups, 2, "titles are looked up once");
    process.env.TEST_SEERR = "bad";
    const bad = await (await appWith("Seerr wrong", "seerr", sr.url, "TEST_SEERR")).inject({ url: "/api/widgets/Seerr%20wrong" });
    assert.equal(bad.statusCode, 502); assert.match(bad.json().error, /Seerr refused the API key in TEST_SEERR/);
  } finally { sr.server.close(); }
});
