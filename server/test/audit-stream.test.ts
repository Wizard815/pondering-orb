import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { fake, wait } from "./support/fakes.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
const cfg = (over: any = {}) => ({ ...loadConfig("/nonexistent.yaml", {}), ...over });

test("TestAudit_SSE_ListenerRemovedOnDisconnect", async () => {
  const { app, records } = await buildApp({ config: cfg() });
  await app.listen({ port: 8198, host: "127.0.0.1" });
  try {
    const base = records.listenerCount("change");
    const req = request({ host: "127.0.0.1", port: 8198, path: "/api/stream" }); req.end();
    await new Promise<void>(r => req.on("response", () => r()));
    await wait(50); assert.equal(records.listenerCount("change"), base + 1);
    req.destroy(); await wait(150);
    assert.equal(records.listenerCount("change"), base, "SSE listener leaked after client disconnect");
    records.create("logs", { text: "after disconnect" }); // must not throw
  } finally { await app.close(); }
});

test("TestAudit_GolemStream_WorksAndAbortsUpstreamOnDisconnect", async () => {
  let upstreamClosed = false; const errors: string[] = [];
  const model = await fake((req, _b, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let i = 0; const t = setInterval(() => { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "w" + i } }] })}\n\n`); if (++i > 40) { clearInterval(t); res.end("data: [DONE]\n\n"); } }, 50);
    res.on("close", () => { clearInterval(t); upstreamClosed = true; });
  });
  const { app } = await buildApp({ config: cfg({ golem: { ...cfg().golem, baseUrl: model.url } }), logger: false });
  app.addHook("onError", async (_q, _r, e) => { errors.push(e.message); });
  await app.listen({ port: 8197, host: "127.0.0.1" });
  try {
    let got = "";
    const req = request({ host: "127.0.0.1", port: 8197, path: "/api/golem/stream", method: "POST", headers: { "content-type": "application/json" } });
    req.end(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));
    await new Promise<void>(r => req.on("response", res => { res.on("data", d => (got += d)); r(); }));
    await wait(400);
    assert.match(got, /event: text/, `no text streamed: ${JSON.stringify(got)}`);
    req.destroy(); await wait(300);
    assert.ok(upstreamClosed, "model request kept running after the browser went away");
  } finally { await app.close(); model.server.close(); }
});

test("TestAudit_GolemStream_FastifyComplainsAfterRawEnd", async () => {
  const model = await fake((_q, _b, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "hello" } }] })); });
  const logs: string[] = [];
  const { app } = await buildApp({ config: cfg({ golem: { ...cfg().golem, baseUrl: model.url } }) });
  (app.log as any).error = (...a: any[]) => logs.push(JSON.stringify(a).slice(0, 200));
  (app.log as any).warn = (...a: any[]) => logs.push(JSON.stringify(a).slice(0, 200));
  try {
    const r = await app.inject({ method: "POST", url: "/api/golem/stream", payload: { messages: [{ role: "user", content: "hi" }] } });
    console.log("status", r.statusCode, JSON.stringify(r.body).slice(0, 200), logs);
  } finally { model.server.close(); }
});
