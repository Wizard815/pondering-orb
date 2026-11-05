import { call, trimSlash } from "./http.js";
import { HttpError } from "../records.js";

export type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: any[]; tool_call_id?: string };
export type Tool = { name: string; description: string; parameters: Record<string, unknown>; run: (args: any, who: string) => Promise<unknown> | unknown; write?: boolean };

/** One OpenAI-compatible chat API covers Golem's brains: Argos or any local
 *  /v1 server, OpenRouter, and the Claude API's OpenAI-compatible endpoint.
 *  Runs the tool loop here, so tools act with Orb's own rules. */
export async function chat(opts: { baseUrl: string; model: string; key?: string; messages: Msg[]; tools: Tool[]; who: string; maxRounds?: number }) {
  const base = trimSlash(opts.baseUrl);
  if (!base) throw new HttpError(503, "Golem has no model endpoint. Set one in Settings → Golem.");
  const msgs = [...opts.messages], did: string[] = [];
  const tools = opts.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  for (let round = 0; round < (opts.maxRounds ?? 6); round++) {
    const r = await call(`${base}/chat/completions`, {
      method: "POST", timeoutMs: 180000,
      headers: { "Content-Type": "application/json", ...(opts.key ? { Authorization: `Bearer ${opts.key}` } : {}) },
      body: JSON.stringify({ model: opts.model || undefined, messages: msgs, tools: tools.length ? tools : undefined }),
    });
    if (!r.ok) throw new HttpError(502, `The model answered ${r.status}: ${typeof r.body === "string" ? r.body.slice(0, 200) : r.body?.error?.message || "error"}`);
    const m = r.body?.choices?.[0]?.message;
    if (!m) throw new HttpError(502, "The model sent an empty reply.");
    const calls = m.tool_calls || [];
    if (!calls.length) return { text: String(m.content || "").trim(), did };
    msgs.push({ role: "assistant", content: m.content ?? null, tool_calls: calls });
    for (const c of calls) {
      const t = opts.tools.find(x => x.name === c.function?.name);
      let out: unknown;
      try { const args = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; out = t ? await t.run(args, opts.who) : { error: "unknown tool" }; if (t?.write) did.push(t.name); }
      catch (e: any) { out = { error: e?.message || String(e) }; }
      msgs.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(out).slice(0, 30000) });
    }
  }
  return { text: "I ran out of steps before finishing. Try a narrower question.", did };
}
