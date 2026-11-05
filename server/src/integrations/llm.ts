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

/** Like chat(), but streams the model's text as it arrives. Tool rounds run
 *  in between; onEvent gets {type:"text", delta} and {type:"tool", name}.
 *  Servers that ignore stream:true and answer with plain JSON still work. */
export async function chatStream(opts: Parameters<typeof chat>[0] & { onEvent: (e: { type: "text"; delta: string } | { type: "tool"; name: string }) => void; signal?: AbortSignal }) {
  const base = trimSlash(opts.baseUrl);
  if (!base) throw new HttpError(503, "Golem has no model endpoint. Set one in Settings → Golem.");
  const msgs = [...opts.messages], did: string[] = []; let full = "";
  const tools = opts.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  for (let round = 0; round < (opts.maxRounds ?? 6); round++) {
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, { method: "POST", signal: opts.signal,
        headers: { "Content-Type": "application/json", ...(opts.key ? { Authorization: `Bearer ${opts.key}` } : {}) },
        body: JSON.stringify({ model: opts.model || undefined, messages: msgs, tools: tools.length ? tools : undefined, stream: true }) });
    } catch (e: any) { throw new HttpError(502, `Couldn't reach the model (${e?.cause?.code || e?.message}).`); }
    if (!res.ok) throw new HttpError(502, `The model answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    let text = ""; const calls: { id: string; name: string; args: string }[] = [];
    if (!(res.headers.get("content-type") || "").includes("text/event-stream")) {
      const m = (await res.json())?.choices?.[0]?.message || {};
      text = m.content || ""; if (text) opts.onEvent({ type: "text", delta: text });
      for (const c of m.tool_calls || []) calls.push({ id: c.id, name: c.function?.name, args: c.function?.arguments || "" });
    } else {
      const reader = res.body!.getReader(), dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim(); if (data === "[DONE]") continue;
          let ev: any; try { ev = JSON.parse(data); } catch { continue; }
          const d = ev.choices?.[0]?.delta || {};
          if (d.content) { text += d.content; opts.onEvent({ type: "text", delta: d.content }); }
          for (const tc of d.tool_calls || []) { const k = tc.index ?? 0; calls[k] ??= { id: "", name: "", args: "" }; if (tc.id) calls[k].id = tc.id; if (tc.function?.name) calls[k].name += tc.function.name; if (tc.function?.arguments) calls[k].args += tc.function.arguments; }
        }
      }
    }
    full += text;
    const real = calls.filter(Boolean);
    if (!real.length) return { text: full.trim(), did };
    msgs.push({ role: "assistant", content: text || null, tool_calls: real.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })) });
    for (const c of real) {
      const t = opts.tools.find(x => x.name === c.name); opts.onEvent({ type: "tool", name: c.name });
      let out: unknown;
      try { out = t ? await t.run(c.args ? JSON.parse(c.args) : {}, opts.who) : { error: "unknown tool" }; if (t?.write) did.push(t.name); }
      catch (e: any) { out = { error: e?.message || String(e) }; }
      msgs.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(out).slice(0, 30000) });
    }
    if (text) { full += "\n\n"; opts.onEvent({ type: "text", delta: "\n\n" }); }
  }
  return { text: (full + "\n\nI ran out of steps before finishing.").trim(), did };
}
