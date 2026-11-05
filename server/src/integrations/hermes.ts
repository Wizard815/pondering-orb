import { call, trimSlash } from "./http.js";
import { HttpError } from "../records.js";

/** Hermes Studio: its own chats and Hermes Agent's sessions, read only.
 *  Signs in with a user and password from the environment and keeps the JWT. */
export class Hermes {
  private token = ""; private at = 0;
  constructor(private base: () => string, private creds: () => { user: string; pass: string }) {}
  private async login() {
    const b = trimSlash(this.base()); if (!b) throw new HttpError(503, "Hermes Studio isn't set up. Add its address in Settings → Connections.");
    const { user, pass } = this.creds();
    const r = await call(`${b}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: user, password: pass }) });
    if (!r.ok || !r.body?.token) throw new HttpError(502, `Hermes Studio sign-in failed (${r.status}${r.body?.error ? ": " + r.body.error : ""}).`);
    this.token = r.body.token; this.at = Date.now();
  }
  private async get(p: string): Promise<any> {
    if (!this.token || Date.now() - this.at > 6 * 3600e3) await this.login();
    let r = await call(trimSlash(this.base()) + p, { headers: { Authorization: `Bearer ${this.token}` } });
    if (r.status === 401) { await this.login(); r = await call(trimSlash(this.base()) + p, { headers: { Authorization: `Bearer ${this.token}` } }); }
    if (!r.ok) throw new HttpError(502, `Hermes Studio answered ${r.status}.`);
    return r.body;
  }
  async sessions(q = "") {
    const [studio, agent] = await Promise.all([
      this.get(q ? `/api/studio/search/sessions?q=${encodeURIComponent(q)}` : "/api/studio/sessions?limit=100").catch(() => ({ sessions: [] })),
      q ? Promise.resolve({ sessions: [] }) : this.get("/api/studio/sessions/hermes?limit=100").catch(() => ({ sessions: [] })),
    ]);
    const norm = (s: any, source: string) => ({ id: String(s.id), title: s.title || "", source: s.source === "hermes" || source === "hermes_agent" ? "hermes_agent" : "studio", agent: s.agent || "", model: s.model || "",
      messageCount: s.messageCount ?? s.message_count ?? 0, startedAt: s.startedAt ?? s.started_at ?? 0, lastActive: s.lastActive ?? s.updatedAt ?? s.endedAt ?? s.startedAt ?? 0 });
    const list = [...(studio.sessions || studio.results || []).map((s: any) => norm(s, "studio")), ...(agent.sessions || []).map((s: any) => norm(s, "hermes_agent"))];
    return [...new Map(list.map(s => [s.id, s])).values()].sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  }
}
