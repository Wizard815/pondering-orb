import { useEffect, useState } from "react";
import { PAGES, pageById } from "./pages";
import type { PageDef } from "./pages/types";
import { PanelGrid } from "./components/PanelGrid";
import { Orb } from "./components/Orb";
import { useColl, useOnline, useSettings, saveSettings } from "./lib/store";
import { useUi } from "./lib/ui";
import { applyAppearance } from "./lib/theme";
import { choreState } from "./lib/util";
import { ProjectPage } from "./pages/Project";
import { EditButton } from "./components/EditButton";
import { OutboxPill } from "./components/Outbox";

function useHash() {
  const [h, setH] = useState(location.hash.slice(1));
  useEffect(() => { const f = () => setH(location.hash.slice(1)); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  return h;
}

function Summary() {
  const projects = useColl("projects"), chores = useColl("chores");
  const active = projects.filter(p => p.status === "active" && !p.archived).length, blocked = projects.filter(p => p.status === "blocked" && !p.archived).length;
  const st = chores.filter(c => c.lastDone).map(choreState), over = st.filter(s => s.cls === "over").length, soon = st.filter(s => s.cls === "soon").length;
  return <div className="summary">
    <span className="pill info"><i />{active} active</span>
    {blocked > 0 && <span className="pill bad"><i />{blocked} blocked</span>}
    {over ? <span className="pill bad"><i />{over} overdue</span> : <span className="pill ok"><i />Chores on track</span>}
    {soon > 0 && <span className="pill warn"><i />{soon} due soon</span>}
    <OutboxPill />
  </div>;
}

/** One page: its heading and its panel grid. */
function PageView({ page, editing, setEditing, inSplit }: { page: PageDef; editing: boolean; setEditing: (b: boolean) => void; inSplit?: boolean }) {
  const { panels, defaults, extra, head } = page.usePanels();
  return <div className="room">
    {head ?? <div className="room-head"><div className="titles"><h2>{page.title}</h2><span className="flavor">{page.flavor}</span></div>
      <div className="row">{extra}{!inSplit && <EditButton editing={editing} setEditing={setEditing} />}</div></div>}
    <PanelGrid key={page.id} page={page.id} panels={panels} defaults={defaults} editing={editing} />
  </div>;
}

export function App() {
  const hash = useHash(), settings = useSettings(), online = useOnline(), ui = useUi();
  const [editing, setEditing] = useState(false);
  const [dragTab, setDragTab] = useState<string | null>(null);
  const [ratio, setRatio] = useState<number | null>(null);
  useEffect(() => applyAppearance(settings), [JSON.stringify(settings)]);
  useEffect(() => setEditing(false), [hash]);

  const links: [string, string][] = (settings.links || []).filter((l: any) => Array.isArray(l) && l.length === 2 && l.every((x: string) => pageById(x)) && l[0] !== l[1]);
  const projectId = /^p-/.test(hash) ? hash.slice(2) : null;
  let tab = projectId ? "projects" : hash.includes("--") ? hash.split("--")[0] : pageById(hash) ? hash : "main";
  const link = projectId ? null : links.find(l => l.includes(tab)) || null;
  const linkId = link ? link.join("--") : "";
  const r = ratio ?? (settings.splitRatio?.[linkId] ?? 0.5);

  const tabs: { id: string; label: string; linked?: boolean }[] = [];
  const seen = new Set<string>();
  for (const p of PAGES) { if (seen.has(p.id)) continue; const l = links.find(z => z.includes(p.id));
    if (l) { l.forEach(x => seen.add(x)); tabs.push({ id: l.join("--"), label: l.map(x => pageById(x)!.label).join(" / "), linked: true }); }
    else tabs.push({ id: p.id, label: p.label }); }
  const current = link ? linkId : tab;

  const tabMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    if (!id.includes("--")) return ui.menu(e.clientX, e.clientY, [{ label: "Drag this tab onto another tab to show both side by side.", heading: true }]);
    const [a, b] = id.split("--");
    ui.menu(e.clientX, e.clientY, [
      { label: `Unlink ${pageById(a)!.label} and ${pageById(b)!.label}`, run: () => { const before = links; saveSettings({ links: links.filter(l => l.join("--") !== id) }).then(() => ui.undo("Tabs unlinked.", () => saveSettings({ links: before }))).catch(ui.error); location.hash = a; } },
      { label: "Swap sides", run: () => { saveSettings({ links: links.map(l => (l.join("--") === id ? [l[1], l[0]] : l)) }).catch(ui.error); location.hash = `${b}--${a}`; } },
    ]);
  };
  const dropTab = (target: string) => {
    if (!dragTab || dragTab === target || target.includes("--")) return;
    saveSettings({ links: [...links.filter(l => !l.includes(dragTab) && !l.includes(target)), [target, dragTab]] }).catch(ui.error);
    location.hash = `${target}--${dragTab}`; setDragTab(null);
  };
  const startSlide = (e: React.PointerEvent) => {
    const split = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect(); (e.currentTarget as Element).setPointerCapture(e.pointerId);
    let v = r;
    const mv = (ev: PointerEvent) => { v = Math.max(0.2, Math.min(0.8, (ev.clientX - split.left) / split.width)); setRatio(v); };
    const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); saveSettings({ splitRatio: { ...(settings.splitRatio || {}), [linkId]: Math.round(v * 1000) / 1000 } }).then(() => setRatio(null)).catch(ui.error); };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  };

  let body;
  if (projectId) body = <ProjectPage id={projectId} editing={editing} setEditing={setEditing} />;
  else if (link) {
    const [a, b] = link.map(x => pageById(x)!);
    body = <>
      <div className="split-bar"><span className="small muted">{a.label} and {b.label} are linked. Right-click the tab to unlink.</span><EditButton editing={editing} setEditing={setEditing} /></div>
      <div className="split" style={{ ["--r" as any]: r }}>
        <div className="half"><PageView key={a.id} page={a} editing={editing} setEditing={setEditing} inSplit /></div>
        <div className="divider" role="separator" aria-orientation="vertical" tabIndex={0} aria-valuenow={Math.round(r * 100)} title="Drag to resize. Double-click to reset."
          onPointerDown={startSlide} onDoubleClick={() => saveSettings({ splitRatio: { ...(settings.splitRatio || {}), [linkId]: 0.5 } })}><span /></div>
        <div className="half"><PageView key={b.id} page={b} editing={editing} setEditing={setEditing} inSplit /></div>
      </div></>;
  } else body = <PageView key={tab} page={pageById(tab)!} editing={editing} setEditing={setEditing} />;

  return <>
    {!online && <div className="pill bad offline"><i />Lost the connection to the server. Retrying…</div>}
    <header className="top"><div className="top-in">
      <div className="brand-row">
        <div className="brand"><Orb /><div><h1>Pondering Orb</h1><div className="sub">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</div></div></div>
        <Summary />
      </div>
      <nav className="tabs" aria-label="Rooms">
        {tabs.map(t => <a key={t.id} href={"#" + t.id} className={(t.linked ? "linked" : "") + (dragTab && dragTab !== t.id ? "" : "")} aria-current={current === t.id ? "page" : undefined}
          draggable={!t.linked} onDragStart={() => setDragTab(t.id)} onDragEnd={() => setDragTab(null)}
          onDragOver={e => { if (dragTab && !t.linked && t.id !== dragTab) { e.preventDefault(); e.currentTarget.classList.add("tab-drop"); } }}
          onDragLeave={e => e.currentTarget.classList.remove("tab-drop")}
          onDrop={e => { e.preventDefault(); e.currentTarget.classList.remove("tab-drop"); dropTab(t.id); }}
          onContextMenu={e => tabMenu(e, t.id)}>{t.label}</a>)}
      </nav>
    </div></header>
    <main>{body}</main>
  </>;
}
