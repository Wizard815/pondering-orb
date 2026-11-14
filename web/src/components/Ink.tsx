import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useUi } from "../lib/ui";

/** Handwriting and drawing for the Journal. Works with a mouse, a finger, a
 *  drawing pad or a stylus (BOOX and other e-ink tablets: pressure is used,
 *  and once a pen is seen, touches are ignored so a resting palm leaves no
 *  marks). Strokes are vectors, so they can be erased and undone later; a page
 *  can sit on an image you brought in (a photo, a scan, a PDF page). */

export type InkPage = { id: string; w: number; h: number; bg?: string };
/** A stroke: tool, colour, base width and points as flat [x, y, pressure 0–255, ...] in page units. */
export type Stroke = { t: "pen" | "hl"; c: string; w: number; p: number[] };

export const PAGE_W = 1404, PAGE_H = 1872; // a BOOX Note Air page at 3:4
export const COLORS: [string, string][] = [["#1b1b1b", "Black"], ["#1f4fa8", "Blue"], ["#b0281c", "Red"], ["#2e7a4c", "Green"], ["#b8860b", "Gold"]];
const WIDTHS: [number, string][] = [[3, "Fine"], [6, "Medium"], [12, "Bold"]];

const imgCache = new Map<string, HTMLImageElement>();
function bgImage(id: string, onLoad: () => void) {
  let im = imgCache.get(id);
  if (!im) { im = new Image(); im.src = `/api/journal/files/${encodeURIComponent(id)}`; imgCache.set(id, im); }
  if (!im.complete) im.addEventListener("load", onLoad, { once: true });
  return im;
}

/** Draw one stroke; widths follow pen pressure. */
function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, from = 0) {
  const p = s.p; if (p.length < 3) return;
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = s.c;
  if (s.t === "hl") { ctx.globalAlpha = 0.3; ctx.globalCompositeOperation = "multiply"; }
  if (p.length === 3) { ctx.fillStyle = s.c; ctx.beginPath(); ctx.arc(p[0], p[1], (s.w * (0.4 + p[2] / 255)) / 2, 0, Math.PI * 2); ctx.fill(); ctx.restore(); return; }
  if (s.t === "hl") { // even width, one path, so overlaps don't darken
    ctx.lineWidth = s.w * 3; ctx.beginPath(); ctx.moveTo(p[0], p[1]); for (let i = 3; i < p.length; i += 3) ctx.lineTo(p[i], p[i + 1]); ctx.stroke(); ctx.restore(); return;
  }
  for (let i = Math.max(3, from * 3); i < p.length; i += 3) {
    ctx.lineWidth = s.w * (0.4 + p[i + 2] / 255 * 1.1);
    ctx.beginPath(); ctx.moveTo(p[i - 3], p[i - 2]); ctx.lineTo(p[i], p[i + 1]); ctx.stroke();
  }
  ctx.restore();
}
export function paint(ctx: CanvasRenderingContext2D, page: InkPage, strokes: Stroke[], scale: number, bg?: HTMLImageElement | null) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#fffdf7"; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  if (bg && bg.complete && bg.naturalWidth) ctx.drawImage(bg, 0, 0, page.w, page.h);
  for (const s of strokes) drawStroke(ctx, s);
}
/** Drop points closer than ~1.2 page units to the last one kept. */
const simplify = (p: number[]) => { const out = p.slice(0, 3); for (let i = 3; i < p.length; i += 3) { const dx = p[i] - out[out.length - 3], dy = p[i + 1] - out[out.length - 2]; if (dx * dx + dy * dy > 1.5 || i === p.length - 3) out.push(p[i], p[i + 1], p[i + 2]); } return out; };
const hits = (s: Stroke, x: number, y: number, r: number) => { for (let i = 0; i < s.p.length; i += 3) { const dx = s.p[i] - x, dy = s.p[i + 1] - y; if (dx * dx + dy * dy <= r * r) return true; } return false; };

export type Tool = { kind: "pen" | "hl" | "erase"; color: string; width: number };

/** One copy of each page's strokes, shared by every view of it (the page in
 *  the list and its full-screen view), so neither overwrites the other. */
type Shared = { strokes: Stroke[]; loaded: boolean; failed: string; undo: Stroke[][]; redo: Stroke[][]; views: Set<() => void> };
const pagesInk = new Map<string, Shared>();
/** Load (or load again) a page's strokes. Only "not found" means a blank page:
 *  any other failure keeps the page closed, so a stroke can't overwrite what's saved. */
