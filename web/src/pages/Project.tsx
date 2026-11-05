import { useState } from "react";
import { EditButton } from "../components/EditButton";
import { PanelGrid, PanelDef } from "../components/PanelGrid";
import { QuickLog, Star, TaskRows, patchWithUndo, PrioSelect } from "../components/Common";
import { create, patch, useColl, useReady } from "../lib/store";
import { useUi } from "../lib/ui";
import { useFetch } from "../lib/useFetch";
import { post } from "../lib/api";
import { ago, listOf, logSorted, sortTasks, todayISO } from "../lib/util";
import { Commit, StatusSelect, projById, projectList, projectMenu, useRepos } from "./projects/shared";
import "./projects.css";

const byName = (by: string) => (by === "golem" ? "Golem" : by);

function Changes({ p }: { p: any }) {
  const logs = logSorted(useColl("logs").filter(l => l.project === p.name));
  return <>
    <QuickLog project={p.name} />
    {logs.length ? <ul className="list">{logs.slice(0, 40).map(l => <li key={l.id}><span className="date">{l.date}</span>
      <div className="grow">{l.text}{l.by && <span className="hint"> · {byName(l.by)}</span>}</div></li>)}</ul>
      : <div className="empty">No log entries yet.</div>}
  </>;
}

function Tasks({ p }: { p: any }) {
  const ui = useUi(), list = projectList(p);
  const tasks = sortTasks(useColl("tasks").filter(t => listOf(t) === list));
  const [title, setTitle] = useState(""), [due, setDue] = useState(""), [prio, setPrio] = useState("0");
  const [next, setNext] = useState<string | null>(null);
  const add = async (e: React.FormEvent) => {
    e.preventDefault(); const t = title.trim(); if (!t) return;
    try { await create("tasks", { title: t, list, due, done: false, priority: Number(prio) || 0 }); setTitle(""); setDue(""); setPrio("0"); } catch (x) { ui.error(x); }
  };
  const saveNext = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await patch("projects", p.id, { next: (next ?? p.next ?? "").trim(), updated: todayISO() }); setNext(null); ui.status("Next step saved."); } catch (x) { ui.error(x); }
  };
  return <>
    <div className="hint">List: <b>{list}</b></div>
    <TaskRows tasks={tasks} />
    <form className="row proj-form" onSubmit={add}>
      <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="New task" aria-label={"New task for " + p.name} required />
      <input type="date" value={due} onChange={e => setDue(e.target.value)} aria-label="Due date" />
      <PrioSelect value={Number(prio) || 0} onChange={v => setPrio(String(v))} />
      <button className="btn primary" type="submit">Add task</button>
    </form>
    <form className="row proj-form" onSubmit={saveNext}>
      <input type="text" value={next ?? p.next ?? ""} onChange={e => setNext(e.target.value)} placeholder="Next step" aria-label="Next step" />
      <button className="btn" type="submit">Save next step</button>
    </form>
  </>;
}

