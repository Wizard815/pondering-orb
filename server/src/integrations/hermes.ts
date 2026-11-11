import { call, trimSlash } from "./http.js";
import { HttpError } from "../records.js";

/** Hermes Studio: its chats and Hermes Agent's sessions (read only), and Orb's
 *  work in Studio: Studio chats working on Orb tasks and projects, and a way to
 *  hand a plan to a new one (Ekko, Hermes or a coding agent). Everything goes
 *  through Studio's own API. Signs in with a user and password from the
 *  environment and keeps the JWT. */
export type OrbRef = { task?: { title: string; list: string }; project?: string };

export class Hermes {
  private token = ""; private tokenFor = ""; private at = 0;
  constructor(private base: () => string, private creds: () => { user: string; pass: string }, private publicBase: () => string = () => "") {}
  private async login() {
    const b = trimSlash(this.base()); if (!b) throw new HttpError(503, "Hermes Studio isn't set up. Add its address in Settings → Connections.");
    const { user, pass } = this.creds();
    const r = await call(`${b}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: user, password: pass }) });
    if (!r.ok || !r.body?.token) throw new HttpError(502, `Hermes Studio sign-in failed (${r.status}${r.body?.error ? ": " + r.body.error : ""}).`);
    this.token = r.body.token; this.at = Date.now(); this.tokenFor = b;
  }
  private async get(p: string): Promise<any> {
    // A token from one Hermes address is never sent to another.
    if (!this.token || this.tokenFor !== trimSlash(this.base()) || Date.now() - this.at > 6 * 3600e3) await this.login();
    let r = await call(trimSlash(this.base()) + p, { headers: { Authorization: `Bearer ${this.token}` } });
    if (r.status === 401) { await this.login(); r = await call(trimSlash(this.base()) + p, { headers: { Authorization: `Bearer ${this.token}` } }); }
    if (!r.ok) throw new HttpError(502, `Hermes Studio answered ${r.status}.`);
    return r.body;
  }
  private async send(method: "POST", p: string, body: unknown, timeoutMs?: number): Promise<any> {
    if (!this.token || this.tokenFor !== trimSlash(this.base()) || Date.now() - this.at > 6 * 3600e3) await this.login();
    const go = () => call(trimSlash(this.base()) + p, { method, headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), timeoutMs });
    let r = await go();
    if (r.status === 401) { await this.login(); r = await go(); }
    if (!r.ok) throw new HttpError(r.status === 409 || r.status === 400 ? r.status : 502, r.body?.error || `Hermes Studio answered ${r.status}.`);
    return r.body;
  }
  /** Studio chats working on Orb tasks and projects, with the state Studio follows. */
  async agents() {
    const r = await this.get("/api/studio/orb/work");
    const agents = (r?.work || []).map((w: any) => ({
      chatId: String(w.sessionId), agent: String(w.agentId || ""), status: String(w.status || "idle"), title: String(w.title || ""),
      task: w.orb?.task ? { title: String(w.orb.task.title || ""), list: String(w.orb.task.list || "") } : null,
      project: w.orb?.project ? String(w.orb.project) : null, updatedAt: Number(w.updatedAt) || 0 }));
    return { connected: true, studioUrl: trimSlash(this.publicBase() || this.base()), agents };
  }
  /** Agents Studio can run for Orb: its own Ekko and Hermes, and the coding agents it has installed. */
  async agentKinds() {
    const r = await this.get("/api/coding-agents").catch(() => ({ tools: [] }));
    const coding = new Set(["claude-code", "codex", "pi", "grok", "opencode"]);
    return [{ id: "ekko-agent", name: "Ekko" }, { id: "hermes", name: "Hermes" },
      ...(r?.tools || []).filter((t: any) => t.installed && coding.has(t.id)).map((t: any) => ({ id: String(t.id), name: String(t.name || t.id) }))];
  }
  /** Start a new Studio chat with a plan or task as its first message. `orb`
   *  names the Orb task or project it is for: Studio reports how it goes
   *  (working, needs you, done) back to Orb (Studio needs this Orb connected). */
  async launch(input: { agentId: string; title: string; prompt: string; workspace?: string; orb?: OrbRef }) {
    const r = await this.send("POST", "/api/studio/orb/work", { agentId: input.agentId, title: input.title.slice(0, 80), prompt: input.prompt, ...(input.workspace ? { workspace: input.workspace } : {}), ...(input.orb ? { orb: input.orb } : {}) },
      // Studio answers once the chat's run is under way.
      60_000);
    return { chatId: String(r?.work?.sessionId || "") };
  }
  /** One chat's newest messages as plain text (for Golem, read only). */
  async session(id: string, limit = 20) {
    const r = await this.get(`/api/studio/sessions/${encodeURIComponent(id)}`);
    const s = r?.session || r || {};
    const msgs: any[] = s.messages || s.history || [];
    const text = (c: any): string => typeof c === "string" ? c : Array.isArray(c) ? c.map(p => (typeof p === "string" ? p : p?.text || "")).join(" ") : c?.text || "";
    return { id, title: s.title || "", messages: msgs.slice(-limit).map(m => ({ role: m.role || m.type || "", text: text(m.content ?? m.text).slice(0, 1500) })).filter(m => m.text) };
  }
  async sessions(q = "") {
    const [studio, agent] = await Promise.all([
      this.get(q ? `/api/studio/search/sessions?q=${encodeURIComponent(q)}` : "/api/studio/sessions?limit=100"), // an outage is an error, not "no chats"
      q ? Promise.resolve({ sessions: [] }) : this.get("/api/studio/sessions/hermes?limit=100").catch(() => ({ sessions: [] })),
    ]);
    const norm = (s: any, source: string) => ({ id: String(s.id), title: s.title || "", source: s.source === "hermes" || source === "hermes_agent" ? "hermes_agent" : "studio", agent: s.agent || "", model: s.model || "",
      messageCount: s.messageCount ?? s.message_count ?? 0, startedAt: s.startedAt ?? s.started_at ?? 0, lastActive: s.lastActive ?? s.updatedAt ?? s.endedAt ?? s.startedAt ?? 0 });
    const list = [...(studio.sessions || studio.results || []).map((s: any) => norm(s, "studio")), ...(agent.sessions || []).map((s: any) => norm(s, "hermes_agent"))];
    return [...new Map(list.map(s => [s.id, s])).values()].sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  }
}
