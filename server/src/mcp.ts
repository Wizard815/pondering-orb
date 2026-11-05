import type { FastifyInstance } from "fastify";
import type { Tool } from "./integrations/llm.js";

/** POST /mcp: a stateless MCP server (JSON-RPC 2.0 over HTTP) with the same
 *  tools Golem uses. Agents authenticate with a bearer token from
 *  ORB_API_TOKENS; what they write is recorded under the token's name. */
export function mountMcp(app: FastifyInstance, tools: () => Tool[], guard: any, version: string) {
  app.post("/mcp", { preHandler: guard }, async (req, reply) => {
    const body: any = req.body;
    const handle = async (m: any) => {
      const id = m?.id ?? null, ok = (result: unknown) => ({ jsonrpc: "2.0", id, result }), err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
      switch (m?.method) {
        case "initialize": return ok({ protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pondering-orb", version } });
        case "notifications/initialized": return null;
        case "ping": return ok({});
        case "tools/list": return ok({ tools: tools().map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters })) });
        case "tools/call": {
          const t = tools().find(x => x.name === m.params?.name);
          if (!t) return err(-32602, `Unknown tool ${m.params?.name}`);
          try { const out = await t.run(m.params?.arguments || {}, (req as any).who); return ok({ content: [{ type: "text", text: JSON.stringify(out) }] }); }
          catch (e: any) { return ok({ content: [{ type: "text", text: e?.message || String(e) }], isError: true }); }
        }
        default: return m?.id === undefined ? null : err(-32601, `Method not found: ${m?.method}`);
      }
    };
    if (Array.isArray(body)) { const out = (await Promise.all(body.map(handle))).filter(Boolean); return out.length ? out : reply.code(202).send(); }
    const out = await handle(body);
    return out ?? reply.code(202).send();
  });
}
