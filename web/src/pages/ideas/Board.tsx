import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { create, getColl, getDoc, patch, useColl, useReady, Doc } from "../../lib/store";
import { useUi, MenuItem } from "../../lib/ui";
import { removeWithUndo } from "../../components/Common";
import { todayISO } from "../../lib/util";
import { Card, ItemEdit } from "./Card";
import { EdgeLabelForm, EditForm } from "./forms";
import {
  CARD_TYPES, CardType, EDGE_KINDS, MC_COLORS, MC_TYPES, STAGES, STAGE_LABEL, Tool, boardOf, camOf, cardName, clampZ,
  createCard, deleteCard, isEmptyCard, saveCams, setCam, taskLists,
} from "./model";
import "./ideas.css";

const camCss = (c: { x: number; y: number; z: number }) => `translate(${c.x}px,${c.y}px) scale(${c.z})`;
const SVG = "http://www.w3.org/2000/svg";
const KEYS: Record<string, Tool> = { v: "select", n: "note", i: "idea", t: "todo", l: "link", c: "column", b: "board", m: "comment" };
const RAIL: [Tool, string, string, string][] = [
  ["select", "Select", "⬚", "Select and move (V)"],
  ...CARD_TYPES.map(k => [k, MC_TYPES[k].label, MC_TYPES[k].icon,
    k === "todo" ? "To-do checklist on the board (T)" : k === "tasks" ? "Show a task list on the board" : `${MC_TYPES[k].label} (${Object.keys(KEYS).find(x => KEYS[x] === k)?.toUpperCase()})`] as [Tool, string, string, string]),
  ["connect", "Connect", "⟶", "Connect two cards with an arrow"],
];
// Survives tab switches, like the demo's UI.mcBoard.
let lastBoard = "root";
const inLayoutEdit = (el: Element | null) => !!el?.closest(".editing");

