import { useMemo, useState } from "react";
import { create, patch, remove, useColl, useSettings, getDoc } from "../lib/store";
import { useUi } from "../lib/ui";
import { choreState, fmtDate, listOf, logSorted, prioName, prioOf, sortTasks, todayISO, PRIO_LEVELS } from "../lib/util";

export const projHref = (p: { id: string }) => "#p-" + String(p.id).replace(/[^A-Za-z0-9-]/g, "");
export const useLogMax = () => { const s = useSettings(); return Math.max(20, Math.min(200, Number(s.logMax) || 50)); };

export function Star({ p }: { p: any }) {
  const ui = useUi();
  return <button className="star" aria-pressed={!!p.fav} aria-label={p.fav ? "Remove from favorites" : "Add to favorites"} onClick={() => patch("projects", p.id, { fav: !p.fav }).catch(ui.error)}>{p.fav ? "★" : "☆"}</button>;
}

export function PrioChip({ t }: { t: any }) {
  const ui = useUi(), p = prioOf(t);
  const pick = (e: React.MouseEvent) => { const r = (e.currentTarget as Element).getBoundingClientRect();
    ui.menu(r.left, r.bottom + 4, [{ label: "Priority", heading: true }, ...[...PRIO_LEVELS].reverse().map(l => ({ label: `${l.level === p ? "✓ " : ""}${l.name}`, run: () => { if (l.level !== p) patch("tasks", t.id, { priority: l.cal }).catch(ui.error); } }))]); };
  return <button className={`prio l${p}`} onClick={pick} title={`Priority: ${prioName(p)}. Click to change.`} aria-label={`Priority ${prioName(p)}, change`}>{p ? prioName(p) : "·"}</button>;
}

/** Priority select for add-task forms. value and onChange use CalDAV numbers. */
export function PrioSelect({ value, onChange }: { value: number; onChange: (cal: number) => void }) {
  return <select value={value} onChange={e => onChange(Number(e.target.value))} aria-label="Priority">
    {[...PRIO_LEVELS].reverse().map(l => <option key={l.level} value={l.cal}>{l.level ? l.name : "No priority"}</option>)}</select>;
}

export function TaskRows({ tasks, showList }: { tasks: any[]; showList?: boolean }) {
  const ui = useUi(), today = todayISO();
  const toggle = (t: any, done: boolean) => patch("tasks", t.id, done ? { done: true, doneAt: today, doneBy: "you" } : { done: false, doneAt: "", doneBy: "" }).catch(ui.error);
  if (!tasks.length) return <div className="empty">No tasks.</div>;
  return <div>{tasks.map(t => <div key={t.id} className={"task" + (t.done ? " done" : "")}>
    <input type="checkbox" checked={!!t.done} onChange={e => toggle(t, e.target.checked)} aria-label={"Done: " + t.title} />
    <PrioChip t={t} />
    <div className="grow"><span className="t">{t.title}</span>{showList && <> <span className="tag">{listOf(t)}</span></>}{t.done && t.doneBy && <div className="hint">done by {t.doneBy}</div>}</div>
    {t.due && <span className={"due" + (!t.done && t.due < today ? " late" : "")}>{fmtDate(t.due)}</span>}
  </div>)}</div>;
}

export function OpenTasks({ limit = 8 }: { limit?: number }) {
  const tasks = useColl("tasks"), s = useSettings(), lists: string[] = s.mainLists || [];
  const list = sortTasks(tasks.filter(t => !t.done && (!lists.length || lists.includes(listOf(t))))).slice(0, limit);
  return list.length ? <TaskRows tasks={list} showList /> : <div className="empty">No open tasks in the chosen lists.</div>;
}

export function ChoreRows({ limit = 0 }: { limit?: number }) {
  const ui = useUi(), chores = useColl("chores");
  let list = chores.map(c => ({ c, s: choreState(c) })).sort((a, b) => a.s.due - b.s.due);
  if (limit) list = list.filter(x => x.s.cls !== "ok").slice(0, limit);
  if (!list.length) return <div className="empty">{limit ? "All chores done. Nothing due." : "No chores yet. Add backups, updates, disk scrubs."}</div>;
  const done = (c: any) => { const before = c.lastDone || ""; patch("chores", c.id, { lastDone: todayISO() }).then(() => ui.undo(`${c.name} done.`, () => patch("chores", c.id, { lastDone: before }))).catch(ui.error); };
  return <>{list.map(({ c, s }) => <div key={c.id} data-id={c.id} className={"uk " + (c.lastDone ? s.cls : "soon")}><span className="stripe" />
    <div><div className="n">{c.name}</div><div className="m">{!c.lastDone ? "never done" : s.left < 0 ? `${-s.left} day${s.left === -1 ? "" : "s"} overdue` : s.left === 0 ? "due today" : `due in ${s.left} day${s.left === 1 ? "" : "s"}`} · every {c.everyDays}d · last {c.lastDone ? fmtDate(c.lastDone) : "never"}</div></div>
    <button className="btn" onClick={() => done(c)}>Done</button></div>)}</>;
}