function Repository({ p }: { p: any }) {
  const ui = useUi();
  const { data, error, loading } = useRepos();
  const repos = Array.isArray(data) ? data : [];
  const r = p.upstreamRepo ? repos.find(x => x.id === p.upstreamRepo) : undefined;
  const cm = useFetch<{ ok?: boolean; items?: Commit[]; error?: string }>(p.upstreamRepo ? `/api/upstream/repo/${encodeURIComponent(p.upstreamRepo)}/commits?limit=10` : null);
  const [busy, setBusy] = useState(false);
  const link = (id: string) => {
    if (id === (p.upstreamRepo || "")) return;
    const up = { upstreamRepo: id, lastLoggedSha: "" }, name = repos.find(x => x.id === id)?.name || id;
    (p.upstreamRepo ? patchWithUndo(ui, "projects", p.id, up, id ? `Repo changed to ${name}.` : "Repo unlinked.") : patch("projects", p.id, up)).catch(ui.error);
  };
  const pick = <select value={p.upstreamRepo || ""} onChange={e => link(e.target.value)} aria-label={"UpstreamManager repo for " + p.name}>
    <option value="">{repos.length ? "Link a repo…" : loading ? "Loading repos…" : "No repos loaded"}</option>
    {p.upstreamRepo && !r && <option value={p.upstreamRepo}>{p.upstreamRepo}</option>}
    {repos.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
  </select>;
  if (error && !p.upstreamRepo) return <><div className="empty">{error}</div><p className="hint" style={{ margin: 0 }}>Link this project to a repo tracked by UpstreamManager once it is connected.</p></>;
  if (!p.upstreamRepo) return <><p className="small" style={{ margin: 0 }}>Link this project to a repo tracked by UpstreamManager to see its upstream status here and log new commits to the project.</p><div className="row">{pick}</div></>;

  const unlink = (e: React.MouseEvent) => {
    const name = r?.name || p.upstreamRepo;
    ui.confirm(e.currentTarget, <>Unlink <b>{name}</b> from {p.name}?{p.logCommits ? " New commits will stop being logged." : ""} Log entries already written stay.</>, "Unlink",
      () => patchWithUndo(ui, "projects", p.id, { upstreamRepo: "", logCommits: false, lastLoggedSha: "" }, `Unlinked ${name}.`));
  };
  const checkNow = async () => {
    if (!p.logCommits) { ui.status("Turn on “Log new commits to this project” first."); return; }
    const first = !p.lastLoggedSha; setBusy(true);
    try {
      const res = await post<{ logged: string[] }>("/api/upstream/poll");
      const mine = (res.logged || []).find(s => s.startsWith(p.name + ": "));
      const n = mine ? Number(mine.slice(p.name.length + 2)) || 0 : 0;
      ui.status(n ? `Logged ${n} new commit${n === 1 ? "" : "s"} to ${p.name}.` : first ? `No commits logged: the first check only remembers where ${r?.focus_branch || "the branch"} is. Commits after this one will be logged.` : `No new commits to log for ${p.name}.`);
      cm.reload();
    } catch (x) { ui.error(x); } finally { setBusy(false); }
  };
  const commits = cm.data?.items || [];
  const lastIdx = p.lastLoggedSha ? commits.findIndex(c => c.full === p.lastLoggedSha) : -2;
  const fresh = !p.logCommits || lastIdx === -2 ? 0 : lastIdx < 0 ? commits.length : lastIdx;
  return <>
    {error && <div className="empty">{error}</div>}
    <div className="row"><b>{r?.name || p.upstreamRepo}</b>{r && <span className="mono small">{r.focus_branch || ""}</span>}
      {r && (Number(r.behind) > 0 ? <span className="pill warn"><i />{r.behind} behind upstream</span> : <span className="pill ok"><i />up to date</span>)}
      {r && Number(r.ahead) > 0 && <span className="pill"><i />{r.ahead} ahead</span>}
      {r?.github && <span className="mono small muted">{r.github}</span>}</div>
    <h4 className="group-name">Recent commits</h4>
    {cm.error ? (cm.error !== error && <div className="empty">{cm.error}</div>) : commits.length ? <ul className="list">{commits.slice(0, 8).map((c, k) => <li key={c.full || c.sha}><span className="date mono">{c.sha}</span>
      <div className="grow">{c.subject}<div className="hint">{c.author} · {ago(c.date)}{k < fresh ? " · not logged yet" : ""}</div></div></li>)}</ul>
      : <div className="empty">{cm.loading ? "Loading commits…" : "No commits loaded."}</div>}
    <div className="setting"><div><div>Log new commits to this project</div><div className="d hint">Each new commit on {r?.focus_branch || "the focus branch"} becomes a log entry (its subject), marked “git”. Orb checks on its own every few minutes.</div></div>
      <input type="checkbox" checked={!!p.logCommits} onChange={e => patch("projects", p.id, { logCommits: e.target.checked }).catch(ui.error)} aria-label="Log new commits" /></div>
    <div className="row"><button className="btn" disabled={busy} onClick={checkNow}>{busy ? "Checking…" : "Check for new commits now"}</button>{pick}<button className="btn sm" title="Unlink this repo" onClick={unlink}>Unlink</button></div>
  </>;
}

/** Hermes Studio and Hermes Agent chats linked to this project (ids in p.chats). */
function Chats({ p }: { p: any }) {
  const ui = useUi(), [q, setQ] = useState(""), { data, error } = useFetch<any[]>(`/api/hermes/sessions`, 300000);
  const all = data || [], ids: string[] = p.chats || [], linked = all.filter(c => ids.includes(c.id));
  const rest = all.filter(c => !ids.includes(c.id) && (!q || String(c.title).toLowerCase().includes(q.toLowerCase()))).slice(0, 6);
  const row = (c: any, isLinked: boolean) => <li key={c.id}><div className="grow"><b>{c.title || "Untitled chat"}</b>
    <div className="hint">{c.source === "hermes_agent" ? "Hermes Agent" : c.agent && c.agent !== "hermes" ? c.agent : "Hermes Studio"}{c.model ? " · " + c.model : ""} · {c.messageCount} messages{c.lastActive ? " · " + ago(c.lastActive) : ""}</div></div>
    {isLinked ? <button className="btn sm" onClick={e => ui.confirm(e.currentTarget, <>Unlink <b>{c.title || "this chat"}</b> from {p.name}? The chat itself isn't touched.</>, "Unlink", () => patchWithUndo(ui, "projects", p.id, { chats: ids.filter(x => x !== c.id) }, "Chat unlinked."))}>Unlink</button>
      : <button className="btn" onClick={() => patch("projects", p.id, { chats: [...ids, c.id] }).catch(ui.error)}>Link</button>}</li>;
  if (error) return <div className="empty">{error}</div>;
  return <>{linked.length ? <ul className="list">{linked.map(c => row(c, true))}</ul> : <div className="empty">No chats linked yet.</div>}
    {ids.length > linked.length && <div className="hint">{ids.length - linked.length} linked chat{ids.length - linked.length > 1 ? "s" : ""} not found in Hermes Studio.</div>}
    <h4 className="group-name">Link a chat</h4>
    <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search chat titles" aria-label="Search chats" style={{ width: "100%" }} />
    {rest.length ? <ul className="list">{rest.map(c => row(c, false))}</ul> : <div className="empty small">{data ? "No other chats match." : "Loading chats…"}</div>}</>;
}

const noteTitle = (path: string) => path.split("/").pop()!.replace(/\.md$/, "");
/** The note's `related` links: shows them, and adds other projects' notes.
 *  Orb only adds links to notes that exist and never removes any. */
function Related({ p }: { p: any }) {
  const ui = useUi(), projects = useColl("projects"), [pick, setPick] = useState("");
  const { data, reload, error } = useFetch<{ related?: string[] }>(`/api/wiki/note?path=${encodeURIComponent(p.wikiNote)}`, 0);
  const related = (data?.related || []).map(r => r.replace(/^\[\[|\]\]$/g, ""));
  const options = projects.filter(x => x.id !== p.id && x.wikiNote && !related.includes(noteTitle(x.wikiNote)));
  if (error) return <div className="hint">Related notes: {error}</div>;
  return <div className="row small">
    <span>Related:</span>{related.length ? related.map(r => <span key={r} className="chip">{r}</span>) : <span className="muted">none</span>}
    {options.length > 0 && <><select value={pick} onChange={e => setPick(e.target.value)} aria-label="Add a related project note"><option value="">Add a project note…</option>
      {options.map(x => <option key={x.id} value={noteTitle(x.wikiNote)}>{x.name}</option>)}</select>
      <button className="btn" disabled={!pick} onClick={async () => { try { const r = await post<{ added: string[] }>("/api/wiki/related", { path: p.wikiNote, titles: [pick] }); ui.status(r.added.length ? `Added [[${r.added[0]}]] to related.` : "That note is already related, or doesn't exist in the wiki."); setPick(""); reload(); } catch (x) { ui.error(x); } }}>Add</button></>}
  </div>;
}

function WikiNote({ p }: { p: any }) {
  const ui = useUi(), [val, setVal] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); const v = (val ?? p.wikiNote ?? "").trim(); if (v === (p.wikiNote || "")) return;
    try { if (p.wikiNote) await patchWithUndo(ui, "projects", p.id, { wikiNote: v }, "Wiki note changed."); else await patch("projects", p.id, { wikiNote: v }); setVal(null); } catch (x) { ui.error(x); }
  };
  const unlink = (e: React.MouseEvent) => ui.confirm(e.currentTarget, `Unlink the wiki note from ${p.name}? The note stays in the wiki.`, "Unlink",
    () => patchWithUndo(ui, "projects", p.id, { wikiNote: "" }, "Wiki note unlinked.").then(() => setVal(null)));
  return <>
    {p.wikiNote ? <div className="fm"><span className="src">{p.wikiNote}</span>{p.area && <span className="pill"><i />area: {p.area}</span>}</div>
      : <div className="empty">No wiki note linked.{p.area ? ` Area: ${p.area}.` : ""}</div>}
    <form className="row proj-form" onSubmit={save}>
      <input type="text" value={val ?? p.wikiNote ?? ""} onChange={e => setVal(e.target.value)} placeholder="wiki/1-projects/Note name.md" aria-label={"Wiki note path for " + p.name} />
      <button className="btn" type="submit">{p.wikiNote ? "Change" : "Link note"}</button>
      {p.wikiNote && <button className="btn sm" type="button" title="Unlink this wiki note" onClick={unlink}>Unlink</button>}
    </form>
    {p.wikiNote && <Related p={p} />}
    <p className="hint" style={{ margin: 0 }}>{p.wikiNote ? <>Open it on the <a href="#wiki">Wiki</a> tab. Moving this project on the board updates the note's project_status.</> : <>Paste a note path, or create one by giving the project a wiki area in New project.</>}</p>
  </>;
}

export function ProjectPage({ id, editing, setEditing }: { id: string; editing: boolean; setEditing: (b: boolean) => void }) {
  const ui = useUi(), ready = useReady(), p = projById(useColl("projects"), id);
  if (!p) return <div className="room"><p className="crumb"><a href="#projects">← Projects</a></p><div className="empty">{ready ? "No project at this link." : "Loading…"}</div></div>;
  const panels: PanelDef[] = [
    { key: "changes", title: "Recent changes", node: <Changes p={p} />, w: 7, h: 10 },
    { key: "tasks", title: "Tasks", node: <Tasks p={p} />, w: 5, h: 10 },
    { key: "repo", title: "Repository", node: <Repository p={p} />, w: 7, h: 11 },
    { key: "wiki", title: "Wiki note", node: <WikiNote p={p} />, w: 5, h: 6 },
    { key: "chats", title: "Chats", node: <Chats p={p} />, w: 5, h: 8 },
  ];
  return <div className="room">
    <p className="crumb"><a href="#projects">← Projects</a></p>
    <div className="room-head"><div className="titles"><h2>{p.name}</h2><span className="flavor">{p.next || "No next step set."}</span></div>
      <div className="proj-head"><StatusSelect p={p} /><Star p={p} />{p.repo && <span className="mono small muted">{p.repo}</span>}
        {p.archived && <span className="pill warn"><i />Archived</span>}
        <button className="btn" onClick={e => { const r = e.currentTarget.getBoundingClientRect(); projectMenu(ui, p, r.left, r.bottom + 4, true); }}>More…</button>
        <EditButton editing={editing} setEditing={setEditing} /></div></div>
    <PanelGrid key="project" page="project" panels={panels} editing={editing} />
  </div>;
}
