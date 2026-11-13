import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { localDay } from "../src/dates.js";
import { clearCoinpileCache } from "../src/integrations/coinpile.js";

const day = (k: number) => localDay(Date.now() + k * 864e5);
const at = (k: number, h: number) => { const d = new Date(`${day(k)}T00:00:00`); d.setHours(h, 15); return d.toISOString(); };
const serve = (h: (req: any, res: any, body: string) => void) => new Promise<{ url: string; close: () => void }>(ok => {
  const s = createServer((req, res) => { let b = ""; req.on("data", c => (b += c)); req.on("end", () => h(req, res, b)); }).listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(s.address() as any).port}`, close: () => s.close() }));
});
const J = (res: any, o: unknown, c = 200) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

test("TestJournal_DayLogMoneyWorkOmiAndSnapshots", async () => {
  process.env.JF_TOKEN = "pat"; process.env.JO_KEY = "omi"; process.env.JC_TOKEN = "cp";
  const tx = (k: number, description: string, amount: string, type: string) => ({ attributes: { transactions: [{ date: at(k, 10), description, amount, type, category_name: "x", source_name: "Checking", destination_name: "Shop", currency_code: "USD" }] } });
  const ff = await serve((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/api/v1/transactions") { assert.equal(u.searchParams.get("start"), u.searchParams.get("end")); const d = u.searchParams.get("start");
      return J(res, { meta: { pagination: { total_pages: 1 } }, data: d === day(0) ? [tx(0, "Groceries", "40.50", "withdrawal"), tx(0, "Coffee", "4.25", "withdrawal"), tx(0, "Paycheck", "1200", "deposit"), tx(0, "To savings", "300", "transfer")] : [tx(-1, "Fuel", "50", "withdrawal")] }); }
    J(res, { data: [] });
  });
  const omi = await serve((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname.endsWith("/daily-summaries")) return J(res, { summaries: [{ date: u.searchParams.get("start_date") || day(0), headline: "Fixed the NAS", overview: "A long day.", decisions_made: [{ decision: "Backups on Sunday" }], unresolved_questions: [{ question: "Which UPS?" }], highlights: [{ topic: "NAS", summary: "Disk swapped" }] }] });
    if (u.pathname.endsWith("/conversations")) return J(res, [{ id: "1", started_at: at(0, 9), structured: { title: "NAS talk", overview: "RAID" } }, { id: "2", started_at: at(-3, 9), structured: { title: "Old" } }]);
    J(res, {});
  });
  const cp = await serve((_req, res) => J(res, { goblins: { me: { alert_list: [{ severity: "critical", kind: "bank_login", title: "Sign in again" }], daily: [{ date: day(-2), spent: 77.7, income: 0 }] } } }));
  const um = await serve((req, res) => {
    if (req.url === "/api/repos") return J(res, [{ id: "orb", name: "pondering-orb" }]);
    if (req.url === "/api/requests") return J(res, [{ id: "r1", repo_name: "orb", type: "merge", status: "approved", created_at: at(-1, 8), decided_at: at(0, 11), comment: "ok" }]);
    if (String(req.url).startsWith("/api/repo/orb/commits")) return J(res, { items: [{ sha: "abc1234567890", subject: "Fix the tabs", date: at(0, 14) }, { sha: "def", subject: "Old work", date: at(-5, 9) }] });
    J(res, {}, 404);
  });
  const hs = await serve((req, res) => {
    if (req.url === "/api/auth/login") return J(res, { token: "t" });
    if (req.url === "/api/studio/orb/work") return J(res, { work: [{ sessionId: "s1", agentId: "claude-code", status: "done", title: "Phone layout", orb: { task: { title: "Sketch it", list: "Inbox" }, project: "Orb" }, updatedAt: Date.parse(at(0, 16)) },
      { sessionId: "s2", agentId: "hermes", status: "idle", title: "Old chat", updatedAt: Date.parse(at(-4, 9)) }] });
    if (req.url === "/api/studio/sessions/s1") return J(res, { session: { title: "Phone layout", messages: [{ role: "user", content: "Do it" }, { role: "assistant", content: "Stacked the panels; next I'll open a PR." }] } });
    J(res, {}, 404);
  });
  try {
    const { app, records, journal } = await buildApp({ password: "pw", tokens: "bot:tok", config: loadConfig("/nonexistent.yaml", { UPSTREAM_URL: um.url, HERMES_URL: hs.url }) });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: "pw" } });
    const cookie = { orb_session: String(login.cookies.find((c: any) => c.name === "orb_session")?.value) }, bot = { authorization: "Bearer tok" };
    const yaml = `groups:\n  - name: Money\n    apps:\n      - name: Firefly\n        url: ${ff.url}\n        widget: { type: firefly, key_env: JF_TOKEN }\n      - name: Omi\n        url: ${omi.url}\n        widget: { type: omi, key_env: JO_KEY }\n      - name: Coinpile\n        url: ${cp.url}\n        widget: { type: coinpile, key_env: JC_TOKEN }\n`;
    await app.inject({ method: "PUT", url: "/api/c/settings/apps", cookies: cookie, payload: { yaml } });
    records.create("tasks", { title: "Swap the disk", list: "Homelab", done: true, doneAt: day(0), doneBy: "you" });
    records.create("tasks", { title: "Not today", list: "Homelab", done: true, doneAt: day(-1) });
    records.create("logs", { project: "Orb", text: "Shipped the journal", date: day(0) });
    records.create("chores", { name: "Water the plants", everyDays: 3, lastDone: day(0) });

    const a = (await app.inject({ method: "GET", url: `/api/journal/${day(0)}/auto`, cookies: cookie })).json();
    assert.equal(a.final, false, "today is worked out live");
    assert.deepEqual([a.money.source, a.money.spent, a.money.income], ["firefly", 44.75, 1200], "withdrawals out, deposits in, transfers neither");
    assert.deepEqual(a.tasksDone.map((t: any) => t.title), ["Swap the disk"]);
    assert.deepEqual(a.choresDone.map((c: any) => c.name), ["Water the plants"]);
    assert.deepEqual(a.logs.map((l: any) => l.text), ["Shipped the journal"]);
    assert.deepEqual(a.commits.map((c: any) => [c.repo, c.subject]), [["pondering-orb", "Fix the tabs"]], "only that day's commits");
    assert.deepEqual(a.requests.map((r: any) => r.what), ["decided"]);
    assert.equal(a.agents.length, 1); assert.match(a.agents[0].last, /next I'll open a PR/);
    assert.equal(a.omi.headline, "Fixed the NAS"); assert.deepEqual(a.omiConversations.map((c: any) => c.title), ["NAS talk"]);
    assert.deepEqual(a.alerts.map((x: any) => x.title), ["Sign in again"]);

    // A finished day is saved once and then read back, even if the apps change.
    const y = (await app.inject({ method: "GET", url: `/api/journal/${day(-1)}/auto`, cookies: cookie })).json();
    assert.equal(y.final, true); assert.equal(y.money.spent, 50); assert.deepEqual(y.alerts, [], "alerts are only gathered live for today");
    assert.equal((records.get("journal", day(-1)) as any).auto.money.spent, 50);
    // Coinpile's own daily totals count when it shares them.
    clearCoinpileCache(); assert.equal((await journal.build(day(-2))).money?.spent, 77.7);

    // Writing: you, not agents; the saved log can't be overwritten from the API.
    assert.equal((await app.inject({ method: "PUT", url: `/api/c/journal/${day(0)}`, headers: bot, payload: { text: "x" } })).statusCode, 403);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/c/journal/${day(-1)}`, cookies: cookie, payload: { text: "Long day.", auto: { money: null } } })).statusCode, 200);
    const j: any = records.get("journal", day(-1)); assert.equal(j.text, "Long day."); assert.equal(j.auto.money.spent, 50);
    assert.equal((await app.inject({ method: "GET", url: `/api/journal/${day(1)}/auto`, cookies: cookie })).statusCode, 400, "no log for tomorrow");

    // Images for drawing pages: real images only, served as what they are.
    const up = await app.inject({ method: "POST", url: "/api/journal/files", cookies: cookie, headers: { "content-type": "image/png" }, payload: PNG });
    assert.equal(up.statusCode, 200); const id = up.json().id; assert.match(id, /^[a-f0-9]{32}\.png$/);
    const got = await app.inject({ method: "GET", url: `/api/journal/files/${id}`, cookies: cookie });
    assert.equal(got.headers["content-type"], "image/png"); assert.equal(got.headers["x-content-type-options"], "nosniff"); assert.equal(got.rawPayload.length, PNG.length);
    assert.equal((await app.inject({ method: "POST", url: "/api/journal/files", cookies: cookie, headers: { "content-type": "image/png" }, payload: Buffer.from("<svg onload=alert(1)>") })).statusCode, 415);
    assert.equal((await app.inject({ method: "POST", url: "/api/journal/files", headers: { ...bot, "content-type": "image/png" }, payload: PNG })).statusCode, 403);
    assert.equal((await app.inject({ method: "GET", url: "/api/journal/files/..%2Forb.db", cookies: cookie })).statusCode, 404);
    await app.close();
  } finally { ff.close(); omi.close(); cp.close(); um.close(); hs.close(); clearCoinpileCache(); delete process.env.JF_TOKEN; delete process.env.JO_KEY; delete process.env.JC_TOKEN; }
});
