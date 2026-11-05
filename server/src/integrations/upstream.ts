import { call, trimSlash } from "./http.js";
import { secret } from "../config.js";
import { HttpError } from "../records.js";

/** UpstreamManager's JSON API. It runs on another computer; every git action
 *  (fetch, merge, daily check) happens there, against its own clones. Orb only
 *  sends requests and shows the answers. Writes must be JSON, which is how
 *  UpstreamManager blocks cross-site requests. */
export class Upstream {
  constructor(private base: () => string, private headerEnv?: () => string | undefined) {}
  private url(p: string) {
    const b = trimSlash(this.base());
    if (!b) throw new HttpError(503, "UpstreamManager isn't set up. Add its address in Settings → Connections.");
    return b + p;
  }
  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["Content-Type"] = "application/json";
    const v = secret(this.headerEnv?.());
    if (v) h.Authorization = v;
    return h;
  }
  private async get(p: string) {
    const r = await call(this.url(p), { headers: this.headers() });
    if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, r.body?.error || `UpstreamManager answered ${r.status}.`);
    return r.body;
  }
  private async post(p: string, body: unknown = {}) {
    const r = await call(this.url(p), { method: "POST", headers: this.headers(true), body: JSON.stringify(body), timeoutMs: 120000 });
    if (!r.ok && r.status !== 409) throw new HttpError(502, r.body?.error || `UpstreamManager answered ${r.status}.`);
    return r.body;
  }
  repos() { return this.get("/api/repos"); }
  requests() { return this.get("/api/requests"); }
  publish(id: string) { return this.get(`/api/repo/${encodeURIComponent(id)}/publish`); }
  commits(id: string, limit = 30) { return this.get(`/api/repo/${encodeURIComponent(id)}/commits?view=all&limit=${limit}`); }
  fetchRepo(id: string) { return this.post(`/api/repo/${encodeURIComponent(id)}/fetch`); }
  runDaily() { return this.post("/api/run-daily"); }
  decide(reqId: string, decision: "approve" | "deny", comment?: string) {
    return this.post(`/api/request/${encodeURIComponent(reqId)}/decide`, { decision, comment: comment || null });
  }
  componentsRequest(repoId: string, names: string[]) {
    return this.post(`/api/repo/${encodeURIComponent(repoId)}/components/request`, { names });
  }
  /** Approve only some items of a request. Component requests can be split
   *  today (deny, re-raise for the chosen names, approve the new one). Merge
   *  requests need UpstreamManager to accept `only` first. */
  async approvePart(req: any, names: string[], comment?: string) {
    if (req.type === "components") {
      await this.decide(req.id, "deny", "Split in Pondering Orb: approving only part of this request");
      const raised = await this.componentsRequest(req.repo_id, names);
      if (!raised?.ok) throw new HttpError(409, raised?.error || "UpstreamManager didn't raise the smaller request.");
      return this.decide(raised.request.id, "approve", comment);
    }
    throw new HttpError(501, "Approving part of a merge request needs UpstreamManager to accept {\"only\": [...]} in /decide (see docs/backend.md).");
  }
}
