import { useRef, useState } from "react";
import type { PageDef } from "./types";
import type { PanelDef } from "../components/PanelGrid";
import { patch, useColl } from "../lib/store";
import { useUi } from "../lib/ui";
import { listOf, STATUSES, STATUS_LABEL, todayISO } from "../lib/util";
import { LogList, QuickLog, Star, projHref, AgentBadge } from "../components/Common";
import { NewProjectForm, Repo, StatusSelect, projectList, projectMenu, setArchived, useRepos } from "./projects/shared";
import "./projects.css";

function Card({ p, logs, open, repo, onDrag }: { p: any; logs: number; open: number; repo?: Repo; onDrag: (id: string | null) => void }) {
  const ui = useUi(), [dragging, setDragging] = useState(false);
  return <article className={"kcard" + (dragging ? " dragging" : "")} draggable data-card={p.id}
    onDragStart={e => { setDragging(true); onDrag(p.id); try { e.dataTransfer.setData("text/plain", p.id); e.dataTransfer.effectAllowed = "move"; } catch { /* old browsers */ } }}
    onDragEnd={() => { setDragging(false); onDrag(null); }}
    onContextMenu={e => { e.preventDefault(); e.stopPropagation(); projectMenu(ui, p, e.clientX, e.clientY); }}>
    <div className="name" style={{ display: "flex", justifyContent: "space-between", gap: 6 }}><a href={projHref(p)} draggable={false}>{p.name}</a><Star p={p} /></div>{p.agent?.status && <div><AgentBadge status={p.agent.status} name={p.agent.name} /></div>}
    {p.repo && <div className="repo">{p.repo}</div>}
    {p.next && <div className="next">{p.next}</div>}
    <div className="foot"><StatusSelect p={p} />
      {repo && Number(repo.behind) > 0 && <a className="chip warn" href={projHref(p)} draggable={false} title={`${repo.name}'s upstream has ${repo.behind} commits you don't have yet (from UpstreamManager). Open the project to see its repo.`}>{repo.behind} new upstream</a>}
      <span className="small muted">{logs} log{logs === 1 ? "" : "s"} · {open} task{open === 1 ? "" : "s"}</span></div>
  </article>;
}

function Board({ showArchived }: { showArchived: boolean }) {
  const ui = useUi(), projects = useColl("projects"), logs = useColl("logs"), tasks = useColl("tasks");
  const { data: repos } = useRepos();
  const drag = useRef<string | null>(null), [over, setOver] = useState("");
  const logCount: Record<string, number> = {}; logs.forEach(l => { logCount[l.project] = (logCount[l.project] || 0) + 1; });
  const openCount: Record<string, number> = {}; tasks.forEach(t => { if (!t.done) openCount[listOf(t)] = (openCount[listOf(t)] || 0) + 1; });
  const repoOf = (p: any) => (p.upstreamRepo && Array.isArray(repos) ? repos.find(r => r.id === p.upstreamRepo) : undefined);
  const drop = (e: React.DragEvent, s: string) => {
    e.preventDefault(); setOver("");
    const id = drag.current; drag.current = null; const p = id && projects.find(x => x.id === id);
    if (p && p.status !== s) patch("projects", p.id, { status: s, updated: todayISO() }).then(() => ui.status(`${p.name} moved to ${STATUS_LABEL[s]}.`)).catch(ui.error);
  };
  const arc = projects.filter(p => p.archived).sort((a, b) => String(a.name).localeCompare(b.name));
  return <>
    <p className="hint" style={{ margin: 0 }}>Drag a card to another column. Right-click a card to archive or delete it.</p>
    <div className="kanban" role="list">{STATUSES.map(s => {
      const cards = projects.filter(p => !p.archived && ((STATUSES as readonly string[]).includes(p.status) ? p.status : "next") === s)
        .sort((a, b) => String(b.updated || "").localeCompare(String(a.updated || "")) || String(a.name).localeCompare(b.name));
      return <div key={s} className={"kcol" + (over === s ? " drop" : "")} data-col={s} role="listitem" aria-label={STATUS_LABEL[s]}
        onDragOver={e => { if (!drag.current) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (over !== s) setOver(s); }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(o => (o === s ? "" : o)); }}
        onDrop={e => drop(e, s)}>
        <h4><span className={"st-" + s}>{STATUS_LABEL[s]}</span><span className="n">{cards.length}</span></h4>
        {cards.length ? cards.map(p => <Card key={p.id} p={p} logs={logCount[p.name] || 0} open={openCount[projectList(p)] || 0} repo={repoOf(p)} onDrag={id => { drag.current = id; if (!id) setOver(""); }} />)
          : <div className="empty small">Drop a card here.</div>}
      </div>;
    })}</div>
    {showArchived && arc.length > 0 && <>
      <h4 className="group-name">Archived</h4>
      <div className="projects">{arc.map(p => <article key={p.id} className="proj" data-card={p.id} onContextMenu={e => { e.preventDefault(); e.stopPropagation(); projectMenu(ui, p, e.clientX, e.clientY); }}>
        <div className="name"><a href={projHref(p)}>{p.name}</a><span className="small muted">{STATUS_LABEL[p.status] || p.status}</span></div>
        <div className="row"><button className="btn" onClick={() => setArchived(ui, p, false)}>Restore</button></div>
      </article>)}</div>
    </>}
  </>;
}

function BoardActions({ showArchived, setShowArchived }: { showArchived: boolean; setShowArchived: (b: boolean) => void }) {
  const ui = useUi(), n = useColl("projects").filter(p => p.archived).length;
  return <span className="row" style={{ gap: 6 }}>
    <label className="small row" style={{ gap: 4 }}><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> Show archived ({n})</label>
    <button className="btn primary" onClick={e => ui.pop(e.currentTarget, <NewProjectForm />)}>+ New project</button>
  </span>;
}

export const ProjectsPage: PageDef = {
  id: "projects", label: "Projects", title: "Workshop", flavor: "What is on the bench, and the log of how it got there.",
  usePanels: () => {
    const [showArchived, setShowArchived] = useState(false);
    const panels: PanelDef[] = [
      { key: "board", title: "Board", node: <Board showArchived={showArchived} />, act: <BoardActions showArchived={showArchived} setShowArchived={setShowArchived} />, w: 12, h: 12, minH: 6 },
      { key: "log", title: "Project log", node: <><QuickLog /><LogList limit={15} withFilter /></>, w: 12, h: 10 },
    ];
    return { panels };
  },
};
