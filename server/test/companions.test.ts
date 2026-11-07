import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { orbTools } from "../src/tools.js";
import { clearCompanionCache } from "../src/integrations/companions.js";

const cfg = (over: any = {}) => ({ ...loadConfig("/nonexistent.yaml", {}), ...over });
const serve = (h: (req: any, body: string, res: any) => void) => new Promise<{ url: string; close: () => void; hits: any[] }>(ok => {
  const hits: any[] = [];
  const s = createServer((req, res) => { let b = ""; req.on("data", d => (b += d)); req.on("end", () => { hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: b }); h(req, b, res); }); })
    .listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(s.address() as any).port}`, close: () => s.close(), hits }));
});
const J = (res: any, o: unknown, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };

test("TestCompanions_ReadOnlyWidgetsAndGolemTools", async () => {
  process.env.GB_KEY = "orbkey"; process.env.OMI_KEY = "omi_dev_x";
  const gb = await serve((req, _b, res) => req.url === "/api/v1/summary" && req.headers.authorization === "Bearer orbkey"
    ? J(res, { goblins: { alice: { goblin: "alice", net_worth: 12000.5, subscriptions_monthly: 42.1, robinhood_agent: { as_of: "2026-11-07", balances: { equity: 510.25 } } }, bob: { error: "unavailable" }, carol: { goblin: "carol" } } })
    : J(res, { detail: "unauthorized" }, 401));
  const omi = await serve((req, _b, res) => {
    const u = new URL(req.url, "http://x");
    if (req.headers.authorization !== "Bearer omi_dev_x") return J(res, {}, 401);
    if (u.pathname === "/v1/dev/user/daily-summaries") return J(res, { summaries: [{ date: "2026-11-06", headline: "Shipped the NAS fix", overview: "Long day.", day_emoji: "🛠", decisions_made: [{ decision: "Move backups to Sunday" }], unresolved_questions: [{ question: "Which UPS?" }] }] });
    if (u.pathname === "/v1/dev/user/conversations") return J(res, [{ id: "c1", started_at: "2026-11-06T15:00:00Z", structured: { title: "NAS planning", overview: "Talked through RAID." } }]);
    if (u.pathname === "/v1/dev/user/memories/search") return J(res, { memories: [{ content: "Prefers ZFS mirrors", category: "tech" }], search_coverage: "full" });
    J(res, {}, 404);
  });
  clearCompanionCache();
  try {
    const { app } = await buildApp({ config: cfg() });
    const yaml = `groups:\n  - name: Home\n    apps:\n      - name: Bank\n        url: ${gb.url}\n        widget: { type: goblinbank, key_env: GB_KEY }\n      - name: Omi\n        url: ${omi.url}\n        widget: { type: omi, key_env: OMI_KEY }\n`;
    await app.inject({ method: "PUT", url: "/api/c/settings/apps", payload: { yaml } });
    const bank = (await app.inject({ method: "GET", url: "/api/widgets/Bank" })).json();
    assert.equal(bank.netWorth, 12000.5, "only people who share net worth count");
    assert.equal(bank.people.find((p: any) => p.name === "alice").robinhoodAgent.equity, 510.25);
    assert.equal(bank.people.find((p: any) => p.name === "bob").error, "unavailable");
    const o = (await app.inject({ method: "GET", url: "/api/widgets/Omi" })).json();
    assert.equal(o.day.headline, "Shipped the NAS fix"); assert.deepEqual(o.day.decisions, ["Move backups to Sunday"]); assert.equal(o.conversations[0].title, "NAS planning");
    // Only GETs ever reached either app.
    assert.ok([...gb.hits, ...omi.hits].every(h => h.method === "GET"), JSON.stringify([...gb.hits, ...omi.hits].map(h => h.method)));
    assert.ok(!omi.hits.some(h => h.url.includes("action-items")), "Omi's action items are never read from Omi (they come from CalDAV)");
  } finally { gb.close(); omi.close(); clearCompanionCache(); delete process.env.GB_KEY; delete process.env.OMI_KEY; }
});

test("TestCompanions_OmiTasksComeOnlyFromCalDavAndStayReadOnly", async () => {
  const omiIcs = "BEGIN:VCALENDAR\r\nPRODID:-//omi-local//CalDAV sync//EN\r\nBEGIN:VTODO\r\nUID:omi-task-abc@omi-local\r\nSUMMARY:Order the UPS\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";
  const mine = "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:mine-1\r\nSUMMARY:Patch the NAS\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";
  const ev = (uid: string, title: string) => `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${title}\r\nDTSTART:${new Date().toISOString().slice(0, 10).replace(/-/g, "")}T180000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const dav = await serve((req, _b, res) => {
    const coll = (h: string, n: string, comp: string) => `<d:response><d:href>${h}</d:href><d:propstat><d:prop><d:displayname>${n}</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="${comp}"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response>`;
    if (req.method === "PROPFIND") { res.writeHead(207); return res.end(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${coll("/dav/tasks/", "Tasks", "VTODO")}${coll("/dav/cal/", "Calendar", "VEVENT")}</d:multistatus>`); }
    if (req.method === "REPORT" && req.url.startsWith("/dav/tasks/")) { res.writeHead(207); return res.end(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${[["/dav/tasks/omi.ics", omiIcs], ["/dav/tasks/mine.ics", mine]].map(([h, i]) => `<d:response><d:href>${h}</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag><c:calendar-data>${esc(i)}</c:calendar-data></d:prop></d:propstat></d:response>`).join("")}</d:multistatus>`); }
    if (req.method === "REPORT" && req.url.startsWith("/dav/cal/")) { res.writeHead(207); return res.end(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${[ev("omi-day-2026-11-06@omi-local", "Omi: your day"), ev("omi-event-x@omi-local", "NAS planning"), ev("real-1", "Dentist")].map((i, k) => `<d:response><d:href>/dav/cal/${k}.ics</d:href><d:propstat><d:prop><c:calendar-data>${esc(i)}</c:calendar-data></d:prop></d:propstat></d:response>`).join("")}</d:multistatus>`); }
    res.writeHead(204, { ETag: '"2"' }); res.end();
  });
  try {
    const { app, records, sync } = await buildApp({ config: cfg({ caldav: { url: dav.url + "/dav/", userEnv: "", passwordEnv: "", choresList: "Chores" } }), tokens: "bot:t", password: "pw" });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: "pw" } }), cookie = String(login.headers["set-cookie"]).split(";")[0];
    await sync.pull();
    const tasks = records.list("tasks") as any[];
    const omiTask = tasks.find(t => t.title === "Order the UPS"), myTask = tasks.find(t => t.title === "Patch the NAS");
    assert.equal(tasks.filter(t => t.title === "Order the UPS").length, 1, "one copy, from CalDAV");
    assert.equal(omiTask.source, "omi"); assert.equal(myTask.source, "");
    // Every way of changing an Omi task is refused; yours still work.
    assert.equal((await app.inject({ method: "PATCH", url: `/api/c/tasks/${omiTask.id}`, headers: { cookie }, payload: { done: true } })).statusCode, 403);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/c/tasks/${omiTask.id}`, headers: { cookie } })).statusCode, 403);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/c/tasks/${myTask.id}`, headers: { cookie }, payload: { done: true } })).statusCode, 200);
    const complete = orbTools(records).find(t => t.name === "orb_complete_task")!;
    assert.throws(() => complete.run({ title: "Order the UPS" }, "golem"), /comes from Omi/);
    // Even a direct record change is never pushed to CalDAV.
    records.patch("tasks", omiTask.id, { title: "renamed" }); await new Promise(r => setTimeout(r, 100));
    assert.ok(!dav.hits.some(h => h.method === "PUT" && h.url.includes("omi")), "Orb never writes Omi's task");
    // Omi's day reviews and conversation events stay out of Today / This week.
    const evs = (await app.inject({ method: "GET", url: "/api/daily/events?days=2", headers: { cookie } })).json();
    assert.deepEqual(evs.map((e: any) => e.title), ["Dentist"]);
  } finally { dav.close(); }
});
