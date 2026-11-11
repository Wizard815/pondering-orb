import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Hermes } from "../src/integrations/hermes.js";

/** Orb's work goes through Hermes Studio's own API (/api/studio/orb/work), not herdr. */
test("TestStudioWork_ListAndSendThroughStudio", async () => {
  const hits: { method: string; url: string; body?: any }[] = [];
  const s = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    hits.push({ method: req.method!, url: req.url!, body });
    const J = (o: unknown, c = 200) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/api/auth/login") return J({ token: "jwt" });
    if (req.headers.authorization !== "Bearer jwt") return J({ error: "no" }, 401);
    if (req.url === "/api/studio/orb/work" && req.method === "GET") return J({ work: [
      { sessionId: "s1", title: "Fix flaky login test", agentId: "ekko-agent", status: "blocked", orb: { task: { title: "Fix flaky login test", list: "site" } }, updatedAt: 5 }] });
    if (req.url === "/api/studio/orb/work" && req.method === "POST") return J({ work: { sessionId: "s2", status: "idle" } });
    if (req.url === "/api/coding-agents") return J({ tools: [{ id: "claude-code", name: "Claude Code", installed: true }, { id: "codex", installed: false }, { id: "dsh", name: "DSH", installed: true }] });
    return J({ error: "nope" }, 404);
  });
  await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(s.address() as any).port}`;
  try {
    const studio = new Hermes(() => base, () => ({ user: "u", pass: "p" }));
    const agents = await studio.agents();
    assert.equal(agents.studioUrl, base);
    assert.deepEqual(agents.agents, [{ chatId: "s1", agent: "ekko-agent", status: "blocked", title: "Fix flaky login test", task: { title: "Fix flaky login test", list: "site" }, project: null, updatedAt: 5 }]);
    // Ekko and Hermes are Studio's own; coding agents only when installed and runnable for Orb.
    assert.deepEqual((await studio.agentKinds()).map(k => k.id), ["ekko-agent", "hermes", "claude-code"]);
    const out = await studio.launch({ agentId: "ekko-agent", title: "Ship the pricing page", prompt: "Plan it", orb: { project: "site" } });
    assert.deepEqual(out, { chatId: "s2" });
    const post = hits.find(h => h.method === "POST" && h.url === "/api/studio/orb/work");
    assert.deepEqual(post?.body, { agentId: "ekko-agent", title: "Ship the pricing page", prompt: "Plan it", orb: { project: "site" } });
    assert.ok(!hits.some(h => h.url.includes("herdr")), "nothing goes through herdr");
  } finally { s.close(); }
});
