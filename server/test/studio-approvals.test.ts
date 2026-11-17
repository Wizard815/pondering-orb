import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

/** Hermes Studio opens approval alerts here and clears them; the Orb decides them in Studio. */
async function orb(over: any = {}) {
  const base = loadConfig("/nonexistent.yaml", {});
  const { app, records } = await buildApp({ config: { ...base, ...over }, tokens: "studio:t" });
  const H = { authorization: "Bearer t" };
  const call = async (name: string, args: any) => {
    const r = (await app.inject({ method: "POST", url: "/mcp", headers: H, payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } })).json().result;
    if (r.isError) throw new Error(r.content[0].text);
    return JSON.parse(r.content[0].text);
  };
  return { app, records, call, H };
}

test("TestStudioApproval_OpenThenClearIsIdempotent", async () => {
  const { records, call } = await orb();
  await call("orb_studio_approval", { workId: "w1", title: "Rotate keys", summary: "Done, check it", state: "pending", vikunjaTaskId: "42" });
  assert.equal((records.get("approvals", "studio-w1") as any).state, "pending");
  assert.equal((await call("orb_studio_approval", { workId: "w1", state: "pending" })).unchanged, true);
  await call("orb_studio_approval", { workId: "w1", state: "approved", via: "mattermost", by: "wizard" });
  const a: any = records.get("approvals", "studio-w1");
  assert.equal(a.state, "approved"); assert.equal(a.via, "mattermost"); assert.equal(a.title, "Rotate keys"); assert.ok(a.resolvedAt > 0);
  // A late "pending" never reopens a decided approval.
  assert.equal((await call("orb_studio_approval", { workId: "w1", state: "pending" })).state, "approved");
  await assert.rejects(call("orb_studio_approval", { workId: "w1", state: "maybe" }), /state must be one of/);
});

test("TestStudioActivity_StoredOnceEach", async () => {
  const { records, call } = await orb();
  await call("orb_studio_activity", { id: "7", workId: "w1", title: "Rotate keys", kind: "status", status: "blocked", message: "needs the password", at: 5 });
  assert.equal((await call("orb_studio_activity", { id: "7", workId: "w1", kind: "status" })).unchanged, true);
  assert.equal(records.list("agentActivity").length, 1);
});

test("TestStudioApproval_DecideInStudioClearsTheAlert", async () => {
  const hits: any[] = [];
  let decided = false;
  const s = createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    hits.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
    const J = (o: unknown, c = 200) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/api/auth/login") return J({ token: "jwt" });
    if (req.url === "/api/studio/agent-work/w1/approve") {
      const first = !decided; decided = true;
      return J({ changed: first, message: first ? "Approved." : "Already approved in Pondering Orb.", work: { decision: "approved", decidedVia: "orb", decidedBy: "studio", status: "done" } });
    }
    return J({ error: "no" }, 404);
  });
  await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(s.address() as any).port}`;
  process.env.T_STUDIO_USER = "u"; process.env.T_STUDIO_PASS = "p";
  try {
    const base = loadConfig("/nonexistent.yaml", {});
    const { app, records, call, H } = await orb({ hermes: { ...base.hermes, baseUrl: url, userEnv: "T_STUDIO_USER", passwordEnv: "T_STUDIO_PASS" } });
    await call("orb_studio_approval", { workId: "w1", title: "Rotate keys", state: "pending" });
    const r1 = (await app.inject({ method: "POST", url: "/api/hermes/approvals/studio-w1/decide", headers: H, payload: { decision: "approve" } })).json();
    assert.equal(r1.changed, true);
    assert.equal((records.get("approvals", "studio-w1") as any).state, "approved");
    const r2 = (await app.inject({ method: "POST", url: "/api/hermes/approvals/studio-w1/decide", headers: H, payload: { decision: "approve" } })).json();
    assert.equal(r2.changed, false);
    const decide = hits.find(h => h.url === "/api/studio/agent-work/w1/approve");
    assert.equal(decide.body.via, "orb");
  } finally { s.close(); }
});
