import { call, trimSlash } from "./http.js";
import { secret } from "../config.js";
import { HttpError } from "../records.js";

/** ntfy (https://ntfy.sh, self-hosted): push notifications to a phone.
 *  Orb sends only what it already alerts on (a service down in Uptime Kuma, a
 *  write stuck in the outbox, the morning brief being ready), to one topic.
 *  Protect the topic in ntfy (one per person) and give Orb an access token
 *  with write access to it, in the variable named by tokenEnv.
 *  Bodies are short and scrubbed: never a key, a password or a money amount. */
export type NtfyCfg = { url: string; topic: string; tokenEnv: string; events?: string };
export type NtfyEvent = "uptime" | "outbox" | "brief" | "test";
export const NTFY_EVENTS: NtfyEvent[] = ["uptime", "outbox", "brief"];
const TOPIC = /^[-_A-Za-z0-9]{1,64}$/;

/** Which kinds of notification are on (all of them when the list is empty). */
export function ntfyEvents(c: NtfyCfg): Set<string> {
  const on = String(c.events || "").split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  return new Set(on.length ? on : NTFY_EVENTS);
}
export const ntfyReady = (c: NtfyCfg) => !!(trimSlash(c.url) && TOPIC.test(c.topic || ""));

const SECRETISH = /(KEY|TOKEN|PASSWORD|PASS|SECRET)$/;
/** Takes out anything that could be a secret or a money amount. */
export function scrub(text: string, max = 300): string {
  let t = String(text || "");
  // Values of secret-looking environment variables, wherever they appear.
  for (const [k, v] of Object.entries(process.env)) if (v && v.length >= 6 && SECRETISH.test(k)) t = t.split(v).join("[hidden]");
  t = t
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1")                       // user:pass@ in a URL
    .replace(/(https?:\/\/[^\s?]+)\?\S*/gi, "$1")                     // query strings (apikey=...)
    .replace(/\b(api[_-]?key|apikey|token|password|passwd|secret|authorization)\s*[=:]\s*\S+/gi, "$1 [hidden]")
    .replace(/\bbearer\s+\S+/gi, "Bearer [hidden]")
    .replace(/\b[A-Za-z0-9_\-+/=]{32,}\b/g, "[hidden]")               // long opaque strings
    .replace(/[-−]?\s?[$€£¥₹]\s?\d[\d,.]*(?:\s?[kKmM]\b)?/g, "[amount]")
    .replace(/\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|CAD|AUD|JPY|CHF|dollars?|euros?|pounds?)\b/gi, "[amount]")
    .replace(/\b(?:USD|EUR|GBP|CAD|AUD|JPY|CHF)\s?\d[\d,]*(?:\.\d+)?/g, "[amount]")
    .replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

export type Note = { title: string; message: string; tags?: string[]; priority?: 1 | 2 | 3 | 4 | 5 };

/** Publish one message. Throws an HttpError in plain words when ntfy says no. */
export async function ntfySend(c: NtfyCfg, n: Note) {
  const base = trimSlash(c.url);
  if (!base) throw new HttpError(400, "Set ntfy's address first (e.g. http://192.168.20.5:8091).");
  if (!TOPIC.test(c.topic || "")) throw new HttpError(400, "Set an ntfy topic: letters, numbers, - and _ only (e.g. orb-wizard).");
  const token = secret(c.tokenEnv);
  const r = await call(base, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ topic: c.topic, title: scrub(n.title, 80), message: scrub(n.message), tags: n.tags || [], priority: n.priority || 3 }) });
  if (r.status === 401 || r.status === 403) throw new HttpError(502, token
    ? `ntfy refused the token in ${c.tokenEnv} for topic "${c.topic}". Check the token, and that its user may write to that topic (ntfy access ${c.topic} rw).`
    : `ntfy wants a token for topic "${c.topic}". Make one (ntfy token add) and put it in ${c.tokenEnv || "a variable named in tokenEnv"}.`);
  if (r.status === 429) throw new HttpError(502, "ntfy is limiting how fast Orb sends. Try again in a minute.");
  if (!r.ok) throw new HttpError(502, `ntfy answered ${r.status}${r.body?.error ? `: ${String(r.body.error).slice(0, 200)}` : ""}.`);
  return { ok: true };
}
