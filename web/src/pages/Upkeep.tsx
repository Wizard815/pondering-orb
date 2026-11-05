import { useState } from "react";
import type { PageDef } from "./types";
import type { PanelDef } from "../components/PanelGrid";
import { create, useColl } from "../lib/store";
import { useUi } from "../lib/ui";
import { post } from "../lib/api";
import { useFetch } from "../lib/useFetch";
import { ago, choreState, clip } from "../lib/util";
import { ChoreRows, projHref, removeWithUndo } from "../components/Common";
import { Requests, UmRequest } from "./upkeep/Requests";
import { GlanceChores } from "../components/Glance";
import { baseOf, useOrbConfig } from "./upkeep/config";

type Daily = { ranAt: number; results: any[] };
// Kept for the session so switching tabs doesn't forget the last run.
let lastDaily: Daily | null = null;

function DailyCheck({ onDone }: { onDone: () => void }) {
  const ui = useUi(), [d, setD] = useState<Daily | null>(lastDaily), [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); ui.status("Running the daily check on UpstreamManager…");
    try {
      const res = await post("/api/upstream/run-daily");
      if (res && res.ok === false) throw new Error(res.error || "The daily check failed.");
      lastDaily = { ranAt: Date.now(), results: res?.results || [] }; setD(lastDaily);
      ui.status(`Daily check done: ${lastDaily.results.length} repo${lastDaily.results.length === 1 ? "" : "s"}.`);
    } catch (e) { ui.error(e); } finally { setBusy(false); onDone(); }
  };
  const line = (r: any) => r.status === "merged" ? <><span className="st-active">merged</span> {r.behind} commit{r.behind === 1 ? "" : "s"} from {r.upstream}</>
    : r.status === "request_raised" ? <><span className="st-paused">request raised</span> · {(r.reasons || []).join("; ")}</>
    : r.status === "error" ? <><span className="st-blocked">error</span> · {r.error}</>
    : <span className="muted">{String(r.status || "").replace(/_/g, " ")}</span>;
  return <>
    <div className="row" style={{ justifyContent: "space-between" }}><span className="small">{d ? `Last run ${ago(d.ranAt)}` : "Not run yet"}</span>
      <button className="btn primary" onClick={run} disabled={busy}>{busy ? "Running…" : "Run daily check"}</button></div>
    <p className="hint" style={{ margin: 0 }}>Fetches every watched repo. Fast-forwards happen by themselves; anything else raises a request here. Nothing is pushed.</p>
    {d && (d.results.length ? <ul className="list">{d.results.map((r, i) => <li key={(r.repo_id || "") + i}><div className="grow"><b>{r.repo_name || r.repo_id}</b> {line(r)}</div></li>)}</ul>
      : <div className="empty">No repos were checked.</div>)}
  </>;
}

function Repos({ repos, error, base, onDone }: { repos: any[] | null; error: string; base: string; onDone: () => void }) {
  const ui = useUi(), projects = useColl("projects"), [busy, setBusy] = useState("");
  if (error && !repos) return <div className="empty">{error}</div>;
  if (!repos) return <div className="empty">Loading…</div>;
  if (!repos.length) return <div className="empty">No repos yet. Add them in UpstreamManager.</div>;
  const fetchRepo = async (r: any) => {
    setBusy(r.id);
    try {
      const res = await post(`/api/upstream/repo/${encodeURIComponent(r.id)}/fetch`);
      if (res && res.ok === false) throw new Error(res.error || `Fetching ${r.name} failed.`);
      const plan = res?.plan || {}, ups: any[] = plan.upstreams || [];
      const parts = ups.map(u => `${u.name} ↓${u.behind ?? 0} ↑${u.ahead ?? 0}${u.conflict ? " (conflict)" : ""}`);
      ui.status(`Fetched ${r.name}: ${parts.length ? parts.join(", ") : "no upstreams"}. ${(plan.conflicts || []).length ? "Has conflicts: " + plan.conflicts.join(", ") + "." : plan.safe ? "Safe to merge." : ""}`.trim());
    } catch (e) { ui.error(e); } finally { setBusy(""); onDone(); }
  };
  return <>{error && <div className="err-inline">{error}</div>}<div style={{ overflowX: "auto" }}><table className="ctab rtab">
    <thead><tr><th>repo</th><th>branch</th><th>upstream</th><th>components</th><th>last commit</th><th>project</th><th></th></tr></thead>
    <tbody>{repos.map(r => {
      const comps: any[] = r.components || [], cb = comps.filter(c => c.behind > 0).length, linked = projects.filter(p => p.upstreamRepo === r.id);
      return <tr key={r.id}>
        <td><b>{base ? <a href={`${base}/repo/${encodeURIComponent(r.id)}`} target="_blank" rel="noopener">{r.name}</a> : r.name}</b>
          {r.dirty ? <> <span className="chip warn">{r.dirty} changed</span></> : null}{r.error ? <> <span className="chip bad" title={String(r.error)}>error</span></> : null}</td>
        <td className="mono">{r.focus_branch || ""}</td>
        <td>{r.behind ? <span className="st-paused">↓{r.behind}</span> : <span className="muted">up to date</span>}{r.ahead ? <> <span className="muted">↑{r.ahead}</span></> : null}
          {(r.conflicts || []).length ? <> <span className="chip bad">conflict</span></> : null}<div className="hint">{(r.upstreams || []).map((u: any) => (typeof u === "string" ? u : u?.name)).join(", ")}</div></td>
        <td>{comps.length ? (cb ? <span className="st-paused">{cb} of {comps.length} behind</span> : `${comps.length} pinned`) : <span className="muted">none</span>}</td>
        <td className="small">{r.last_commit ? <>{r.last_commit.subject}<div className="hint mono">{String(r.last_commit.sha || "").slice(0, 10)} · {ago(r.last_commit.date)}</div></> : null}</td>
        <td className="small">{linked.length ? linked.map((p, i) => <span key={p.id}>{i ? ", " : ""}<a href={projHref(p)}>{p.name}</a></span>) : <span className="muted">—</span>}</td>
        <td><button className="btn" onClick={() => fetchRepo(r)} disabled={busy === r.id}>{busy === r.id ? "Fetching…" : "Fetch"}</button></td>
      </tr>;
    })}</tbody></table></div></>;
}

