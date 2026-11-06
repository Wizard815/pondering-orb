import { call } from "./http.js";
import { chat } from "./llm.js";
import { HttpError } from "../records.js";

/** The decision model answers typed questions about a JSON state: for each
 *  question, one choice from a fixed list, with probabilities and a
 *  confidence. "The model judges, code executes": it only picks; amounts,
 *  limits and the final say stay with code and with you.
 *
 *  Two kinds, both on your own servers:
 *  - "jev": a self-hosted service that speaks Jev's request format
 *    (POST {model, state, questions} -> {answers}), at the URL you give;
 *  - "openai": any OpenAI-compatible model (Argos, llama-server, Ollama),
 *    asked the same questions and made to answer as strict JSON. */
export const JEV = { model: "jev-latest" };
export type Question = { instructions: string; criteria: Record<string, string> };
export type Answer = { choice: string; probabilities: Record<string, number>; confidence: number };
export type Verdict = { answers: Record<string, Answer>; source: "jev" | "llm"; model: string; error?: string };

/** Probabilities from one confidence when a model only names its pick. */
const spread = (labels: string[], choice: string, conf: number) =>
  Object.fromEntries(labels.map(l => [l, +(l === choice ? conf : (1 - conf) / Math.max(1, labels.length - 1)).toFixed(4)]));

/** Off-menu or missing answers become the first option's opposite: the
 *  question's `fallback` (for example "skip" or "flat"), never a buy. */
function check(qs: Record<string, Question>, raw: Record<string, any>, fallback: Record<string, string>) {
  const out: Record<string, Answer> = {};
  for (const [id, q] of Object.entries(qs)) {
    const labels = Object.keys(q.criteria), a = raw?.[id];
    const choice = typeof a?.choice === "string" && labels.includes(a.choice) ? a.choice : fallback[id];
    const conf = Number.isFinite(+a?.confidence) ? Math.max(0, Math.min(1, +a.confidence)) : 0.34;
    const probs = a?.probabilities && labels.every(l => Number.isFinite(+a.probabilities[l])) ? Object.fromEntries(labels.map(l => [l, +a.probabilities[l]])) : spread(labels, choice, conf);
    out[id] = { choice, probabilities: probs, confidence: choice === a?.choice ? conf : 0 };
  }
  return out;
}

export async function askJev(url: string, key: string, state: unknown, qs: Record<string, Question>, fallback: Record<string, string>, model = JEV.model): Promise<Verdict> {
  const questions = Object.fromEntries(Object.entries(qs).map(([id, q]) => [id, { type: "choice", instructions: q.instructions, criteria: q.criteria }]));
  const r = await call(url, { method: "POST", timeoutMs: 60000, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json" }, body: JSON.stringify({ model: model || JEV.model, state, questions }) });
  if (!r.ok) throw new HttpError(502, `The decision model answered ${r.status}: ${typeof r.body === "string" ? r.body.slice(0, 160) : r.body?.error?.message || r.body?.error || ""}`);
  return { answers: check(qs, r.body?.answers || {}, fallback), source: "jev", model: r.body?.model || model };
}

export async function askLlm(golem: { baseUrl: string; model: string; key: string }, state: unknown, qs: Record<string, Question>, fallback: Record<string, string>): Promise<Verdict> {
  const menu = Object.entries(qs).map(([id, q]) => `Question "${id}": ${q.instructions}\n${Object.entries(q.criteria).map(([l, c]) => `- ${l}: ${c}`).join("\n")}`).join("\n\n");
  const shape = `{${Object.keys(qs).map(id => `"${id}":{"choice":"<one label>","confidence":0.0-1.0}`).join(",")}}`;
  const r = await chat({ ...golem, who: "market", tools: [], maxRounds: 1, messages: [
    { role: "system", content: "You are a careful decision model. Judge only from the state given; don't assume you know what happened after its as_of date. Pick exactly one label per question. Be honest about uncertainty: confidence near 0.34 means a guess. Answer with JSON only, no prose." },
    { role: "user", content: `State JSON:\n${JSON.stringify(state).slice(0, 20000)}\n\n${menu}\n\nRespond ONLY with JSON: ${shape}` }] });
  const m = /\{[\s\S]*\}/.exec(r.text); let raw: any = {};
  try { raw = m ? JSON.parse(m[0]) : {}; } catch { /* treated as off-menu */ }
  return { answers: check(qs, raw, fallback), source: "llm", model: golem.model || "golem" };
}
