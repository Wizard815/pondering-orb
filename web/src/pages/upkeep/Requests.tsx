import { useState } from "react";
import { post } from "../../lib/api";
import { useUi } from "../../lib/ui";
import { ago } from "../../lib/util";

export type UmRequest = {
  id: string; repo_id: string; repo_name: string; focus_branch?: string; type?: "merge" | "components" | "push" | "actions";
  upstreams?: any[]; components?: any[]; conflicts?: string[]; safe?: boolean; status: string;
  created_at?: string; decided_at?: string; comment?: string | null;
};

const reqType = (r: UmRequest) => r.type === "actions" ? "Actions change" : r.type === "push" ? "Push / pull request" : r.type === "components" ? "Component update" : "Merge from upstream";
const reqItems = (r: UmRequest): any[] => (r.type === "components" ? r.components || r.upstreams || [] : r.upstreams || []);

function Line({ r, u, pick }: { r: UmRequest; u: any; pick?: { on: boolean; set: (b: boolean) => void } }) {
  const comp = r.type === "components";
  return <label className="small req-item">
    {pick && <input type="checkbox" checked={pick.on} onChange={e => pick.set(e.target.checked)} aria-label={"Include " + u.name} />}
    <span>{u.behind != null && <>↓ {u.behind} </>}{comp ? "in" : "from"} <span className="mono">{u.name}{comp ? "" : "/" + (u.branch || r.focus_branch || "")}</span>
      {u.ahead ? ` · ${u.ahead} of yours` : ""}{u.reason ? ` · ${u.reason}` : ""}</span>
  </label>;
}

function Request({ r, base, github, onDone }: { r: UmRequest; base: string; github?: string; onDone: () => void }) {
  const ui = useUi(), items = reqItems(r), pending = r.status === "pending", many = pending && items.length > 1;
  const [off, setOff] = useState<Set<string>>(new Set()), [comment, setComment] = useState(""), [busy, setBusy] = useState(false);
  const decide = async (d: "approve" | "deny") => {
    const picked = items.map(u => u.name).filter(n => !off.has(n));
    if (d === "approve" && many && !picked.length) { ui.status("Tick at least one item to approve, or press Deny all."); return; }
    const body: Record<string, unknown> = { decision: d, comment: comment.trim() || null };
    if (d === "approve" && many && picked.length < items.length) body.only = picked;
    setBusy(true);
    try {
      const res = await post(`/api/upstream/request/${encodeURIComponent(r.id)}/decide`, body);
      if (res && res.ok === false) ui.error(res.error || "UpstreamManager refused the decision.");
      else ui.status(d === "deny" ? `Denied ${r.repo_name}.` : body.only ? `Approved ${picked.join(", ")} for ${r.repo_name}.` : `Approved ${r.repo_name}.`);
    } catch (e) { ui.error(e); } finally { setBusy(false); onDone(); }
  };
  const pill = pending ? (r.safe ? "ok" : "warn") : r.status === "approved" ? "ok" : r.status === "failed" ? "bad" : "";
  return <div className={"req " + r.status}>
    <div className="row" style={{ justifyContent: "space-between" }}><b>{r.repo_name}</b><span className="small mono muted">{r.focus_branch || ""}</span></div>
    <div className="row small"><span className={"pill " + pill}><i />{pending ? (r.safe ? "safe to merge" : "has conflicts") : r.status}</span><span className="muted">{reqType(r)} · {ago(r.created_at)}</span></div>
    {pending ? <form className="req-form" onSubmit={e => { e.preventDefault(); const sub = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null; decide(sub?.value === "deny" ? "deny" : "approve"); }}>
      {items.map((u, k) => <Line key={u.name + k} r={r} u={u} pick={many ? { on: !off.has(u.name), set: b => { const n = new Set(off); b ? n.delete(u.name) : n.add(u.name); setOff(n); } } : undefined} />)}
      {many && <div className="hint">Untick anything you don't want; the rest is approved on its own.</div>}
      {(r.conflicts || []).length > 0 && <div className="small st-blocked">Conflicts: {r.conflicts!.join(", ")}</div>}
      <div className="row"><input type="text" value={comment} onChange={e => setComment(e.target.value)} placeholder="Comment (optional)" aria-label="Comment" style={{ flex: "1 1 160px" }} />
        <button className="btn primary" type="submit" value="approve" disabled={busy}>{many ? "Approve ticked" : "Approve"}</button>
        <button className="btn" type="submit" value="deny" disabled={busy}>Deny{many ? " all" : ""}</button></div>
    </form> : <>
      {items.map((u, k) => <Line key={u.name + k} r={r} u={u} />)}
      <div className="hint">{r.decided_at ? ago(r.decided_at) : ""}{r.comment ? ` · “${r.comment}”` : ""}</div>
    </>}
    <div className="row small req-links">
      {base && <a href={base + "/requests"} target="_blank" rel="noopener">Open in UpstreamManager</a>}
      {github && <a href={`https://github.com/${github}/pulls`} target="_blank" rel="noopener">Pull requests on GitHub</a>}
    </div>
  </div>;
}

/** Pending requests first, then the last six decided. */
export function Requests({ list, error, base, repos, onDone }: { list: UmRequest[] | null; error: string; base: string; repos: any[]; onDone: () => void }) {
  if (error && !list) return <div className="empty">{error}</div>;
  if (!list) return <div className="empty">Loading…</div>;
  const pend = list.filter(r => r.status === "pending");
  const done = list.filter(r => r.status !== "pending").sort((a, b) => String(b.decided_at || "").localeCompare(String(a.decided_at || ""))).slice(0, 6);
  const gh = (r: UmRequest) => repos.find(x => x.id === r.repo_id)?.github;
  return <>
    {error && <div className="err-inline">{error}</div>}
    {pend.length ? pend.map(r => <Request key={r.id + r.status} r={r} base={base} github={gh(r)} onDone={onDone} />) : <div className="empty">No requests waiting.</div>}
    {done.length > 0 && <><h4 className="group-name">Decided</h4>{done.map(r => <Request key={r.id + r.status} r={r} base={base} github={gh(r)} onDone={onDone} />)}</>}
  </>;
}
