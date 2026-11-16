import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { notePath } from "../src/integrations/wiki.js";

const cfg = (over: any = {}) => ({ ...loadConfig("/nonexistent.yaml", {}), ...over });

/** The vault's /family endpoint as one person sees it: their own wiki/ and daily/ at the root, household/ shared. */
function fakeFamily() {
  const seen: any[] = [];
  const dirs: Record<string, string[]> = { "/family/vault/wiki/": ["1-projects/"], "/family/vault/wiki/1-projects/": ["Quilt.md"], "/family/vault/household/wiki/": ["1-projects/"], "/family/vault/household/wiki/1-projects/": ["NAS.md"] };
  const notes: Record<string, string> = { "/family/vault/household/wiki/1-projects/NAS.md": "---\ntitle: NAS\ntype: project\n---\n# NAS\n\n## Next steps\n- x\n" };
  const server = createServer((req, resp) => { let b = ""; req.on("data", d => (b += d)); req.on("end", () => {
    const u = decodeURIComponent(req.url!.split("?")[0]); seen.push({ m: req.method, u, h: req.headers, b });
    if (req.method === "GET" && dirs[u]) { resp.writeHead(200, { "Content-Type": "application/json" }); return resp.end(JSON.stringify({ files: dirs[u] })); }
    if (req.method === "GET" && notes[u]) { resp.writeHead(200, { "Content-Type": "text/markdown" }); return resp.end(notes[u]); }
    if (req.method === "GET") { resp.writeHead(404); return resp.end("{}"); }
    resp.writeHead(204); resp.end(); }); }).listen(0);
  return { server, seen };
}

test("TestWiki_FamilyModeUsesThePersonsViewNotTheMount", async () => {
  const { server, seen } = fakeFamily();
  await new Promise(r => server.once("listening", r));
  // A mounted vault holds everyone's notes; in family mode it must not be read.
  const vault = mkdtempSync(join(tmpdir(), "orb-vault-")); mkdirSync(join(vault, "wiki"));
  process.env.TEST_FAMILY_WIKI_TOKEN = "llmw_test";
  try {
    const url = `http://127.0.0.1:${(server.address() as any).port}/family`;
    const { app } = await buildApp({ config: cfg({ wiki: { baseUrl: url, tokenEnv: "TEST_FAMILY_WIKI_TOKEN", vault } }) });
    const tree = (await app.inject({ method: "GET", url: "/api/wiki/tree" })).json();
    assert.equal(tree.mount, false);
    assert.deepEqual(tree.notes.map((n: any) => n.path).sort(), ["household/wiki/1-projects/NAS.md", "wiki/1-projects/Quilt.md"]);
    assert.ok(seen.every(s => s.h.authorization === "Bearer llmw_test"), "every call carries the person's token");

    // Shared notes can be edited; the log goes to the person's own daily note.
    const r = await app.inject({ method: "POST", url: "/api/wiki/section", payload: { path: "household/wiki/1-projects/NAS.md", heading: "Next steps", text: "- y" } });
    assert.equal(r.statusCode, 200);
    assert.ok(seen.some(s => s.m === "PATCH" && s.u === "/family/vault/household/wiki/1-projects/NAS.md"));
    assert.match(seen.find(s => s.m === "PUT").u, /^\/family\/vault\/daily\/\d{4}-\d{2}-\d{2}\.md$/);
  } finally { server.close(); delete process.env.TEST_FAMILY_WIKI_TOKEN; }
});

test("TestWiki_NotePathAllowsHouseholdWikiOnly", () => {
  assert.equal(notePath("household/wiki/1-projects/A.md", true), "household/wiki/1-projects/A.md");
  assert.equal(notePath("wiki/1-projects/A.md", true), "wiki/1-projects/A.md");
  for (const bad of ["household/raw/sources/A.md", "household/daily/A.md", "people/sam/wiki/A.md", "raw/A.md"]) assert.throws(() => notePath(bad, true), /only edits/);
});