function load(id: string, v: Shared) {
  v.failed = ""; v.loaded = false; v.views.forEach(f => f());
  api<any>("GET", `/api/c/ink/${encodeURIComponent(id)}`).then(d => { v.strokes = Array.isArray(d?.strokes) ? d.strokes : []; v.loaded = true; },
    e => { if (e instanceof ApiError && e.status === 404) { v.strokes = []; v.loaded = true; } else v.failed = e?.message || "Couldn't open this page."; })
    .finally(() => v.views.forEach(f => f()));
}
function shared(id: string): Shared {
  let s = pagesInk.get(id);
  if (!s) { s = { strokes: [], loaded: false, failed: "", undo: [], redo: [], views: new Set() }; pagesInk.set(id, s); load(id, s); }
  return s;
}
/** The strokes as drawn here (including any not saved yet), or null if the page isn't open. */
export const strokesOf = (id: string) => { const s = pagesInk.get(id); return s?.loaded ? s.strokes : null; };
/** Forget a deleted page. */
export const forgetInk = (id: string) => { pagesInk.delete(id); };

/** One drawing page. Loads and saves its own strokes (record "ink/<page id>"). */
export type InkActions = { undo: () => void; redo: () => void; clear: () => void };
/** The page the toolbar acts on: a ref each canvas hands over when touched and takes back when it goes. */
export type ActiveInk = { current: InkActions | null };
export function InkCanvas({ page, day, tool, penOnly, onPen, onActive, onGone, big }: { page: InkPage; day: string; tool: Tool; penOnly: boolean; onPen: () => void; onActive: (a: ActiveInk) => void; onGone: (a: ActiveInk) => void; big?: boolean }) {
  const ui = useUi(), wrap = useRef<HTMLDivElement>(null), cv = useRef<HTMLCanvasElement>(null);
  // Undo and Redo live with the page, so the page and its full-screen view share them.
  const ink = shared(page.id), undo = { get current() { return ink.undo; } }, redo = { get current() { return ink.redo; }, set current(v: Stroke[][]) { ink.redo = v; } };
  const strokes = { get current() { return ink.strokes; }, set current(v: Stroke[]) { ink.strokes = v; } };
  const cur = useRef<{ s: Stroke; id: number; erased?: boolean } | null>(null), scale = useRef(1), dirty = useRef(false), timer = useRef<number>(0);
  const [, force] = useState(0), loaded = ink.loaded;

  const redraw = useCallback(() => {
    const c = cv.current; if (!c) return; const ctx = c.getContext("2d")!;
    paint(ctx, page, pagesInk.get(page.id)?.strokes || [], scale.current, page.bg ? bgImage(page.bg, () => redraw()) : null);
  }, [page.id, page.bg, page.w, page.h]);

  // Redraw when another view of this page changes it (or when it loads).
  useEffect(() => { const f = () => { redraw(); force(x => x + 1); }; ink.views.add(f); if (ink.loaded) redraw(); return () => { ink.views.delete(f); }; }, [page.id, redraw]);
  const changed = () => ink.views.forEach(f => f());

  // Fit the canvas to its box, sharp on high-density screens.
  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const fit = () => {
      const c = cv.current!, dpr = Math.min(window.devicePixelRatio || 1, 2), box = el.getBoundingClientRect();
      const w = big ? Math.min(box.width, (box.height || window.innerHeight) * page.w / page.h) : box.width;
      c.style.width = `${w}px`; c.style.height = `${w * page.h / page.w}px`;
      c.width = Math.round(w * dpr); c.height = Math.round(w * page.h / page.w * dpr); scale.current = c.width / page.w; redraw();
    };
    fit(); const ro = new ResizeObserver(fit); ro.observe(el); return () => ro.disconnect();
  }, [page.id, page.w, page.h, big, redraw]);

  const save = useCallback((now = false) => {
    dirty.current = true; clearTimeout(timer.current);
    const go = () => { if (!dirty.current) return; dirty.current = false;
      api("PUT", `/api/c/ink/${encodeURIComponent(page.id)}`, { day, strokes: strokes.current }).catch(e => { dirty.current = true; ui.error(e); }); };
    if (now) go(); else timer.current = window.setTimeout(go, 1200);
  }, [page.id, day]);
  useEffect(() => () => { if (dirty.current) save(true); }, [save]);

  const at = (e: PointerEvent | React.PointerEvent) => { const r = cv.current!.getBoundingClientRect(), k = page.w / r.width; return [Math.round((e.clientX - r.left) * k), Math.round((e.clientY - r.top) * k), Math.round(((e.pointerType === "pen" ? e.pressure : 0.5) || 0.5) * 255)]; };
  const commit = (next: Stroke[]) => { undo.current.push(strokes.current); if (undo.current.length > 60) undo.current.shift(); redo.current = []; strokes.current = next; save(); changed(); };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "pen") onPen();
    if (!loaded || (penOnly && e.pointerType === "touch") || e.button > 0) return;
    e.preventDefault(); cv.current!.setPointerCapture(e.pointerId);
    const p = at(e);
    if (tool.kind === "erase") { cur.current = { s: { t: "pen", c: "", w: 0, p: [] }, id: e.pointerId }; eraseAt(p[0], p[1]); return; }
    cur.current = { s: { t: tool.kind, c: tool.color, w: tool.width, p }, id: e.pointerId };
    const ctx = cv.current!.getContext("2d")!; ctx.setTransform(scale.current, 0, 0, scale.current, 0, 0); drawStroke(ctx, cur.current.s);
  };
  const eraseAt = (x: number, y: number) => { const r = 14 + tool.width, keep = strokes.current.filter(s => !hits(s, x, y, r)); if (keep.length === strokes.current.length) return;
    // One undo step per eraser stroke, and only once it has erased something.
    if (cur.current && !cur.current.erased) { cur.current.erased = true; undo.current.push(strokes.current); if (undo.current.length > 60) undo.current.shift(); redo.current = []; }
    strokes.current = keep; changed(); save(); };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = cur.current; if (!c || c.id !== e.pointerId) return;
    const evs = (e.nativeEvent as any).getCoalescedEvents?.() || [e.nativeEvent];
    if (tool.kind === "erase") { for (const ev of evs) { const p = at(ev); eraseAt(p[0], p[1]); } return; }
    const ctx = cv.current!.getContext("2d")!; ctx.setTransform(scale.current, 0, 0, scale.current, 0, 0);
    const n = c.s.p.length / 3; for (const ev of evs) c.s.p.push(...at(ev));
    if (c.s.t === "hl") { redraw(); drawStroke(ctx, c.s); } else drawStroke(ctx, c.s, n);
  };
  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = cur.current; if (!c || c.id !== e.pointerId) return; cur.current = null;
    if (tool.kind === "erase") { force(x => x + 1); return; }
    commit([...strokes.current, { ...c.s, p: simplify(c.s.p) }]);
  };

  const doUndo = () => { const prev = undo.current.pop(); if (!prev) return; redo.current.push(strokes.current); strokes.current = prev; changed(); save(); };
  const doRedo = () => { const next = redo.current.pop(); if (!next) return; undo.current.push(strokes.current); strokes.current = next; changed(); save(); };
  const clear = () => { if (strokes.current.length) commit([]); };
  // The toolbar's Undo, Redo and Clear act on the page you last touched (or the one full screen).
  const mine = useRef<InkActions | null>(null); mine.current = { undo: doUndo, redo: doRedo, clear };
  useEffect(() => { if (big) onActive(mine); }, [big]);
  useEffect(() => () => { mine.current = null; onGone(mine); }, []);

  return <div ref={wrap} className={"ink-wrap" + (big ? " big" : "")} onPointerDownCapture={() => onActive(mine)}>
    <canvas ref={cv} className={"ink-canvas" + (tool.kind === "erase" ? " erasing" : "")} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      role="img" aria-label={`Drawing page${page.bg ? " on an imported image" : ""}`} />
    {!loaded && !ink.failed && <div className="ink-loading hint">Opening the page…</div>}
    {ink.failed && <div className="ink-loading err-inline small">{ink.failed} <button className="btn" onClick={() => load(page.id, ink)}>Try again</button></div>}
  </div>;
}

