import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { actorFor } from "../src/boards.js";

/** Agents on Milaclone boards (orb_board_* tools) against a fake Milaclone that answers its agent routes
 *  and records what it was sent, with which agent name. */
type Hit = { method: string; url: string; agent?: string; auth?: string; body: any };
async function fakeMila() {
  const hits: Hit[] = [];
  const board = (over: any = {}) => ({ board: "c_1", title: "Garage", path: "Home › Garage", parent: "c_home", boardCard: "i_card",
    sections: [{ id: "i_col", kind: "column", title: "To do", cards: [{ id: "i_a", type: "note", title: "Pegboard", text: "with hooks" }, { id: "i_b", type: "note", title: "Skip", orb: { kind: "task", id: "old" } }] }],
    loose: [{ id: "i_c", type: "note", title: "Paint" }], connections: [], note: "data", ...over });
  let current = board();
  const s = createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    hits.push({ method: req.method!, url: req.url!, agent: req.headers["x-milaclone-agent"] as string, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    const J = (o: unknown, c = 200) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const u = new URL(req.url!, "http://x");
    if (u.pathname === "/api/agent/board") {
      if (u.searchParams.get("board") === "nope") return J({ error: 'No board matches "nope".', boards: [{ id: "c_1", title: "Home › Garage" }] }, 404);
      if (u.searchParams.get("format") === "text") { res.writeHead(200, { "content-type": "text/plain" }); return res.end('Board "Garage" [c_1]'); }
      return J(current);
    }
    if (u.pathname === "/api/agent/boards" && req.method === "GET") return J({ boards: [{ id: "c_1", title: "Garage" }] });
    if (u.pathname === "/api/agent/boards") return J({ board: "c_new", boardCard: "i_new", cards: [] }, 201);
    if (u.pathname === "/api/agent/boards/from-orb") return J({ board: "c_proj", cards: 2 }, 201);
    if (u.pathname === "/api/agent/board/link") return J({ board: "c_1", title: "Garage", orb: raw && JSON.parse(raw).project ? { project: JSON.parse(raw).project } : null });
    if (u.pathname === "/api/activity") return J({ items: [{ id: 3, at: 1700000000000, actor: "Hermes", summary: "added 2 card(s)", canvasId: "c_1", boardTitle: "Garage" }], latest: 3 });
    if (req.method === "DELETE") return u.pathname === "/api/item/gone" ? J({ error: "not found" }, 404) : J({ ok: true });
    return J({ ok: true, board: "c_1" });
  });
  await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(s.address() as any).port}`, hits, close: () => s.close(), set: (o: any) => (current = board(o)) };
}

async function orb(milaUrl = "") {
  const base = loadConfig("/nonexistent.yaml", {});
  process.env.T_MILA_KEY = "mila-secret";
  const { app, records } = await buildApp({ config: { ...base, milaclone: { url: milaUrl, apiUrl: "", keyEnv: "T_MILA_KEY" } }, password: "pw", tokens: "hermes:t" });
  const H = { authorization: "Bearer t" };
  const raw = async (name: string, args: any) => (await app.inject({ method: "POST", url: "/mcp", headers: H, payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } })).json().result;
  const call = async (name: string, args: any) => { const r = await raw(name, args); if (r.isError) throw new Error(r.content[0].text); try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; } };
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: "pw" } });
  const me = { cookie: String(login.headers["set-cookie"]).split(";")[0] };
  return { app, records, call, raw, H, me };
}

test("TestBoards_SayMilacloneIsNotSetUp", async () => {
  const { app, raw, H } = await orb();
  const { tools } = (await app.inject({ method: "POST", url: "/mcp", headers: H, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).json().result;
  for (const n of ["orb_board_find", "orb_board_read", "orb_board_create", "orb_board_add_cards", "orb_board_connect", "orb_board_group", "orb_board_move", "orb_board_mark",
    "orb_board_link_project", "orb_board_to_tasks", "orb_board_from_project", "orb_board_sync_project", "orb_board_activity", "orb_board_remove"]) assert.ok(tools.some((t: any) => t.name === n), n);
  assert.equal(tools.find((t: any) => t.name === "orb_board_remove").annotations.destructiveHint, true);
  assert.equal(tools.find((t: any) => t.name === "orb_board_add_cards").annotations.destructiveHint, false);
  const r = await raw("orb_board_find", {});
  assert.equal(r.isError, true); assert.match(r.content[0].text, /Milaclone isn't set up in Orb\. Set MILACLONE_URL/);
  const act = (await app.inject({ url: "/api/ideas/activity", headers: H })).json();
  assert.deepEqual(act, { configured: false, items: [] });
});

test("TestBoards_WritesCarryTheAgentsName", async () => {
  const m = await fakeMila();
  try {
    const { call, records } = await orb(m.url);
    const p: any = records.create("projects", { name: "Garage", status: "next" });
    await call("orb_board_create", { title: "Garage", layout: "map", sections: [{ title: "Clear", cards: [{ text: "Skip" }] }], project: "garage", agent: "Ekko" });
    const made = m.hits.at(-1)!;
    assert.equal(made.url, "/api/agent/boards"); assert.equal(made.agent, "Ekko"); assert.equal(made.auth, "Bearer mila-secret");
    assert.deepEqual(made.body.orb, { project: "Garage", projectId: p.id });
    assert.deepEqual((records.get("projects", p.id) as any).board, { id: "c_new", title: "Garage" });

    await call("orb_board_add_cards", { board: "Garage", cards: [{ text: "Hooks", section: "Build" }] });
    assert.equal(m.hits.at(-1)!.agent, "hermes", "no name given: the token's name");
    await call("orb_board_connect", { board: "Garage", links: [{ from: "a", to: "b" }], agent: "Hermes" });
    await call("orb_board_group", { board: "Garage", title: "Later", cards: ["Paint"], kind: "section", agent: "Hermes" });
    await call("orb_board_move", { board: "Garage", moves: [{ card: "Paint", to: "Later" }], agent: "Hermes" });
    await call("orb_board_mark", { board: "Garage", marks: [{ card: "Paint", state: "doing" }], agent: "Hermes" });
    assert.deepEqual(m.hits.slice(-4).map(h => [h.url, h.agent]), [
      ["/api/agent/board/connect", "Hermes"], ["/api/agent/board/group", "Hermes"], ["/api/agent/board/move", "Hermes"], ["/api/agent/board/status", "Hermes"]]);
    assert.equal(m.hits.at(-3)!.body.as, "section");
    await assert.rejects(call("orb_board_mark", { board: "Garage", marks: [{ card: "Paint", state: "meh" }] }), /state must be one of/);
    await assert.rejects(call("orb_board_create", { title: "x", sections: [], layout: "spiral" }), /layout must be one of/);
    await assert.rejects(call("orb_board_create", { title: "x", sections: [], project: "Nope" }), /No Orb project named Nope/);
    await assert.rejects(call("orb_board_read", { board: "nope", json: true }), /No board matches "nope"\. Boards: Home › Garage \(c_1\)\./);
    assert.match(await call("orb_board_read", { board: "Garage" }), /^Board "Garage"/);
    assert.equal((await call("orb_board_find", { query: "gar" })).boards.length, 1);
    assert.deepEqual(await call("orb_board_activity", { board: "c_1" }), [{ who: "Hermes", what: "added 2 card(s)", board: "Garage", boardId: "c_1", at: "2023-11-14T22:13:20.000Z" }]);
    assert.equal(actorFor("you"), "Golem");
    assert.equal(actorFor("hermes", "  Claude Code  "), "Claude Code");
  } finally { m.close(); }
});

test("TestBoards_CardsBecomeTasksOnceAndBoardsFollowProjects", async () => {
  const m = await fakeMila();
  try {
    const { call, records } = await orb(m.url);
    const p: any = records.create("projects", { name: "Garage", status: "active", taskList: "Garage jobs" });
    records.create("tasks", { title: "Sweep", list: "Garage jobs" });
    records.create("tasks", { title: "Elsewhere", list: "Inbox" });

    // Unlinked board: Inbox
    const out = await call("orb_board_to_tasks", { board: "Garage", cards: ["pegboard", "i_b"], agent: "Hermes" });
    assert.equal(out.created.length, 1); assert.equal(out.already[0].orb.id, "old");
    const t: any = records.list("tasks").find((x: any) => x.title === "Pegboard");
    assert.equal(t.list, "Inbox");
    const stamp = m.hits.at(-1)!;
    assert.equal(stamp.url, "/api/agent/board/to-orb");
    assert.deepEqual(stamp.body.made, [{ card: "i_a", orb: { kind: "task", id: t.id, list: "Inbox", state: "open" } }]);

    // Linked board: the project's list; projects too
    m.set({ orb: { project: "Garage", projectId: p.id } });
    await call("orb_board_to_tasks", { board: "Garage", cards: ["Paint"] });
    assert.equal((records.list("tasks").find((x: any) => x.title === "Paint") as any).list, "Garage jobs");
    await call("orb_board_to_tasks", { board: "Garage", cards: ["Pegboard"], make: "projects" });
    assert.equal((records.list("projects").find((x: any) => x.name === "Pegboard") as any).next, "with hooks");
    await assert.rejects(call("orb_board_to_tasks", { board: "Garage", cards: ["Nothing"] }), /No card "Nothing"/);
    await assert.rejects(call("orb_board_to_tasks", { board: "Garage", cards: [] }), /at least one card/);
    await assert.rejects(call("orb_board_to_tasks", { board: "Garage", cards: ["Paint"], make: "goals" }), /make must be/);

    // Project -> board, and sync
    const fb = await call("orb_board_from_project", { project: "Garage", agent: "Ekko" });
    assert.equal(fb.board, "c_proj");
    const sent = m.hits.at(-1)!;
    assert.deepEqual(sent.body.project, { id: p.id, name: "Garage", list: "Garage jobs" });
    assert.deepEqual(sent.body.tasks.map((x: any) => x.title).sort(), ["Paint", "Sweep"]);
    assert.deepEqual((records.get("projects", p.id) as any).board, { id: "c_proj", title: "Garage" });
    await call("orb_board_sync_project", { board: "Garage" });
    assert.equal(m.hits.at(-1)!.url, "/api/agent/board/sync-orb");
    assert.equal(m.hits.at(-1)!.body.tasks.length, 2);
    m.set({});
    await assert.rejects(call("orb_board_sync_project", { board: "Garage" }), /isn't linked to an Orb project/);

    // Link and unlink
    await call("orb_board_link_project", { board: "Garage", project: "Garage" });
    assert.deepEqual(m.hits.at(-1)!.body, { board: "Garage", project: "Garage", projectId: p.id });
    assert.deepEqual((records.get("projects", p.id) as any).board, { id: "c_1", title: "Garage" });
    m.set({ orb: { project: "Garage" } });
    await call("orb_board_link_project", { board: "Garage", project: "" });
    assert.equal(m.hits.at(-1)!.body.project, null);
    assert.equal((records.get("projects", p.id) as any).board, null);
  } finally { m.close(); }
});

test("TestBoards_RemovingWaitsForYou", async () => {
  const m = await fakeMila();
  try {
    const { app, call, records, H, me } = await orb(m.url);
    const ask = await call("orb_board_remove", { board: "Garage", cards: ["Pegboard", "Paint"], reason: "duplicates", agent: "Hermes" });
    assert.equal(ask.pending, true); assert.match(ask.message, /Not removed yet/);
    assert.ok(!m.hits.some(h => h.method === "DELETE"), "nothing deleted yet");
    const a: any = records.get("approvals", ask.approval);
    assert.deepEqual([a.source, a.state, a.agent, a.summary], ["orb-board", "pending", "Hermes", "Pegboard, Paint — duplicates"]);
    assert.deepEqual(a.action.itemIds, ["i_a", "i_c"]);

    // An agent can't approve it, or forge or edit one.
    assert.equal((await app.inject({ method: "POST", url: `/api/ideas/approvals/${a.id}/decide`, headers: H, payload: { decision: "approve" } })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: `/api/hermes/approvals/${a.id}/decide`, headers: H, payload: { decision: "approve" } })).statusCode, 403);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/c/approvals/${a.id}`, headers: H, payload: { state: "approved" } })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/api/c/approvals", headers: H, payload: { source: "orb-board", state: "pending", action: { itemIds: ["x"] } } })).statusCode, 403);
    assert.ok(!m.hits.some(h => h.method === "DELETE"));

    // You approve: both cards go, as Hermes approved by you.
    const ok = (await app.inject({ method: "POST", url: `/api/ideas/approvals/${a.id}/decide`, headers: me, payload: { decision: "approve" } })).json();
    assert.equal(ok.decision, "approved");
    assert.deepEqual(m.hits.filter(h => h.method === "DELETE").map(h => [h.url, h.agent]), [["/api/item/i_a", "Hermes, approved by you"], ["/api/item/i_c", "Hermes, approved by you"]]);
    assert.equal((records.get("approvals", a.id) as any).state, "approved");
    assert.equal((await app.inject({ method: "POST", url: `/api/ideas/approvals/${a.id}/decide`, headers: me, payload: { decision: "reject" } })).json().changed, false);

    // A whole board, rejected through the Agents page's route: nothing removed.
    const whole = await call("orb_board_remove", { board: "Garage" });
    assert.match((records.get("approvals", whole.approval) as any).title, /Delete the board "Garage"/);
    const no = (await app.inject({ method: "POST", url: `/api/hermes/approvals/${whole.approval}/decide`, headers: me, payload: { decision: "reject" } })).json();
    assert.equal(no.decision, "rejected");
    assert.equal(m.hits.filter(h => h.method === "DELETE").length, 2);
    assert.equal((await app.inject({ method: "POST", url: `/api/ideas/approvals/${whole.approval}/decide`, headers: me, payload: { decision: "maybe" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/ideas/approvals/nope/decide", headers: me, payload: { decision: "approve" } })).statusCode, 404);

    // A card that is already gone is fine; Home can't be removed.
    records.put("approvals", "board-x", { source: "orb-board", state: "pending", title: "t", agent: "Ekko", action: { itemIds: ["gone"] } });
    assert.equal((await app.inject({ method: "POST", url: "/api/ideas/approvals/board-x/decide", headers: me, payload: { decision: "approve" } })).json().decision, "approved");
    m.set({ boardCard: null });
    await assert.rejects(call("orb_board_remove", { board: "Home" }), /Home can't be removed/);

    // The Ideas tab's activity strip
    const act = (await app.inject({ url: "/api/ideas/activity", headers: me })).json();
    assert.equal(act.configured, true); assert.equal(act.items[0].actor, "Hermes");
  } finally { m.close(); }
});

test("TestBoards_MilacloneDownIsSaidPlainly", async () => {
  const { app, raw, me } = await orb("http://127.0.0.1:1");
  const r = await raw("orb_board_find", {});
  assert.match(r.content[0].text, /Couldn't reach 127\.0\.0\.1:1/);
  const act = (await app.inject({ url: "/api/ideas/activity", headers: me })).json();
  assert.match(act.error, /Orb couldn't read Milaclone's activity/);
});
