import { post } from "../../lib/api";
import { useState } from "react";
import { create, patch, useColl } from "../../lib/store";
import { useUi } from "../../lib/ui";
import { useFetch } from "../../lib/useFetch";
import { STATUSES, STATUS_LABEL, todayISO } from "../../lib/util";
import { projHref, removeWithUndo } from "../../components/Common";

type Ui = ReturnType<typeof useUi>;
export type Repo = { id: string; name: string; focus_branch?: string; behind?: number; ahead?: number; conflicts?: any[]; components?: any[]; last_commit?: any; dirty?: number; github?: string };
export type Commit = { full: string; sha: string; date: string; author: string; subject: string };

export const AREAS = ["homelab", "ai", "automation", "hardware", "ttrpg", "gaming", "travel", "personal", "knowledge"];
/** The task list a project uses. */
export const projectList = (p: any) => p.taskList || p.name;
/** Find a project by the id part of its #p-<id> link. */
export const projById = (projects: any[], id: string) => projects.find(p => projHref(p) === "#p-" + id);

/** UpstreamManager repos through the Orb server (503 with a message when not set up). */
export const useRepos = () => useFetch<Repo[]>("/api/upstream/repos", 120000);

export async function setArchived(ui: Ui, p: any, on: boolean) {
  try { await patch("projects", p.id, { archived: on, updated: todayISO() }); ui.status(on ? `${p.name} archived. Its wiki note is unchanged.` : `${p.name} restored.`); }
  catch (e) { ui.error(e); }
}
async function deleteProject(ui: Ui, p: any, leave: boolean) {
  try { await removeWithUndo(ui, "projects", p.id, `${p.name} deleted. Its log entries and wiki note stay.`); if (leave) location.hash = "projects"; }
  catch (e) { ui.error(e); }
}

/** Right-click menu for a project card (and the More… button on its page). */
export function projectMenu(ui: Ui, p: any, x: number, y: number, onPage = false) {
  ui.menu(x, y, [
    ...(onPage ? [] : [{ label: "Open project page", run: () => { location.hash = projHref(p).slice(1); } }]),
    { label: p.archived ? "Restore from archive" : "Archive (hide from the board)", run: () => setArchived(ui, p, !p.archived) },
    "-",
    { label: "Delete…", danger: true, run: () => ui.menu(x, y, [
      { label: `Delete ${p.name}? Its log entries and wiki note stay.`, heading: true },
      { label: "Delete project", danger: true, run: () => deleteProject(ui, p, onPage) },
      { label: "Cancel" },
    ]) },
  ]);
}

export function StatusSelect({ p }: { p: any }) {
  const ui = useUi();
  return <select className={"st-" + p.status} value={STATUSES.includes(p.status) ? p.status : "next"} aria-label={"Move " + p.name}
    onChange={e => patch("projects", p.id, { status: e.target.value, updated: todayISO() }).catch(ui.error)}>
    {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
  </select>;
}

/** The "+ New project" popup form. */
export function NewProjectForm() {
  const ui = useUi(), projects = useColl("projects");
  const [name, setName] = useState(""), [next, setNext] = useState(""), [status, setStatus] = useState("next"), [area, setArea] = useState(""), [err, setErr] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); const n = name.trim(); if (!n) return;
    if (projects.some(p => p.name === n)) { setErr(`There is already a project called ${n}.`); return; }
    try {
      const p = await create("projects", { name: n, next: next.trim(), status, repo: "", updated: todayISO(), ...(area ? { area } : {}) });
      ui.close(); ui.status(`${n} added to ${STATUS_LABEL[status]}.`);
      if (area) {
        // Creates wiki/1-projects/<name>.md from the PROJECT template and links it from the area hub.
        try { const r = await post<{ path: string; created: boolean; linked?: boolean }>("/api/wiki/project", { projectId: p.id, area });
          ui.status(r.created ? `${n} added, with a wiki note${r.linked ? " linked from its area hub" : ""}.` : `${n} added and linked to its existing wiki note.`); }
        catch (x: any) { ui.status(`${n} added, but the wiki note wasn't created: ${x.message}`); }
      }
    } catch (x: any) { setErr(x?.message || String(x)); }
  };
  return <form className="pop-form" style={{ minWidth: "min(320px,86vw)" }} onSubmit={submit}>
    <div className="mh" style={{ padding: 0 }}>New project</div>
    <label className="small">Name<input type="text" value={name} onChange={e => setName(e.target.value)} required aria-label="Project name" /></label>
    <label className="small">Next step<input type="text" value={next} onChange={e => setNext(e.target.value)} aria-label="Next step" /></label>
    <label className="small">Column<select value={status} onChange={e => setStatus(e.target.value)}>{STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></label>
    <label className="small">Wiki area (creates its note)<select value={area} onChange={e => setArea(e.target.value)}><option value="">None</option>{AREAS.map(a => <option key={a} value={a}>{a}</option>)}</select></label>
    {err && <div className="err">{err}</div>}
    <div className="row"><button className="btn primary" type="submit">Create project</button><button className="btn" type="button" onClick={ui.close}>Cancel</button></div>
  </form>;
}
