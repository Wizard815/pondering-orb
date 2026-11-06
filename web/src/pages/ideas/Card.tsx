import { useEffect, useRef } from "react";
import { create, patch, useColl, Doc } from "../../lib/store";
import { useUi } from "../../lib/ui";
import { mdToHtml } from "../../lib/markdown";
import { patchWithUndo } from "../../components/Common";
import { fmtDate, isUrl, listOf, prioName, prioOf, sortTasks, todayISO } from "../../lib/util";
import { MC_TYPES, STAGE_LABEL, boardOf, typeOf } from "./model";

export type ItemEdit = { id: string; k: number } | null;
type Ctx = { linking: string | null; itemEdit: ItemEdit; setItemEdit: (e: ItemEdit) => void };

const Ttl = ({ v, ph }: { v?: string; ph: string }) => v ? <div className="mc-title">{v}</div> : <div className="mc-title ph">{ph}</div>;

/** Inline editor for one to-do item; Enter or leaving the field saves, an empty value removes it. */
function ItemEditor({ card, k, text, done }: { card: Doc; k: number; text: string; done: () => void }) {
  const ui = useUi(), ref = useRef<HTMLInputElement>(null), saved = useRef(false);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const save = () => {
    if (saved.current) return; saved.current = true;
    const t = (ref.current?.value || "").trim();
    const items = (card.items || []).map((x: any, j: number) => (j === k ? { ...x, t } : x)).filter((_: any, j: number) => j !== k || t);
    done(); patch("canvas", card.id, { items }).catch(ui.error);
  };
  return <li><form className="mc-itemform" onSubmit={e => { e.preventDefault(); save(); }}>
    <input ref={ref} type="text" name="t" defaultValue={text} aria-label="Edit item" onBlur={save}
      onKeyDown={e => { if (e.key === "Escape") { saved.current = true; done(); } }} /></form></li>;
}

function TodoBody({ i, ctx }: { i: Doc; ctx: Ctx }) {
  const ui = useUi(), items: { t: string; done?: boolean }[] = i.items || [], done = items.filter(x => x.done).length;
  const toggle = (k: number, on: boolean) => patch("canvas", i.id, { items: items.map((x, j) => (j === k ? { ...x, done: on } : x)) }).catch(ui.error);
  const del = (k: number) => patchWithUndo(ui, "canvas", i.id, { items: items.filter((_, j) => j !== k) }, `Removed “${items[k]?.t || "item"}”.`).catch(ui.error);
  const add = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const f = e.currentTarget, inp = f.elements.namedItem("t") as HTMLInputElement, t = inp.value.trim(); if (!t) return;
    inp.value = ""; patch("canvas", i.id, { items: [...items, { t, done: false }] }).catch(ui.error);
  };
  return <>
    <div className="mc-head"><Ttl v={i.title} ph="To-do" />{items.length > 0 && <span className="mono small muted">{done}/{items.length}</span>}</div>
    {items.length > 0 && <div className="mc-prog"><span style={{ width: Math.round(done / items.length * 100) + "%" }} /></div>}
    <ul className="mc-todo">{items.map((x, k) => ctx.itemEdit && ctx.itemEdit.id === i.id && ctx.itemEdit.k === k
      ? <ItemEditor key={k} card={i} k={k} text={x.t} done={() => ctx.setItemEdit(null)} />
      : <li key={k}><input type="checkbox" checked={!!x.done} onChange={e => toggle(k, e.target.checked)} aria-label={x.t} />
        <span className={"mc-item-t" + (x.done ? " done" : "")} data-item={k} title="Double-click to edit">{x.t}</span>
        <button type="button" className="mc-x" onClick={() => del(k)} aria-label={"Remove " + x.t}>×</button></li>)}</ul>
    <form className="mc-add" onSubmit={add}><input type="text" name="t" placeholder="+ Add an item" aria-label="Add an item" /></form>
  </>;
}