/** The pen, highlighter and eraser controls. */
export function InkTools({ tool, setTool, penOnly, setPenOnly, act, children }: { tool: Tool; setTool: (t: Tool) => void; penOnly: boolean; setPenOnly: (v: boolean) => void; act: (k: keyof InkActions) => void; children?: React.ReactNode }) {
  return <div className="ink-tools" role="toolbar" aria-label="Drawing tools">
    {([["pen", "Pen"], ["hl", "Highlighter"], ["erase", "Eraser"]] as const).map(([k, l]) => <button key={k} className={"btn" + (tool.kind === k ? " on" : "")} aria-pressed={tool.kind === k} onClick={() => setTool({ ...tool, kind: k })}>{l}</button>)}
    <span className="ink-sep" />
    {COLORS.map(([c, l]) => <button key={c} className={"ink-color" + (tool.color === c ? " on" : "")} style={{ background: c }} aria-label={l} aria-pressed={tool.color === c} onClick={() => setTool({ ...tool, color: c, kind: tool.kind === "erase" ? "pen" : tool.kind })} />)}
    <span className="ink-sep" />
    <select value={tool.width} onChange={e => setTool({ ...tool, width: Number(e.target.value) })} aria-label="Line width">{WIDTHS.map(([w, l]) => <option key={w} value={w}>{l}</option>)}</select>
    <button className="btn" onClick={() => act("undo")}>Undo</button><button className="btn" onClick={() => act("redo")}>Redo</button>
    <label className="small ink-pen" title="Ignore finger touches, so your palm can rest on the screen"><input type="checkbox" checked={penOnly} onChange={e => setPenOnly(e.target.checked)} /> Pen only</label>
    {children}
  </div>;
}
