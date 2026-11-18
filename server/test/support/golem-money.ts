import { createServer, Server } from "node:http";
export { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
export { clearCoinpileCache, clearCoinpileMcp, cpMcpTools, cpSummary } from "../../src/integrations/coinpile.js";
export { clearFireflyCache } from "../../src/integrations/firefly.js";
import { localDay } from "../../src/dates.js";

export const cfg = (over: any = {}) => ({ ...loadConfig("/nonexistent.yaml", {}), ...over });
export const day = (k: number) => localDay(Date.now() + k * 864e5);
export type Hit = { method: string; url: string; auth?: string; host?: string; body: string; headers: Record<string, any> };
export function serve(h: (req: any, body: string, res: any) => void): Promise<{ url: string; server: Server; hits: Hit[]; close: () => void }> {
  return new Promise(r => {
    const hits: Hit[] = [];
    const server = createServer((req, res) => { let b = ""; req.on("data", d => (b += d)); req.on("end", () => { hits.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, host: req.headers.host, body: b, headers: req.headers }); h(req, b, res); }); })
      .listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${(server.address() as any).port}`, server, hits, close: () => { server.closeAllConnections?.(); server.close(); } }));
  });
}
export const J = (res: any, o: unknown, c = 200) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
export const appsYaml = (apps: string) => `groups:\n  - name: Money\n    apps:\n${apps}`;
export const cpApp = (url: string, extra = "", name = "Coinpile", keyEnv = "CP_ORB") => `      - name: ${name}\n        url: ${url}\n        widget: { type: coinpile, key_env: ${keyEnv}${extra} }\n`;
export const ffApp = (url: string, name = "Firefly III", keyEnv = "FF_TOKEN") => `      - name: ${name}\n        url: ${url}\n        widget: { type: firefly, key_env: ${keyEnv}, page: true }\n`;

/** A stand-in Coinpile MCP endpoint that behaves like the real one (src/coinpile/agent.py mcp_handle + web.py). */
export function mcpHandler(tools: any[], callTool: (name: string, args: any) => any, token = "cp_mcp") {
  return (req: any, body: string, res: any) => {
    if (req.url !== "/api/v1/mcp" || req.method !== "POST") return J(res, { detail: "Not Found" }, 404);
    if (req.headers.authorization !== `Bearer ${token}`) return J(res, { detail: "invalid token" }, 401);
    let m: any; try { m = JSON.parse(body); } catch { return J(res, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "not JSON" } }, 400); }
    if (m.id === undefined || m.id === null) { res.writeHead(202); return res.end(); }
    const ok = (result: unknown) => J(res, { jsonrpc: "2.0", id: m.id, result });
    const err = (code: number, message: string) => J(res, { jsonrpc: "2.0", id: m.id, error: { code, message } });
    if (m.method === "initialize") return ok({ protocolVersion: m.params?.protocolVersion, capabilities: { tools: {}, prompts: {} }, serverInfo: { name: "coinpile", version: "1" } });
    if (m.method === "tools/list") return ok({ tools });
    if (m.method === "tools/call") {
      const r = callTool(m.params?.name, m.params?.arguments);
      if (r && r.__rpcError) return err(r.code, r.message);
      return ok(r);
    }
    return err(-32601, `method ${m.method} is not supported`);
  };
}
/** A stand-in OpenAI-compatible model: `script(n, body)` returns either {tool_calls:[{name,args}]} or {content}. Records every request body. */
export async function fakeLlm(script: (n: number, body: any) => { tool_calls?: { name: string; args: any }[]; content?: string }) {
  const bodies: any[] = [];
  const s = await serve((_req, body, res) => {
    const b = JSON.parse(body); bodies.push(b); const out = script(bodies.length, b);
    const message: any = { role: "assistant", content: out.content ?? null };
    if (out.tool_calls) message.tool_calls = out.tool_calls.map((c, i) => ({ id: `c${bodies.length}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }));
    J(res, { choices: [{ message }] });
  });
  return { ...s, bodies };
}