function TasksBody({ i }: { i: Doc }) {
  const ui = useUi(), all = useColl("tasks"), l: string = i.list || "";
  if (!l) return <><Ttl ph="Tasks" /><div className="hint">Double-click to choose a task list.</div></>;
  const items = sortTasks(all.filter(x => listOf(x) === l)), open = items.filter(x => !x.done).length;
  const toggle = (t: Doc, on: boolean) => patch("tasks", t.id, on ? { done: true, doneAt: todayISO(), doneBy: "you" } : { done: false, doneAt: "", doneBy: "" }).catch(ui.error);
  const add = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const inp = e.currentTarget.elements.namedItem("t") as HTMLInputElement, t = inp.value.trim(); if (!t) return;
    inp.value = ""; create("tasks", { title: t, list: l, due: "", done: false }).catch(ui.error);
  };
  return <>
    <div className="mc-head"><div className="mc-title">{i.title || l}</div><span className="chip" title="Task list">☰ {l}</span></div>
    <div className="hint">{open} open</div>
    <ul className="mc-todo">{items.slice(0, 12).map(x => { const p = prioOf(x); return <li key={x.id}>
      <input type="checkbox" checked={!!x.done} onChange={e => toggle(x, e.target.checked)} aria-label={x.title} />
      {p ? <span className={"prio l" + p} title={prioName(p)}>{prioName(p)}</span> : null}
      <span className={x.done ? "done" : ""}>{x.title}</span>
      {x.due && <span className="mono small muted" style={{ marginLeft: "auto" }}>{fmtDate(x.due)}</span>}</li>; })}</ul>
    <form className="mc-add" onSubmit={add}><input type="text" name="t" placeholder={"+ Add a task to " + l} aria-label="Add a task" /></form>
  </>;
}

function Inner({ i, ctx, canvas }: { i: Doc; ctx: Ctx; canvas: Doc[] }) {
  const t = typeOf(i);
  if (t === "idea") return <><div className="mc-top"><span className={"chip st-" + (i.stage || "thought")}>{STAGE_LABEL[i.stage] || "Thought"}</span>{i.promoted && <span className="chip ok">Promoted</span>}</div>
    <Ttl v={i.title} ph="Untitled idea" />{i.text && <div className="mc-text">{i.text}</div>}</>;
  if (t === "todo") return <TodoBody i={i} ctx={ctx} />;
  if (t === "tasks") return <TasksBody i={i} />;
  if (t === "link") return <><Ttl v={i.title || (i.url && i.url !== "https://" ? i.url : "")} ph="Link" />{isUrl(i.url) && <a href={i.url} target="_blank" rel="noopener" className="mc-url">{i.url}</a>}</>;
  if (t === "board") { const n = canvas.filter(k => boardOf(k) === i.id).length; return <><div className="mc-bicon">▣</div><Ttl v={i.title} ph="Untitled board" /><div className="hint">{n} card{n === 1 ? "" : "s"} · double-click to open</div></>; }
  if (t === "comment") return i.text ? <div className="mc-text">{i.text}</div> : <div className="mc-text ph">Empty comment</div>;
  if (!i.title && !i.text) return <div className="mc-text ph">Empty note</div>;
  return <>{i.title && <div className="mc-title">{i.title}</div>}<div className="mc-text md" dangerouslySetInnerHTML={{ __html: mdToHtml(i.text || "") }} /></>;
}

export function Card({ i, inCol, canvas, ctx }: { i: Doc; inCol?: boolean; canvas: Doc[]; ctx: Ctx }) {
  const t = typeOf(i), c = i.color ? `var(--${i.color})` : "var(--line-hi)";
  const style: Record<string, string> = { "--c": c };
  if (!inCol) Object.assign(style, { left: Math.round(i.x || 0) + "px", top: Math.round(i.y || 0) + "px", width: Math.round(i.w || MC_TYPES[t].w || 220) + "px" });
  const kids = t === "column" ? canvas.filter(k => k.parent === i.id).sort((a, b) => (a.order || 0) - (b.order || 0)) : [];
  return <article className={`mc-card t-${t}${inCol ? " in-col" : ""}${ctx.linking === i.id ? " linking" : ""}`} data-mc={i.id} style={style as React.CSSProperties}
    tabIndex={0} aria-label={`${MC_TYPES[t].label}${i.title ? ": " + i.title : ""}. Arrow keys move, Enter opens, Delete removes, menu key for more.`}>
    {t === "column"
      ? <><div className={"mc-title mc-colhead" + (i.title ? "" : " ph")}>{i.title || "Untitled column"}</div>
        <div className="mc-col" data-col={i.id}>{kids.length ? kids.map(k => <Card key={k.id} i={k} inCol canvas={canvas} ctx={ctx} />) : <div className="hint mc-empty">Drop cards here</div>}</div></>
      : <Inner i={i} ctx={ctx} canvas={canvas} />}
    {!inCol && <span className="mc-rz" data-mcrz aria-hidden="true" />}
  </article>;
}