/** The Ideas board: a Milanote-style canvas (demo: boardHTML and the mc* handlers). */
export function Board() {
  const ui = useUi(), canvas = useColl("canvas"), edges = useColl("edges"), ready = useReady();
  const [board, setBoardState] = useState(lastBoard);
  const [tool, setTool] = useState<Tool>("select");
  const [from, setFrom] = useState<string | null>(null);
  const [itemEdit, setItemEdit] = useState<ItemEdit>(null);
  const [editNext, setEditNext] = useState<string | null>(null);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const viewRef = useRef<HTMLDivElement>(null), worldRef = useRef<HTMLDivElement>(null), edgesRef = useRef<SVGGElement>(null);
  const fresh = useRef<string | null>(null), boardRef = useRef(board); boardRef.current = board;

  const setBoard = (b: string) => { lastBoard = b; setBoardState(b); setFrom(null); setItemEdit(null); };
  // A board that was deleted (or never loaded) falls back to the root.
  useEffect(() => { if (ready && board !== "root" && !canvas.some(c => c.id === board && c.type === "board")) setBoard("root"); }, [ready, canvas, board]);

  const items = canvas.filter(i => boardOf(i) === board);
  const loose = items.filter(i => !i.parent || !canvas.some(c => c.id === i.parent)).sort((a, b) => (a.z || 0) - (b.z || 0));
  const cam = camOf(board);
  const ctx = { linking: from, itemEdit, setItemEdit };

  const applyCam = () => { const w = worldRef.current; if (w) w.style.transform = camCss(camOf(boardRef.current)); };
  const at = (cx: number, cy: number) => { const r = viewRef.current!.getBoundingClientRect(), c = camOf(boardRef.current); return { x: (cx - r.left - c.x) / c.z, y: (cy - r.top - c.y) / c.z }; };

  // Arrows are drawn straight into the SVG from the cards' boxes, so a drag can redraw them without a React render.
  const drawEdges = () => {
    const g = edgesRef.current, world = worldRef.current; if (!g || !world) return;
    const b = boardRef.current, z = camOf(b).z, wr = world.getBoundingClientRect();
    const box = (id: string) => { const el = world.querySelector(`[data-mc="${CSS.escape(id)}"]`); if (!el) return null; const r = el.getBoundingClientRect(); return { x: (r.left - wr.left) / z, y: (r.top - wr.top) / z, w: r.width / z, h: r.height / z }; };
    const edgePt = (a: { x: number; y: number; w: number; h: number }, tx: number, ty: number) => {
      const cx = a.x + a.w / 2, cy = a.y + a.h / 2, dx = tx - cx, dy = ty - cy; if (!dx && !dy) return [cx, cy];
      const s = Math.min(Math.abs((a.w / 2) / (dx || 1e-9)), Math.abs((a.h / 2) / (dy || 1e-9))); return [cx + dx * s, cy + dy * s];
    };
    g.replaceChildren();
    for (const e of getColl("edges")) {
      if (boardOf(e) !== b) continue;
      const A = box(e.from), B = box(e.to); if (!A || !B) continue;
      const [x1, y1] = edgePt(A, B.x + B.w / 2, B.y + B.h / 2), [x2, y2] = edgePt(B, A.x + A.w / 2, A.y + A.h / 2);
      const eg = document.createElementNS(SVG, "g"); eg.setAttribute("class", "mc-edge"); eg.setAttribute("data-edge", e.id);
      const line = (attrs: Record<string, string>) => { const l = document.createElementNS(SVG, "line"); for (const [k, v] of Object.entries({ x1: String(x1), y1: String(y1), x2: String(x2), y2: String(y2), ...attrs })) l.setAttribute(k, v); eg.appendChild(l); };
      line({ stroke: "transparent", "stroke-width": "14" });
      line({ stroke: "var(--muted)", "stroke-width": "1.6", fill: "none", "marker-end": "url(#mc-arrow)", ...(e.kind === "depends" ? { "stroke-dasharray": "6 5" } : {}) });
      const lab = e.label || (e.kind === "depends" ? "depends on" : e.kind === "became" ? "became" : "");
      if (lab) { const t = document.createElementNS(SVG, "text"); t.setAttribute("x", String((x1 + x2) / 2)); t.setAttribute("y", String((y1 + y2) / 2 - 6)); t.setAttribute("text-anchor", "middle"); t.setAttribute("class", "mc-elab"); t.textContent = lab; eg.appendChild(t); }
      g.appendChild(eg);
    }
  };
  useLayoutEffect(drawEdges);
  useEffect(() => { const w = worldRef.current; if (!w || typeof ResizeObserver === "undefined") return; const ro = new ResizeObserver(() => drawEdges()); w.querySelectorAll(".mc-card").forEach(n => ro.observe(n)); return () => ro.disconnect(); });

  // ---- create / edit / delete
  const openEdit = (id: string, anchor: Element) => {
    const i = getDoc("canvas", id); if (!i) return;
    const dropIfFresh = () => { const f = fresh.current; fresh.current = null; if (f !== id) return; const cur = getDoc("canvas", id); if (cur && isEmptyCard(cur)) deleteCard(cur).catch(() => {}); };
    const save = async (up: Record<string, any>) => {
      fresh.current = null; ui.close();
      const cur = getDoc("canvas", id); if (!cur) return;
      try {
        if (isEmptyCard({ ...cur, ...up })) { await deleteCard(cur); ui.status("Nothing was typed, so the card was removed."); return; }
        await patch("canvas", id, { ...up, updated: todayISO() });
      } catch (e) { ui.error(e); }
    };
    ui.pop(anchor, <EditForm i={i} lists={taskLists()} onSave={save} onCancel={() => ui.close()} />, dropIfFresh);
  };
  const createAt = (type: CardType, p: { x: number; y: number }) => {
    createCard(boardRef.current, type, p).then(d => { setTool("select"); fresh.current = d.id; setEditNext(d.id); }).catch(ui.error);
  };
  useEffect(() => {
    if (!editNext) return;
    const el = viewRef.current?.querySelector(`[data-mc="${CSS.escape(editNext)}"]`); if (!el) return;
    const id = editNext; setEditNext(null); setTimeout(() => openEdit(id, el), 0);
  }, [editNext, canvas]);
  const del = (i: Doc) => deleteCard(i).then(undo => ui.undo(`Deleted ${cardName(i)}.`, undo)).catch(ui.error);
  const promote = async (i: Doc) => {
    try {
      await create("projects", { name: i.title || "New project", next: i.text || "", status: "next", repo: "", updated: todayISO() });
      await patch("canvas", i.id, { promoted: todayISO(), stage: "code" });
      ui.status(`${i.title || "The idea"} is now a project in Up next.`);
    } catch (e) { ui.error(e); }
  };

  // ---- camera
  const zoomBy = (d: number) => {
    const c = camOf(board), v = viewRef.current, z = clampZ(c.z * (d > 0 ? 1.2 : 1 / 1.2));
    if (v) { const px = v.clientWidth / 2, py = v.clientHeight / 2; c.x = px - (px - c.x) * z / c.z; c.y = py - (py - c.y) * z / c.z; }
    c.z = z; saveCams(); applyCam(); bump();
  };
  const fit = () => {
    const b = boardRef.current, list = getColl("canvas").filter(i => boardOf(i) === b && !i.parent), v = viewRef.current; if (!v || !list.length) return;
    const minX = Math.min(...list.map(i => i.x || 0)), minY = Math.min(...list.map(i => i.y || 0)), maxX = Math.max(...list.map(i => (i.x || 0) + (i.w || 220))), maxY = Math.max(...list.map(i => (i.y || 0) + 260));
    const z = Math.max(0.35, Math.min(1.4, Math.min(v.clientWidth / (maxX - minX + 80), v.clientHeight / (maxY - minY + 80))));
    setCam(b, { z, x: -minX * z + 40, y: -minY * z + 30 }); saveCams(); applyCam(); bump();
  };
  useEffect(() => {
    const v = viewRef.current; if (!v) return;
    let t: ReturnType<typeof setTimeout>;
    const wheel = (e: WheelEvent) => {
      if (inLayoutEdit(v)) return;
      e.preventDefault();
      const c = camOf(boardRef.current), r = v.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const z = clampZ(c.z * Math.exp(-e.deltaY * 0.0015)), px = e.clientX - r.left, py = e.clientY - r.top;
        c.x = px - (px - c.x) * z / c.z; c.y = py - (py - c.y) * z / c.z; c.z = z;
      } else { c.x -= e.deltaX; c.y -= e.deltaY; }
      applyCam(); clearTimeout(t); t = setTimeout(() => { saveCams(); bump(); }, 200);
    };
    const noMiddle = (e: MouseEvent) => { if (e.button === 1) e.preventDefault(); };
    v.addEventListener("wheel", wheel, { passive: false }); v.addEventListener("mousedown", noMiddle); v.addEventListener("auxclick", noMiddle);
    return () => { clearTimeout(t); v.removeEventListener("wheel", wheel); v.removeEventListener("mousedown", noMiddle); v.removeEventListener("auxclick", noMiddle); };
  }, []);

  // ---- keyboard tools
  const toolRef = useRef(tool), fromRef = useRef(from); toolRef.current = tool; fromRef.current = from;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "") || (document.activeElement as HTMLElement)?.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey || inLayoutEdit(viewRef.current)) return;
      if (e.key === "Escape") { if (fromRef.current || toolRef.current !== "select") { setFrom(null); setTool("select"); } return; }
      const t = KEYS[e.key.toLowerCase()]; if (t && !document.querySelector(".pop,.cmenu")) { setTool(t); setFrom(null); }
    };
    addEventListener("keydown", key); return () => removeEventListener("keydown", key);
  }, []);

  // ---- pointer: pan, resize, connect, place, drag
  const pan = (e: React.PointerEvent, view: HTMLElement) => {
    const b = board, c = camOf(b), x0 = c.x, y0 = c.y, sx = e.clientX, sy = e.clientY; view.classList.add("panning");
    const mv = (ev: PointerEvent) => { c.x = x0 + ev.clientX - sx; c.y = y0 + ev.clientY - sy; applyCam(); };
    const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); removeEventListener("pointercancel", up); view.classList.remove("panning"); saveCams(); };
    addEventListener("pointermove", mv); addEventListener("pointerup", up); addEventListener("pointercancel", up);
  };
  const longPress = (e: React.PointerEvent) => {
    if (e.pointerType !== "touch") return;
    const sx = e.clientX, sy = e.clientY, tgt = e.target as Element;
    const timer = setTimeout(() => { off(); contextAt(tgt, sx, sy); }, 550);
    const cancel = (ev: PointerEvent) => { if (ev.type !== "pointermove" || Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) { clearTimeout(timer); off(); } };
    const off = () => { removeEventListener("pointermove", cancel); removeEventListener("pointerup", cancel); removeEventListener("pointercancel", cancel); };
    addEventListener("pointermove", cancel); addEventListener("pointerup", cancel); addEventListener("pointercancel", cancel);
  };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const view = e.currentTarget, target = e.target as Element;
    if (inLayoutEdit(view)) return;
    if (e.button === 1) { e.preventDefault(); pan(e, view); return; }
    if (e.button > 0) return;
    if (target.closest("input,button,a,select,textarea")) return;
    longPress(e);
    const c = camOf(board), card = target.closest(".mc-card") as HTMLElement | null, rz = target.closest("[data-mcrz]");
    if (tool === "connect") {
      if (!card) { setFrom(null); return; }
      const id = card.dataset.mc!;
      if (!from) { setFrom(id); return; }
      if (from !== id) create("edges", { board, from, to: id, kind: "relates", label: "" }).catch(ui.error);
      setFrom(null); setTool("select"); return;
    }
    if (tool !== "select" && !card) { createAt(tool, at(e.clientX, e.clientY)); return; }
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    if (rz && card) {
      const it = getDoc("canvas", card.dataset.mc!); if (!it) return;
      const w0 = it.w || MC_TYPES[it.type as CardType]?.w || 220;
      const mv = (ev: PointerEvent) => { card.style.width = Math.max(150, Math.min(560, w0 + (ev.clientX - sx) / c.z)) + "px"; drawEdges(); };
      const up = () => {
        removeEventListener("pointermove", mv); removeEventListener("pointerup", up);
        const w = Math.round(parseFloat(card.style.width));
        if (w !== w0) patch("canvas", it.id, { w }).catch(err => { card.style.width = w0 + "px"; ui.error(err); });
      };
      addEventListener("pointermove", mv); addEventListener("pointerup", up); return;
    }
    if (!card) { pan(e, view); return; }
    drag(card, sx, sy, c.z);
  };

  const drag = (card: HTMLElement, sx: number, sy: number, z: number) => {
    const id = card.dataset.mc!, it = getDoc("canvas", id); if (!it) return;
    const r0 = card.getBoundingClientRect(), offX = (sx - r0.left) / z, offY = (sy - r0.top) / z, inCol = card.classList.contains("in-col");
    const canDrop = it.type !== "column" && it.type !== "board";
    let moved = false;
    const colAt = (x: number, y: number) => {
      if (!canDrop) return null;
      const col = document.elementFromPoint(x, y)?.closest(".mc-col") as HTMLElement | null;
      return col && col.dataset.col !== id && viewRef.current?.contains(col) ? col : null;
    };
    const clearDrop = () => viewRef.current?.querySelectorAll(".mc-col.drop").forEach(n => n.classList.remove("drop"));
    const mv = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      if (!moved) {
        moved = true; card.classList.add("lifted"); card.style.pointerEvents = "none";
        // The world is transformed, so a fixed card is placed in world coordinates and escapes its column's layout.
        if (inCol) { card.style.width = r0.width / z + "px"; card.style.position = "fixed"; card.style.zIndex = "40"; }
      }
      const p = at(ev.clientX, ev.clientY);
      card.style.left = p.x - offX + "px"; card.style.top = p.y - offY + "px";
      drawEdges(); clearDrop(); colAt(ev.clientX, ev.clientY)?.classList.add("drop");
    };
    const up = async (ev: PointerEvent) => {
      removeEventListener("pointermove", mv); removeEventListener("pointerup", up);
      if (!moved) return;
      clearDrop();
      const col = colAt(ev.clientX, ev.clientY), p = at(ev.clientX, ev.clientY);
      const reset = () => {
        card.classList.remove("lifted"); card.style.pointerEvents = "";
        if (inCol) for (const k of ["position", "left", "top", "width", "zIndex"] as const) card.style[k] = "";
        drawEdges();
      };
      try {
        if (col) {
          const colId = col.dataset.col!, kids = [...col.querySelectorAll<HTMLElement>(":scope > .mc-card")].filter(n => n.dataset.mc !== id);
          let order = kids.length;
          kids.forEach((n, k) => { const r = n.getBoundingClientRect(); if (order === kids.length && ev.clientY < r.top + r.height / 2) order = k; });
          const sib = getColl("canvas").filter(c => c.parent === colId && c.id !== id).sort((a, b) => (a.order || 0) - (b.order || 0));
          sib.splice(order, 0, it);
          for (let k = 0; k < sib.length; k++) {
            const c = sib[k];
            if (c.id === id) await patch("canvas", id, { parent: colId, order: k });
            else if ((c.order || 0) !== k) await patch("canvas", c.id, { order: k });
          }
        } else {
          const x = Math.round(p.x - offX), y = Math.round(p.y - offY);
          if (!inCol) { card.style.left = x + "px"; card.style.top = y + "px"; }
          await patch("canvas", id, { parent: "", x, y });
        }
      } catch (err) {
        ui.error(err);
        if (!inCol) { card.style.left = Math.round(it.x || 0) + "px"; card.style.top = Math.round(it.y || 0) + "px"; }
      }
      reset();
    };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as Element; if (inLayoutEdit(e.currentTarget)) return;
    const itemT = target.closest(".mc-item-t") as HTMLElement | null;
    if (itemT) { const c = itemT.closest(".mc-card") as HTMLElement; setItemEdit({ id: c.dataset.mc!, k: Number(itemT.dataset.item) }); return; }
    if (target.closest(".mc-add,.mc-itemform,input,button,a,select,textarea")) return;
    const card = target.closest(".mc-card") as HTMLElement | null;
    if (card) { const i = getDoc("canvas", card.dataset.mc!); if (!i) return; if (i.type === "board") setBoard(i.id); else openEdit(i.id, card); return; }
    if (tool === "select") createAt("note", at(e.clientX, e.clientY));
  };

  // ---- menus
  const cardMenu = (id: string, x: number, y: number) => {
    const i = getDoc("canvas", id); if (!i) return;
    const anchor = () => viewRef.current?.querySelector(`[data-mc="${CSS.escape(id)}"]`) || document.body;
    const items: MenuItem[] = [{ label: "Edit…", run: () => openEdit(id, anchor()) }];
    if (i.type === "board") items.push({ label: "Open board", run: () => setBoard(id) });
    if (i.type === "idea") {
      STAGES.forEach(s => items.push({ label: `Stage: ${STAGE_LABEL[s]}${(i.stage || "thought") === s ? " ✓" : ""}`, run: () => patch("canvas", id, { stage: s, updated: todayISO() }).catch(ui.error) }));
      if (!i.promoted) items.push({ label: "Promote to a project", run: () => promote(i) });
    }
    items.push("-", { label: "Colour", heading: true }, ...MC_COLORS.map(([c, l]) => ({ label: `${l}${(i.color || "") === c ? " ✓" : ""}`, run: () => { patch("canvas", id, { color: c }).catch(ui.error); } })));
    const parent = i.parent ? getDoc("canvas", i.parent) : undefined;
    items.push("-",
      { label: "Connect from here", run: () => { setTool("connect"); setFrom(id); } },
      { label: "Duplicate", run: () => { const { id: _i, version: _v, ...rest } = i; create("canvas", { ...rest, x: (i.x || 0) + 30, y: (i.y || 0) + 30, parent: i.parent || "", promoted: i.type === "idea" ? "" : rest.promoted }).catch(ui.error); } },
      { label: parent ? "Take out of column" : "Bring to front", run: () => {
        const max = Math.max(0, ...getColl("canvas").map(c => c.z || 0));
        patch("canvas", id, parent ? { parent: "", x: (parent.x || 0) + 280, y: parent.y || 0, z: max + 1 } : { z: max + 1 }).catch(ui.error);
      } },
      { label: i.type === "board" || i.type === "column" ? "Delete (cards inside are kept)" : "Delete", danger: true, run: () => del(i) });
    ui.menu(x, y, items);
  };
  const spaceMenu = (x: number, y: number) => {
    const p = at(x, y);
    ui.menu(x, y, [{ label: "Add here", heading: true }, ...CARD_TYPES.map(t => ({ label: `${MC_TYPES[t].icon}  ${MC_TYPES[t].label}`, run: () => createAt(t, p) })), "-", { label: "Fit board to view", run: fit }]);
  };
  const edgeMenu = (id: string, x: number, y: number) => {
    const e = getDoc("edges", id); if (!e) return;
    ui.menu(x, y, [
      ...EDGE_KINDS.map(([k, l]) => ({ label: `${l}${(e.kind || "relates") === k ? " ✓" : ""}`, run: () => { patch("edges", id, { kind: k }).catch(ui.error); } })),
      { label: "Edit label…", run: () => ui.pop(viewRef.current?.querySelector(`[data-edge="${CSS.escape(id)}"]`) || document.body,
        <EdgeLabelForm label={e.label || ""} onCancel={() => ui.close()} onSave={l => { ui.close(); patch("edges", id, { label: l }).catch(ui.error); }} />) },
      "-", { label: "Delete arrow", danger: true, run: () => removeWithUndo(ui, "edges", id, "Arrow deleted.").catch(ui.error) },
    ]);
  };
  const contextAt = (target: Element, x: number, y: number) => {
    const edge = target.closest(".mc-edge") as Element | null; if (edge) { edgeMenu(edge.getAttribute("data-edge")!, x, y); return true; }
    const card = target.closest(".mc-card") as HTMLElement | null; if (card) { cardMenu(card.dataset.mc!, x, y); return true; }
    if (target.closest(".mc-view")) { spaceMenu(x, y); return true; }
    return false;
  };
  const onContextMenu = (e: React.MouseEvent) => {
    if (inLayoutEdit(e.currentTarget)) return;
    const t = e.target as Element; if (t.closest("input,textarea,a")) return;
    if (contextAt(t, e.clientX, e.clientY)) e.preventDefault();
  };

  // ---- breadcrumbs
  const chain: Doc[] = []; for (let b = board, n = 0; b !== "root" && n < 50; n++) { const it = canvas.find(i => i.id === b); if (!it) break; chain.unshift(it); b = boardOf(it); }
  const hint = tool === "select" ? "Drag cards, drag empty space or hold the middle mouse button to pan, Ctrl + scroll to zoom. Double-click to edit; right-click for more."
    : tool === "connect" ? (from ? "Now click the card to connect to. Esc cancels." : "Click the card the arrow starts from.")
    : `Click the board to place a ${MC_TYPES[tool].label.toLowerCase()}.`;
  void edges; // subscribed so arrows redraw when edges change

  return <div className="mc ideas-board" onContextMenu={onContextMenu}>
    <aside className="mc-rail" role="toolbar" aria-label="Board tools">{RAIL.map(([k, l, ic, tip]) =>
      <button key={k} type="button" className={"tool" + (tool === k ? " on" : "")} title={tip} aria-pressed={tool === k} onClick={() => { setTool(k); setFrom(null); }}>
        <span className="ti" aria-hidden="true">{ic}</span><span className="tl">{l}</span></button>)}</aside>
    <div className="mc-main">
      <div className="mc-bar">
        <nav className="mc-crumbs" aria-label="Boards"><button type="button" className="btn link" onClick={() => setBoard("root")}>Ideas</button>
          {chain.map(c => <span key={c.id}> <span className="muted">/</span> <button type="button" className="btn link" onClick={() => setBoard(c.id)}>{c.title || "Board"}</button></span>)}</nav>
        <span className="hint">{hint}</span>
        <span className="mc-zoom"><button type="button" className="btn" onClick={() => zoomBy(-1)} aria-label="Zoom out">−</button><span className="mono small">{Math.round(cam.z * 100)}%</span>
          <button type="button" className="btn" onClick={() => zoomBy(1)} aria-label="Zoom in">+</button><button type="button" className="btn" onClick={fit}>Fit</button></span>
      </div>
      <div ref={viewRef} className={"mc-view tool-" + tool} data-board={board} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
        <div ref={worldRef} className="mc-world" style={{ transform: camCss(cam) }}>
          <svg className="mc-edges" aria-hidden="true"><defs><marker id="mc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--muted)" /></marker></defs><g ref={edgesRef} /></svg>
          {loose.map(i => <Card key={i.id} i={i} canvas={canvas} ctx={ctx} />)}
        </div>
        {!items.length && <div className="mc-blank"><b>An empty board.</b><span>Pick a card type on the left and click to place it, or right-click anywhere.</span></div>}
      </div>
    </div>
  </div>;
}
