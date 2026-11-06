import { useEffect, useState } from "react";
import type { PageDef } from "./types";
import type { PanelDef } from "../components/PanelGrid";
import { create, useColl } from "../lib/store";
import { useUi } from "../lib/ui";
import { listOf, oneAtATime, prioOf, sortTasks, zoneOpt } from "../lib/util";
import { TaskRows, PrioSelect } from "../components/Common";
import { GlanceInbox } from "../components/Glance";
import { useFetch } from "../lib/useFetch";
import { post } from "../lib/api";
import "./projects.css";

const KEY = "orb.todoLists";
const loadSel = (): string[] => { try { const v = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };

function Lists({ lists, sel, setSel }: { lists: string[]; sel: string[]; setSel: (l: string[]) => void }) {
  const tasks = useColl("tasks");
  const count = (l: string) => tasks.filter(t => listOf(t) === l && !t.done).length;
  const toggle = (l: string, on: boolean) => setSel(on ? [...sel, l] : sel.filter(x => x !== l));
  return <>
    {lists.length ? <ul className="cfg" role="group" aria-label="Lists to show">{lists.map(l => <li key={l}>
      <label><input type="checkbox" checked={sel.includes(l)} onChange={e => toggle(l, e.target.checked)} /> {l}</label>
      <span className="mono small muted" title="Open tasks">{count(l)}</span></li>)}</ul>
      : <div className="empty">No lists yet. Add a task to start one.</div>}
    <div className="hint">{sel.length ? `Showing ${sel.length} of ${lists.length}.` : "Showing all lists. Tick lists to narrow."}</div>
    {sel.length > 0 && <div className="row"><button className="btn" onClick={() => setSel([])}>Show all</button></div>}
    <p className="hint" style={{ margin: 0 }}>Each list is a CalDAV task collection. Projects use the list with their name.</p>
  </>;
}

function Tasks({ lists, shown, def }: { lists: string[]; shown: string[]; def: string }) {
  const ui = useUi(), tasks = useColl("tasks");
  const [title, setTitle] = useState(""), [list, setList] = useState<string | null>(null), [prio, setPrio] = useState("0"), [due, setDue] = useState("");
  const [min, setMin] = useState(0), [hideDone, setHideDone] = useState(false);
  const keep = (x: any) => prioOf(x) >= min && (!hideDone || !x.done);
  const add = async (e: React.FormEvent) => {
    e.preventDefault(); const t = title.trim(); if (!t) return;
    const l = (list ?? def).trim() || "Inbox";
    await oneAtATime(e.currentTarget as HTMLFormElement, async () => { try { await create("tasks", { title: t, list: l, due, done: false, priority: Number(prio) || 0 }); setTitle(""); setDue(""); setPrio("0"); ui.status(`Added to ${l}.`); } catch (x) { ui.error(x); } });
  };
  return <>
    <div className="row small">
      <label className="row" style={{ gap: 4 }}>Show<select value={min} onChange={e => setMin(Number(e.target.value))} aria-label="Lowest priority shown">
        <option value={0}>every priority</option><option value={2}>Medium and up</option><option value={3}>High and up</option><option value={4}>Urgent and up</option><option value={5}>Do now only</option></select></label>
      <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={hideDone} onChange={e => setHideDone(e.target.checked)} /> Hide done</label>
      <span className="hint">Sorted by priority, then due date. Click a priority chip to change it.</span>
    </div>
    {shown.map(l => { const items = sortTasks(tasks.filter(x => listOf(x) === l && keep(x))); return <div key={l}>
      <h4 className="group-name">{l}</h4>{items.length ? <TaskRows tasks={items} /> : <div className="empty small">Empty list.</div>}</div>; })}
    {!shown.length && <div className="empty">No tasks yet.</div>}
    <form className="row proj-form" onSubmit={add}>
      <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="New task" aria-label="New task" required />
      <input type="text" list="todo-list-names" value={list ?? def} onChange={e => setList(e.target.value)} placeholder="List" aria-label="List" style={{ flex: "0 1 140px" }} />
      <datalist id="todo-list-names">{lists.map(l => <option key={l} value={l} />)}</datalist>
      <PrioSelect value={Number(prio) || 0} onChange={v => setPrio(String(v))} />
      <input type="date" value={due} onChange={e => setDue(e.target.value)} aria-label="Due date" />
      <button className="btn primary" type="submit">Add task</button>
    </form>
    <p className="hint" style={{ margin: 0 }}>Five levels, the same as vikunja: Low, Medium, High, Urgent, Do now. Saved to CalDAV's PRIORITY as 9, 5, 3, 2 and 1, which vikunja reads back as the same level.</p>
  </>;
}

export const TodoPage: PageDef = {
  id: "todo", label: "To-do", title: "Task Ledger", flavor: "CalDAV task lists. Pick the lists you want to see.",
  usePanels: () => {
    const tasks = useColl("tasks");
    const lists = [...new Set(tasks.map(listOf))].sort((a, b) => a.localeCompare(b));
    const [chosen, setChosen] = useState<string[]>(loadSel);
    useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(chosen)); } catch { /* private mode */ } }, [chosen]);
    const sel = chosen.filter(l => lists.includes(l)), shown = sel.length ? sel : lists;
    const panels: PanelDef[] = [
      { key: "lists", title: "Lists", node: <Lists lists={lists} sel={sel} setSel={setChosen} />, w: 3, h: 10 },
      { key: "tasks", title: "Tasks", node: <Tasks lists={lists} shown={shown} def={sel[0] || lists[0] || "Inbox"} />, w: 9, h: 14 },
      { key: "dayglance", title: "dayGLANCE tasks", node: <GlanceInbox />, w: 12, h: 8 },
    ];
    return { panels, extra: <CalDavStatus /> };
  },
};

/** CalDAV status in the page header, with Sync now. */
function CalDavStatus() {
  const ui = useUi(), { data, error, reload } = useFetch<{ configured: boolean; lists: string[]; lastSync: number; lastError: string }>("/api/caldav/status", 60000), [busy, setBusy] = useState(false);
  if (error) return null;
  if (data && !data.configured) return <a className="pill warn" href="#config"><i />CalDAV not set up: tasks stay in Orb</a>;
  return <span className="row">{data && <span className={"pill " + (data.lastError ? "bad" : "ok")} title={data.lastError || ""}><i />{data.lastError ? "CalDAV sync failed" : `CalDAV: ${data.lists.length} lists${data.lastSync ? " · synced " + new Date(data.lastSync).toLocaleTimeString(undefined, zoneOpt()) : ""}`}</span>}
    <button className="btn" disabled={busy} onClick={async () => { setBusy(true); try { const r = await post<{ lists: number; tasks: number }>("/api/caldav/sync"); ui.status(`Synced ${r.tasks} to-dos from ${r.lists} lists.`); } catch (x) { ui.error(x); } finally { reload(); setBusy(false); } }}>Sync now</button></span>;
}
