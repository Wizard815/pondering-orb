import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { localDay } from "../src/dates.js";

const serve = (h: (req: any, res: any, body: string) => void) => new Promise<{ url: string; close: () => void }>(ok => {
  const s = createServer((req, res) => { let b = ""; req.on("data", c => (b += c)); req.on("end", () => h(req, res, b)); }).listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(s.address() as any).port}`, close: () => s.close() }));
});
const J = (res: any, o: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

test("TestHandwriting_ReadCorrectTrainAndWiki", async () => {
  const seen: any[] = [], wikiPuts: { path: string; body: string }[] = [];
  const fake = await serve((req, res, body) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/v1/chat/completions") { const b = JSON.parse(body); seen.push(b); const img = b.messages[1].content[1].image_url.url;
      assert.match(img, /^data:image\/png;base64,/); return J(res, { choices: [{ message: { content: "- [ ] Buy a UPS for the rack\n- Call Sam abuot backups" } }] }); }
    if (u.pathname.startsWith("/vault/")) {
      if (req.method === "GET") { res.writeHead(404); return res.end(); }
      if (req.method === "PUT") { wikiPuts.push({ path: decodeURIComponent(u.pathname), body }); res.writeHead(204); return res.end(); }
      res.writeHead(204); return res.end();
    }
    res.writeHead(404); res.end();
  });
  process.env.WK = "k";
  const dir = mkdtempSync(join(tmpdir(), "orb-hw-test-"));
  try {
    const cfg = { ...loadConfig("/nonexistent.yaml", {}), golem: { baseUrl: `${fake.url}/v1`, model: "vision-m", keyEnv: "", canWrite: false }, wiki: { baseUrl: fake.url, tokenEnv: "WK", vault: "/nonexistent" } };
    const { app, records, journal } = await buildApp({ password: "pw", tokens: "bot:tok", dataFile: join(dir, "orb.db"), config: cfg });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: "pw" } }), cookie = { orb_session: String(login.cookies.find((c: any) => c.name === "orb_session")?.value) };
    const up = (payload: Buffer, extra: any = {}) => app.inject({ method: "POST", url: "/api/handwriting", cookies: extra.bot ? undefined : cookie, headers: { "content-type": "image/png", ...(extra.bot ? { authorization: "Bearer tok" } : {}) }, payload });
    assert.equal((await up(PNG, { bot: true })).statusCode, 403, "agents can't add pages");
    assert.equal((await up(Buffer.from("<svg/>"))).statusCode, 415);
    const r = (await up(PNG)).json();
    assert.match(r.id, /^[a-f0-9]{32}$/); assert.match(r.text, /abuot/); assert.equal(r.model, "vision-m");
    // You fix "abuot"; the page and both texts are kept for training.
    const day = localDay();
    assert.equal((await app.inject({ method: "POST", url: `/api/handwriting/${r.id}/text`, cookies: cookie, payload: { text: "- [ ] Buy a UPS for the rack\n- Call Sam about backups", day } })).statusCode, 200);
    const m = (await readFile(join(dir, "handwriting", "manifest.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l));
    assert.equal(m.length, 1); assert.equal(m[0].image, `${r.id}.png`); assert.match(m[0].ocr, /abuot/); assert.match(m[0].text, /about/); assert.equal(m[0].day, day);
    const st = (await app.inject({ method: "GET", url: "/api/handwriting/stats", cookies: cookie })).json();
    assert.deepEqual([st.samples, st.corrected, st.hints], [1, 1, ["about"]]);
    // The next page is read with the words you corrected as hints.
    await up(PNG); assert.match(seen.at(-1).messages[1].content[0].text, /often uses: about/);
    assert.equal((await app.inject({ method: "POST", url: "/api/handwriting/../../etc/text", cookies: cookie, payload: { text: "x" } })).statusCode, 404);

    // The day's journal goes to the wiki: on demand, and once a night when turned on.
    records.create("journal", { date: day, text: "## Handwritten\n- Call Sam about backups" }, day);
    const w = (await app.inject({ method: "POST", url: `/api/journal/${day}/wiki`, cookies: cookie })).json();
    assert.equal(w.path, `wiki/journal/Journal - ${day}.md`);
    const put = wikiPuts.find(p => p.path.endsWith(`Journal - ${day}.md`))!;
    assert.match(put.body, /^---\ntitle: "Journal - /); assert.match(put.body, /type: log\ntags: \[wiki, log\]/); assert.match(put.body, /Call Sam about backups/);
    assert.equal((await app.inject({ method: "POST", url: `/api/journal/${day}/wiki`, headers: { authorization: "Bearer tok" } })).statusCode, 403);
    const y = localDay(Date.now() - 864e5);
    await app.inject({ method: "PUT", url: "/api/c/settings/app", cookies: cookie, payload: { journal: { wiki: true } } });
    const before = wikiPuts.filter(p => p.path.includes(`Journal - ${y}`)).length;
    await journal.tick(); await journal.tick();
    assert.equal(wikiPuts.filter(p => p.path.includes(`Journal - ${y}`)).length - before, 1, "yesterday goes to the wiki once");
    await app.close();
  } finally { fake.close(); delete process.env.WK; }
});
