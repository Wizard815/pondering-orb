import { ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Responsive, WidthProvider, Layout, Layouts } from "react-grid-layout";
import { useColl, put } from "../lib/store";
import { useUi } from "../lib/ui";

const Grid = WidthProvider(Responsive);
export const BREAKPOINTS = { lg: 1100, md: 760, sm: 0 };
export const COLS = { lg: 12, md: 8, sm: 1 };
const ROW = 40, MARGIN: [number, number] = [16, 16];

export type PanelDef = { key: string; title: string; node: ReactNode; act?: ReactNode; w?: number; h?: number; minH?: number };
type Saved = { layouts?: Layouts; hidden?: string[]; removed?: string[]; known?: string[] };

/** A page's panels on a 12-column grid. In edit mode panels move by their
 *  title and resize from the corner; right-click a panel to hide or remove
 *  it, right-click empty space to add one back. Each page keeps its own
 *  layout per screen size. */
export function PanelGrid({ page, panels, defaults, editing }: { page: string; panels: PanelDef[]; defaults?: string[]; editing: boolean }) {
  const ui = useUi();
  const saved = (useColl("layouts").find(d => d.id === page) || {}) as Saved;
  const keys = panels.map(p => p.key);
  const known = new Set(saved.known || []);
  // Panels never seen before appear (unless the page has an explicit default set);
  // panels the user removed stay removed.
  const removed = new Set((saved.removed || []).filter(k => keys.includes(k)));
  if (!saved.known) keys.forEach(k => { if (defaults && !defaults.includes(k)) removed.add(k); });
  else keys.forEach(k => { if (!known.has(k) && defaults && !defaults.includes(k)) removed.add(k); });
  const hidden = new Set(saved.hidden || []);
  const shown = panels.filter(p => !removed.has(p.key) && (editing || !hidden.has(p.key)));
  const latest = useRef<Layouts>({});
  // Panels without a saved layout get a height that fits their content (in
  // grid rows), measured after they render, so pages don't open full of
  // half-empty tall panels. Once you resize a panel its size is saved instead.
  const [fit, setFit] = useState<Record<string, number>>({});
  const root = useRef<HTMLDivElement>(null);
  // Which breakpoint is showing, from the column count the grid reports.
  const bp = useRef<keyof typeof COLS>(innerWidth >= BREAKPOINTS.lg ? "lg" : innerWidth >= BREAKPOINTS.md ? "md" : "sm");

  const layouts = useMemo(() => {
    const base: Layouts = {};
    for (const bp of Object.keys(COLS) as (keyof typeof COLS)[]) {
      const cols = COLS[bp], have = new Map((saved.layouts?.[bp] || []).map(l => [l.i, l]));
      // Panels without a saved spot are packed left to right, wrapping when a row is full.
      let y = Math.max(0, ...[...have.values()].map(l => l.y + l.h)), x = 0, rowH = 0;
      base[bp] = shown.map(p => {
        const l = have.get(p.key); if (l) return { ...l, w: Math.min(l.w, cols) };
        const w = Math.min(cols, bp === "lg" ? p.w || 6 : bp === "md" ? Math.min(8, Math.ceil((p.w || 6) * 8 / 12)) : 1), h = fit[p.key] ?? p.h ?? 8;
        if (x + w > cols) { y += rowH; x = 0; rowH = 0; }
        const item = { i: p.key, x, y, w, h, minH: p.minH || 3, minW: 1 }; x += w; rowH = Math.max(rowH, h); return item;
      });
    }
    return base;
  }, [JSON.stringify(saved.layouts), shown.map(p => p.key).join(","), editing, JSON.stringify(fit)]);

  // Panels load their data after they first render, so re-measure when what's
  // inside a panel changes size (a list arriving after "Loading…").
  const [, remeasure] = useState(0);
  useEffect(() => {
    if (!root.current || typeof ResizeObserver === "undefined") return;
    let t = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(t); t = requestAnimationFrame(() => remeasure(n => n + 1)); });
    const watch = () => root.current!.querySelectorAll<HTMLElement>(".gp[data-pk] .pbody > *").forEach(el => ro.observe(el));
    watch();
    const mo = new MutationObserver(watch); mo.observe(root.current, { childList: true, subtree: true });
    return () => { ro.disconnect(); mo.disconnect(); cancelAnimationFrame(t); };
  }, []);
  useLayoutEffect(() => {
    if (!root.current) return;
    const savedKeys = new Set((saved.layouts?.[bp.current] || []).map(l => l.i));
    const next: Record<string, number> = {};
    root.current.querySelectorAll<HTMLElement>(".gp[data-pk]").forEach(el => {
      const k = el.dataset.pk!; if (savedKeys.has(k)) return;
      const panel = el.querySelector<HTMLElement>(".panel"), body = el.querySelector<HTMLElement>(".pbody"); if (!panel || !body) return;
      // The body stretches to fill the panel, so measure where its content
      // ends rather than its own height (which never shrinks).
      const top = body.getBoundingClientRect().top - body.scrollTop, kids = [...body.children] as HTMLElement[];
      const content = kids.length ? Math.max(...kids.map(c => c.getBoundingClientRect().bottom)) - top + parseFloat(getComputedStyle(body).paddingBottom || "0") : 0;
      const px = panel.offsetHeight - body.clientHeight + content;
      const def = panels.find(p => p.key === k);
      const rows = Math.max(def?.minH || 3, Math.min(def?.h || 18, Math.ceil((px + MARGIN[1]) / (ROW + MARGIN[1]))));
      if (fit[k] !== rows) next[k] = rows;
    });
    if (Object.keys(next).length) setFit(f => ({ ...f, ...next }));
  });

  const save = (patch: Partial<Saved>) => put("layouts", page, { layouts: saved.layouts || layouts, hidden: [...hidden], removed: [...removed], known: keys, ...patch }).catch(ui.error);
  const onContext = (e: React.MouseEvent) => {
    if (!editing) return;
    const panel = (e.target as Element).closest("[data-pk]") as HTMLElement | null;
    e.preventDefault();
    if (panel) {
      const k = panel.dataset.pk!, isHidden = hidden.has(k);
      ui.menu(e.clientX, e.clientY, [
        { label: isHidden ? "Show panel" : "Hide panel", run: () => { isHidden ? hidden.delete(k) : hidden.add(k); save({}); } },
        { label: "Full width", run: () => setWidth(k, 12) }, { label: "Half width", run: () => setWidth(k, 6) },
        "-", { label: "Remove from page", danger: true, run: () => { removed.add(k); save({}); } },
      ]);
    } else {
      const avail = panels.filter(p => removed.has(p.key));
      ui.menu(e.clientX, e.clientY, [
        { label: avail.length ? "Add a panel" : "Every panel is on this page", heading: true },
        ...avail.map(p => ({ label: "+ " + p.title, run: () => { removed.delete(p.key); save({}); } })),
        "-", { label: "Reset this page", run: () => put("layouts", page, {}).catch(ui.error) },
      ]);
    }
  };
  const setWidth = (k: string, w: number) => {
    const b = bp.current, cur = latest.current[b] || layouts[b];
    save({ layouts: { ...layouts, ...(saved.layouts || {}), [b]: cur.map(l => (l.i === k ? { ...l, w: Math.min(w, COLS[b]) } : l)) } });
  };

  return <div ref={root} className={editing ? "editing" : ""} onContextMenu={onContext} style={{ minHeight: editing ? 240 : undefined, paddingBottom: editing ? 80 : 0 }}>
    {editing && <div className="tray" style={{ marginBottom: 12 }}><span className="small">Editing. Drag a panel by its title, drag the gold corner to resize. Right-click a panel to hide or remove it; right-click empty space to add one.</span></div>}
    <Grid className="layout" layouts={layouts} breakpoints={BREAKPOINTS} cols={COLS} rowHeight={ROW} margin={MARGIN} containerPadding={[0, 0]}
      isDraggable={editing} isResizable={editing} draggableHandle=".gp > .panel > h3" compactType="vertical"
      onLayoutChange={(_cur: Layout[], all: Layouts) => { latest.current = all; }}
      onWidthChange={(_w: number, _m: [number, number], cols: number) => { bp.current = cols === COLS.lg ? "lg" : cols === COLS.md ? "md" : "sm"; }}
      onDragStop={(l: Layout[]) => editing && save({ layouts: { ...layouts, ...(saved.layouts || {}), [bp.current]: l } })}
      onResizeStop={(l: Layout[]) => editing && save({ layouts: { ...layouts, ...(saved.layouts || {}), [bp.current]: l } })}>
      {shown.map(p => <div key={p.key} data-pk={p.key} className={"gp" + (hidden.has(p.key) ? " hiddenp" : "")}>
        <section className="panel"><h3>{p.title}{hidden.has(p.key) && editing ? <span className="hint"> (hidden)</span> : null}{!editing && p.act ? <span className="act">{p.act}</span> : null}</h3><div className="pbody">{p.node}</div></section>
      </div>)}
    </Grid>
    {!shown.length && <div className="empty">No panels. {editing ? "Right-click here to add one." : "Use Edit layout to add some."}</div>}
  </div>;
}