function Chores() {
  const ui = useUi(), chores = useColl("chores"), [name, setName] = useState(""), [every, setEvery] = useState("7");
  // Same order ChoreRows uses, so a right-clicked row maps back to its chore.
  const sorted = chores.map(c => ({ c, s: choreState(c) })).sort((a, b) => a.s.due - b.s.due).map(x => x.c);
  const onContext = (e: React.MouseEvent) => {
    const row = (e.target as Element).closest(".uk"); if (!row) return;
    const i = [...(e.currentTarget.querySelectorAll(".uk"))].indexOf(row), c = sorted[i]; if (!c) return;
    e.preventDefault();
    ui.menu(e.clientX, e.clientY, [{ label: c.name, heading: true }, { label: "Delete chore", danger: true, run: () => removeWithUndo(ui, "chores", c.id, `Deleted ${c.name}.`).catch(ui.error) }]);
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault(); const n = name.trim(); if (!n) return;
    try { await create("chores", { name: n, everyDays: Number(every) || 7, lastDone: "" }); setName(""); ui.status(`Added ${n}.`); } catch (x) { ui.error(x); }
  };
  return <>
    <div className="chores-list" onContextMenu={onContext}><ChoreRows /></div>
    {chores.length > 0 && <div className="hint">Right-click a chore to delete it.</div>}
    <form className="row" onSubmit={add}>
      <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Chore (e.g. test a restore)" aria-label="Chore" required style={{ flex: "1 1 160px" }} />
      <select value={every} onChange={e => setEvery(e.target.value)} aria-label="How often"><option value="1">Daily</option><option value="7">Weekly</option><option value="30">Monthly</option><option value="90">Quarterly</option></select>
      <button className="btn primary" type="submit">Add chore</button>
    </form>
  </>;
}

const How = () => <ul className="small" style={{ margin: 0, paddingLeft: "1.1em", display: "flex", flexDirection: "column", gap: 4 }}>
  <li>Repos: <span className="mono">GET /api/repos</span> (behind, ahead, conflicts, components, last commit).</li>
  <li>Requests: <span className="mono">GET /api/requests</span>; Approve or Deny sends <span className="mono">POST /api/request/&lt;id&gt;/decide</span>. Approving part of a component request denies it and raises a smaller one.</li>
  <li>Daily check: <span className="mono">POST /api/run-daily</span>. Fetch: <span className="mono">POST /api/repo/&lt;id&gt;/fetch</span>.</li>
  <li>Project commits: <span className="mono">GET /api/repo/&lt;id&gt;/commits</span>.</li>
  <li>UpstreamManager runs on its own computer; Orb's server calls it for you, and every git action happens there.</li>
</ul>;

export const UpkeepPage: PageDef = {
  id: "upkeep", label: "Upkeep", title: "Wards", flavor: "UpstreamManager: repos, upstream syncs and approval requests, plus your chores.",
  usePanels: () => {
    const cfg = useOrbConfig(), base = baseOf(cfg?.upstream?.baseUrl);
    const repos = useFetch<any[]>("/api/upstream/repos", 120000);
    const reqs = useFetch<UmRequest[]>("/api/upstream/requests", 60000);
    const reload = () => { reqs.reload(); repos.reload(); };
    const live = !repos.error && !reqs.error, waiting = !repos.data && !repos.error;
    const extra = <>
      <span className={"pill " + (waiting ? "" : live ? "ok" : "bad")} title={repos.error || reqs.error || (base ? `Orb reads and acts on UpstreamManager through its API at ${base}` : "")}>
        <i />{waiting ? "Reaching UpstreamManager…" : live ? "Live from UpstreamManager" : clip(repos.error || reqs.error, 70)}</span>
      {base && <a className="btn" href={base} target="_blank" rel="noopener">Open UpstreamManager</a>}
      <a className="btn" href="#config">Connection settings</a>
    </>;
    const panels: PanelDef[] = [
      { key: "requests", title: "Approval requests", node: <Requests list={reqs.data} error={reqs.error} base={base} repos={repos.data || []} onDone={reload} />, w: 7, h: 10 },
      { key: "daily", title: "Daily check", node: <DailyCheck onDone={reload} />, w: 5, h: 10 },
      { key: "repos", title: "Repositories", node: <Repos repos={repos.data} error={repos.error} base={base} onDone={repos.reload} />, w: 12, h: 8 },
      { key: "chores", title: "Chores", node: <Chores />, w: 7, h: 8 },
      { key: "lastglance", title: "lastGLANCE chores", node: <GlanceChores />, w: 5, h: 8 },
      { key: "how", title: "How this connects", node: <How />, w: 5, h: 8 },
    ];
    return { panels, extra };
  },
};
