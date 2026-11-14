import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { orbTools } from "../src/tools.js";

const cfg = (over: any = {}) => ({ ...loadConfig("/nonexistent.yaml", {}), ...over });
async function mcp() {
  const { app, records } = await buildApp({ config: cfg(), tokens: "agent:t" });
  const rpc = async (method: string, params?: any) => (await app.inject({ method: "POST", url: "/mcp", headers: { authorization: "Bearer t" }, payload: { jsonrpc: "2.0", id: 1, method, params } })).json();
  const call = async (name: string, args: any) => (await rpc("tools/call", { name, arguments: args })).result;
  const data = (res: any) => JSON.parse(res.content[0].text);
  return { app, records, rpc, call, data };
}

test("TestMcp_EveryParameterIsDescribed", async () => {
  const { rpc } = await mcp();
  const { tools } = (await rpc("tools/list")).result;
  const bare: string[] = [];
  const walk = (tool: string, props: any = {}) => {
    for (const [k, s] of Object.entries<any>(props)) { if (!s.description) bare.push(`${tool}.${k}`); if (s.properties) walk(`${tool}.${k}`, s.properties); }
  };
  for (const t of tools) { assert.ok(t.description.length > 30, `${t.name} needs a real description`); walk(t.name, t.inputSchema.properties); }
  assert.deepEqual(bare, [], "parameters without a description");
});

test("TestMcp_AnnotationsFollowWriteFlag", async () => {
  const { rpc } = await mcp();
  const { tools } = (await rpc("tools/list")).result;
  const by = (n: string) => tools.find((t: any) => t.name === n);
  assert.equal(by("orb_list_tasks").annotations.readOnlyHint, true);
  assert.equal(by("orb_complete_task").annotations.readOnlyHint, false);
  assert.equal(by("orb_complete_task").annotations.destructiveHint, false);
});

test("TestMcp_NegotiatesProtocolVersion", async () => {
  const { rpc } = await mcp();
  assert.equal((await rpc("initialize", { protocolVersion: "2025-06-18" })).result.protocolVersion, "2025-06-18");
  assert.equal((await rpc("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion, "2025-11-25");
  assert.ok((await rpc("initialize", {})).result.instructions);
});

test("TestMcp_AddTaskRejectsBadDueAndPriority", async () => {
  const { records, call } = await mcp();
  const bad = await call("orb_add_task", { title: "x", list: "Inbox", due: "tomorrow" });
  assert.equal(bad.isError, true); assert.match(bad.content[0].text, /YYYY-MM-DD/);
  assert.equal((await call("orb_add_task", { title: "x", list: "Inbox", due: "2026-02-30" })).isError, true, "not a real day");
  assert.equal((await call("orb_add_task", { title: "x", list: "Inbox", priority: "huge" })).isError, true);
  assert.equal(records.list("tasks").length, 0, "nothing created on a bad call");
});

test("TestMcp_ActsByIdWhenTitlesRepeat", async () => {
  const { records, call, data } = await mcp();
  records.create("tasks", { title: "Release notes", list: "Argos" });
  const inbox: any = records.create("tasks", { title: "Release notes", list: "Inbox" });
  const amb = await call("orb_complete_task", { title: "release notes" });
  assert.equal(amb.isError, true); assert.match(amb.content[0].text, /Argos, Inbox|Inbox, Argos/);
  assert.equal(data(await call("orb_complete_task", { id: inbox.id })).done, true);
  assert.equal((records.get("tasks", inbox.id) as any).done, true);
  assert.equal((await call("orb_complete_task", { id: inbox.id })).isError, true, "already done");
  assert.equal((await call("orb_complete_task", { id: "nope" })).isError, true);
});

test("TestMcp_ListTasksFiltersAndKnowsLists", async () => {
  const { records, call, data } = await mcp();
  records.create("tasks", { title: "Late", list: "Homelab", due: "2026-11-01" });
  records.create("tasks", { title: "Soon", list: "Homelab", due: "2026-12-01" });
  records.create("tasks", { title: "Whenever", list: "Homelab" });
  const all = data(await call("orb_list_tasks", {}));
  assert.deepEqual(all.tasks.map((t: any) => t.title), ["Late", "Soon", "Whenever"], "soonest due first, undated last");
  assert.ok(all.tasks[0].id); assert.equal(all.truncated, false);
  assert.deepEqual(data(await call("orb_list_tasks", { due_on_or_before: "2026-11-13" })).tasks.map((t: any) => t.title), ["Late"]);
  assert.equal(data(await call("orb_list_tasks", { limit: 1 })).truncated, true);
  const unknown = await call("orb_list_tasks", { list: "Homelob" });
  assert.equal(unknown.isError, true); assert.match(unknown.content[0].text, /Homelab/);
  assert.equal((await call("orb_list_tasks", { due_on_or_before: "soon" })).isError, true);
  const lists = data(await call("orb_list_lists", {}));
  assert.deepEqual(lists.map((l: any) => [l.name, l.openTasks]), [["Homelab", 3]]);
});

test("TestTools_AddTaskWarnsWhenListOnlyLivesInOrb", async () => {
  const { records } = await buildApp({ config: cfg() });
  const add = orbTools(records, () => ["Homelab"]).find(t => t.name === "orb_add_task")!;
  const synced: any = await add.run({ title: "a", list: "homelab" }, "you");
  assert.equal(synced.list, "Homelab", "matched the CalDAV list's own spelling");
  assert.equal(synced.note, undefined);
  const local: any = await add.run({ title: "b", list: "Scratch" }, "you");
  assert.match(local.note, /only lives in Orb/);
});
