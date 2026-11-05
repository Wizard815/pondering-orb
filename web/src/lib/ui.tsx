import { createContext, ReactNode, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Menus, popups, confirmations and the Undo bar, shared by every page. */
export type MenuItem = { label: string; run?: () => void; danger?: boolean; disabled?: boolean; heading?: boolean } | "-";
type Floating = { kind: "menu"; x: number; y: number; items: MenuItem[] } | { kind: "pop"; x: number; y: number; node: ReactNode; onClose?: () => void };
type Ui = {
  menu: (x: number, y: number, items: MenuItem[]) => void;
  pop: (anchor: Element, node: ReactNode, onClose?: () => void) => void;
  close: () => void;
  confirm: (anchor: Element, text: ReactNode, ok: string, run: () => Promise<unknown> | unknown) => void;
  undo: (msg: string, undo?: () => Promise<unknown> | unknown) => void;
  status: (msg: string) => void;
  error: (e: unknown) => void;
};
const Ctx = createContext<Ui | null>(null);
export const useUi = () => useContext(Ctx)!;

function Place({ x, y, children, className }: { x: number; y: number; children: ReactNode; className: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => { const r = ref.current!.getBoundingClientRect(); setPos({ left: Math.max(8, Math.min(x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, innerHeight - r.height - 8)) }); }, [x, y]);
  useEffect(() => { ref.current?.querySelector<HTMLElement>("input:not([type=hidden]),select,textarea,button:not([disabled])")?.focus(); }, []);
  return <div ref={ref} className={className} style={pos} role={className === "cmenu" ? "menu" : "dialog"}>{children}</div>;
}

export function UiProvider({ children }: { children: ReactNode }) {
  const [fl, setFl] = useState<Floating | null>(null);
  const [bar, setBar] = useState<{ msg: string; undo?: () => unknown; key: number } | null>(null);
  const [statusMsg, setStatusMsg] = useState("");
  const flRef = useRef(fl); flRef.current = fl;
  const close = () => { const f = flRef.current; setFl(null); if (f && f.kind === "pop") f.onClose?.(); };
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!(e.target as Element).closest(".cmenu,.pop")) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    addEventListener("pointerdown", down, true); addEventListener("keydown", key); addEventListener("resize", close);
    return () => { removeEventListener("pointerdown", down, true); removeEventListener("keydown", key); removeEventListener("resize", close); };
  }, []);
  useEffect(() => { if (!bar) return; const t = setTimeout(() => setBar(null), 9000); return () => clearTimeout(t); }, [bar]);
  const ui: Ui = {
    menu: (x, y, items) => setFl({ kind: "menu", x, y, items }),
    pop: (anchor, node, onClose) => { const r = anchor.getBoundingClientRect(); setFl({ kind: "pop", x: r.left, y: r.bottom + 6, node, onClose }); },
    close,
    confirm: (anchor, text, ok, run) => ui.pop(anchor, <div className="pop-form" style={{ minWidth: "min(260px,80vw)" }}><div className="small">{text}</div>
      <div className="row"><button className="btn primary" onClick={async () => { setFl(null); try { await run(); } catch (e) { ui.error(e); } }}>{ok}</button><button className="btn" onClick={() => setFl(null)}>Cancel</button></div></div>),
    undo: (msg, undo) => setBar({ msg, undo, key: Date.now() }),
    status: setStatusMsg,
    error: e => setStatusMsg((e as any)?.message || String(e)),
  };
  return <Ctx.Provider value={ui}>
    {children}
    {fl && createPortal(fl.kind === "menu"
      ? <Place x={fl.x} y={fl.y} className="cmenu">{fl.items.map((it, i) => it === "-" ? <div key={i} className="sep" /> : it.heading ? <div key={i} className="mh">{it.label}</div> :
          <button key={i} type="button" role="menuitem" className={it.danger ? "danger" : ""} disabled={it.disabled} onClick={() => { setFl(null); it.run?.(); }}>{it.label}</button>)}</Place>
      : <Place x={fl.x} y={fl.y} className="pop">{fl.node}</Place>, document.body)}
    {bar && createPortal(<div className="undo-bar" role="status" key={bar.key}><span>{bar.msg}</span>
      {bar.undo && <button className="btn" onClick={async () => { const u = bar.undo; setBar(null); try { await u!(); setStatusMsg("Undone."); } catch (e) { ui.error(e); } }}>Undo</button>}
      <button className="undo-x" aria-label="Dismiss" onClick={() => setBar(null)}>×</button></div>, document.body)}
    <div className="status-line" style={{ paddingInline: "max(16px, env(safe-area-inset-left, 0px))" }}>{statusMsg}</div>
  </Ctx.Provider>;
}