/** Type an entry, press Log it, then pick the project (or make one) in a popup. */
export function QuickLog({ project }: { project?: string }) {
  const ui = useUi(), max = useLogMax(), projects = useColl("projects");
  const [text, setText] = useState("");
  const live = projects.filter(p => !p.archived).map(p => p.name).sort();
  const commit = async (name: string, t: string) => { await create("logs", { project: name, text: t, date: todayISO(), created: Date.now() }); localStorage.setItem("orb.lastLogProject", name); ui.status(`Logged to ${name}.`); };
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const t = text.trim(); if (!t) return;
    if (project) { await commit(project, t).catch(ui.error); setText(""); return; }
    const anchor = (e.currentTarget.querySelector("button[type=submit]") as Element);
    const last = localStorage.getItem("orb.lastLogProject") || "";
    ui.pop(anchor, <LogPick text={t} names={live} def={live.includes(last) ? last : live[0] || "General"} onPick={async (name, isNew) => {
      try { if (isNew && !projects.some(p => p.name === name)) await create("projects", { name, status: "next" }); await commit(name, t); setText(""); ui.close(); } catch (x) { ui.error(x); }
    }} />);
  };
  return <form className="row" onSubmit={submit}>
    <input type="text" value={text} maxLength={max} onChange={e => setText(e.target.value)} placeholder={`What changed (${max} characters)`} aria-label={`Log entry, up to ${max} characters`} style={{ flex: "1 1 180px" }} />
    <span className={"counter" + (text.length >= max ? " full" : "")}>{text.length}/{max}</span>
    <button className="btn primary" type="submit">Log it</button>
  </form>;
}
function LogPick({ text, names, def, onPick }: { text: string; names: string[]; def: string; onPick: (n: string, isNew: boolean) => void }) {
  const [sel, setSel] = useState(def), [nn, setNn] = useState("");
  return <form className="pop-form" onSubmit={e => { e.preventDefault(); sel === "__new" ? nn.trim() && onPick(nn.trim(), true) : onPick(sel, false); }}>
    <div className="small">Log <b>“{text}”</b> for which project?</div>
    <select value={sel} onChange={e => setSel(e.target.value)} aria-label="Project">{names.map(n => <option key={n}>{n}</option>)}<option>General</option><option value="__new">+ New project…</option></select>
    {sel === "__new" && <input type="text" value={nn} onChange={e => setNn(e.target.value)} placeholder="New project name" autoFocus />}
    <div className="row"><button className="btn primary" type="submit">Log it</button></div>
  </form>;
}

export function LogList({ limit, filter: initial, withFilter }: { limit: number; filter?: string; withFilter?: boolean }) {
  const logs = useColl("logs"); const [filter, setFilter] = useState(initial || ""); const [n, setN] = useState(limit);
  const names = useMemo(() => [...new Set(logs.map(l => l.project))].sort(), [logs]);
  const list = logSorted(logs).filter(l => !filter || l.project === filter);
  return <>
    {withFilter && <div className="row"><label className="hint">Show</label><select value={filter} onChange={e => setFilter(e.target.value)}><option value="">All projects</option>{names.map(x => <option key={x}>{x}</option>)}</select>{filter && <button className="btn" onClick={() => setFilter("")}>Clear filter</button>}</div>}
    {list.length ? <ul className="list">{list.slice(0, n).map(l => <li key={l.id}><span className="date">{l.date}</span><div className="grow">
      <button className="btn link tag" onClick={() => setFilter(l.project)} title={"Show only " + l.project}>{l.project}</button> {l.text}{l.by && <span className="hint"> · {l.by === "golem" ? "Golem" : l.by}</span>}</div></li>)}</ul>
      : <div className="empty">{filter ? `No entries for ${filter}.` : "No log entries yet."}</div>}
    {list.length > n && <button className="btn" onClick={() => setN(n + 25)}>Show older</button>}
  </>;
}

/** Delete with an Undo bar; restores the record with the same id. */
export async function removeWithUndo(ui: ReturnType<typeof useUi>, coll: Parameters<typeof remove>[0], id: string, msg: string) {
  const before = getDoc(coll, id); if (!before) return;
  await remove(coll, id);
  const { id: _i, version: _v, ...data } = before;
  ui.undo(msg, () => create(coll, { ...data, id }));
}
export async function patchWithUndo(ui: ReturnType<typeof useUi>, coll: Parameters<typeof patch>[0], id: string, p: Record<string, any>, msg: string) {
  const before = getDoc(coll, id); if (!before) return;
  await patch(coll, id, p);
  const restore = Object.fromEntries(Object.keys(p).map(k => [k, before[k] ?? ""]));
  ui.undo(msg, () => patch(coll, id, restore));
}
