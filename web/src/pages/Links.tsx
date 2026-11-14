import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PageDef } from "./types";
import { put, useColl } from "../lib/store";
import { useUi } from "../lib/ui";
import { useFetch } from "../lib/useFetch";
import { parseApps, DEFAULT_APPS } from "../lib/apps";
import { useDialog } from "../lib/useDialog";

/** Links: a grid of icons for every app with a web page. Containers come from
 *  the Unraid Management Agent (and Docker labels for Unraid's WebUI and
 *  icon); apps from the apps YAML; and links you add. Each can be hidden,
 *  renamed, given another address (a container port or any URL), put in a
 *  category and dragged into place. Saved in settings/links. */

type Port = { private: number; public: number; type: string };
type Found = { key: string; name: string; state: string; image: string; ports: Port[]; networkMode: string; icon: string; url: string; updateAvailable: boolean };
type Over = { name?: string; cat?: string; hidden?: boolean; mode?: "auto" | "port" | "url"; port?: number; scheme?: "http" | "https"; url?: string; icon?: string };
type Extra = { key: string; name: string; url: string; icon?: string; cat?: string };
type Cfg = { order: string[]; cats: string[]; items: Record<string, Over>; extra: Extra[] };
type Tile = { key: string; kind: "container" | "app" | "link"; name: string; cat: string; url: string; icon: string; rune: string; hidden: boolean; state: string; update: boolean; found?: Found; detected: string; over: Over; extra?: Extra };

const EMPTY: Cfg = { order: [], cats: [], items: {}, extra: [] };
const hue = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const runeOf = (n: string) => (n.replace(/[^A-Za-z0-9]/g, "").slice(0, 2) || "?").replace(/^./, c => c.toUpperCase());
const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : "");

function useLinks() {
  const doc = useColl("settings").find(d => d.id === "links"), host = typeof location !== "undefined" ? location.hostname : "";
  const found = useFetch<{ host: string; apps: Found[]; notes: string[]; sources: { unraid: boolean; docker: boolean } }>(`/api/links?host=${encodeURIComponent(host)}`, 60000);
  const yaml = useColl("settings").find(d => d.id === "apps")?.yaml as string | undefined;
  // Changes show at once and build on each other, so two quick edits can't undo one another.
  const [local, setLocal] = useState<Cfg | null>(null), inflight = useRef(0);
  const cfg: Cfg = local ?? ({ ...EMPTY, ...(doc || {}) } as Cfg);
  const latest = useRef(cfg); latest.current = cfg;
  const tiles = useMemo(() => {
    const out: Tile[] = [];
    const add = (t: Omit<Tile, "url" | "hidden" | "name" | "cat" | "icon" | "over"> & { name: string; cat: string; icon: string }) => {
      const o = cfg.items[t.key] || {}, f = t.found;
      const url = o.mode === "url" ? safeUrl(o.url || "") : o.mode === "port" && o.port ? `${o.scheme || "http"}://${found.data?.host || host}:${o.port}` : t.detected;
      out.push({ ...t, name: o.name || t.name, cat: o.cat || t.cat, icon: safeUrl(o.icon || "") || t.icon, url, hidden: !!o.hidden, over: o, update: !!f?.updateAvailable });
    };
    for (const f of found.data?.apps || []) add({ key: f.key, kind: "container", name: f.name, cat: "Server", icon: safeUrl(f.icon), rune: runeOf(f.name), state: f.state, update: f.updateAvailable, found: f, detected: safeUrl(f.url) });
    for (const g of parseApps(yaml ?? DEFAULT_APPS).groups) for (const a of g.apps) if (safeUrl(a.url)) add({ key: `app:${a.name}`, kind: "app", name: a.name, cat: g.name, icon: "", rune: a.rune || runeOf(a.name), state: "", update: false, detected: a.url });
    for (const e of cfg.extra) add({ key: e.key, kind: "link", name: e.name, cat: e.cat || "Links", icon: safeUrl(e.icon || ""), rune: runeOf(e.name), state: "", update: false, detected: safeUrl(e.url), extra: e });
    const pos = new Map(cfg.order.map((k, i) => [k, i]));
    return out.sort((a, b) => (pos.get(a.key) ?? 1e6) - (pos.get(b.key) ?? 1e6) || a.name.localeCompare(b.name));
  }, [JSON.stringify(cfg), found.data, yaml]);
  const cats = useMemo(() => [...new Set([...cfg.cats, ...tiles.map(t => t.cat)])], [tiles, cfg.cats.join("|")]);
  const save = (p: Partial<Cfg> | ((c: Cfg) => Partial<Cfg>)) => {
    const { id: _i, version: _v, ...cur } = latest.current as any, next: Cfg = { ...EMPTY, ...cur, ...(typeof p === "function" ? p(latest.current) : p) };
    latest.current = next; setLocal(next); inflight.current++;
    return put("settings", "links", next).finally(() => { if (--inflight.current === 0) setLocal(null); });
  };
  return { cfg, tiles, cats, found, save };
}

function Icon({ t }: { t: Tile }) {
  const [bad, setBad] = useState(false);
  return t.icon && !bad ? <img className="lk-img" src={t.icon} alt="" loading="lazy" referrerPolicy="no-referrer" draggable={false} onError={() => setBad(true)} />
    : <span className="lk-rune" style={{ background: `hsl(${hue(t.name)} 45% 42%)` }} aria-hidden="true">{t.rune}</span>;
}

// ---------------- editing one tile ----------------
function Editor({ t, cats, host, onSave, onRemove, onClose }: { t: Tile | null; cats: string[]; host: string; onSave: (o: Over, extra?: Extra) => void; onRemove?: () => void; onClose: () => void }) {
  const isNew = !t, ext = t?.extra;
  const [name, setName] = useState(t?.over.name || ext?.name || t?.name || ""), [cat, setCat] = useState(t?.cat || cats[0] || "Links"), [newCat, setNewCat] = useState("");
  const [mode, setMode] = useState<"auto" | "port" | "url">(isNew || t?.kind === "link" ? "url" : t?.over.mode || "auto");
  const [port, setPort] = useState(String(t?.over.port || t?.found?.ports.find(p => p.type === "tcp")?.public || "")), [scheme, setScheme] = useState(t?.over.scheme || "http");
  const [url, setUrl] = useState(t?.over.url || ext?.url || ""), [icon, setIcon] = useState(t?.over.icon || ext?.icon || ""), [hidden, setHidden] = useState(!!t?.hidden);
  const ports = (t?.found?.ports || []).filter(p => p.type === "tcp");
  const finalCat = cat === "__new" ? newCat.trim() || "Links" : cat;
  const ok = name.trim() && (mode !== "url" || safeUrl(url.trim())) && (mode !== "port" || /^\d{1,5}$/.test(port));
  const submit = (e: React.FormEvent) => { e.preventDefault(); if (!ok) return;
    if (isNew || t?.kind === "link") return onSave({ cat: finalCat, hidden }, { key: ext?.key || `lk:${Math.random().toString(36).slice(2, 10)}`, name: name.trim(), url: url.trim(), icon: icon.trim(), cat: finalCat });
    const base = t!.kind === "container" ? t!.found!.name : t!.key.slice(4); // the name it has without an override
    onSave({ name: name.trim() && name.trim() !== base ? name.trim() : undefined, cat: finalCat, hidden, mode, port: mode === "port" ? Number(port) : undefined, scheme: mode === "port" ? scheme : undefined, url: mode === "url" ? url.trim() : undefined, icon: icon.trim() || undefined });
  };
  const dlg = useDialog<HTMLDivElement>(onClose, ".lk-form input");
  return createPortal(<div ref={dlg} tabIndex={-1} className="lk-modal" role="dialog" aria-modal="true" aria-label={isNew ? "Add a link" : `Edit ${t!.name}`} onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <form className="lk-form panel" onSubmit={submit}>
      <h3>{isNew ? "Add a link" : `Edit ${t!.name}`}</h3>
      <label className="small">Name<input type="text" value={name} onChange={e => setName(e.target.value)} required /></label>
      <label className="small">Category<select value={cat} onChange={e => setCat(e.target.value)}>{cats.map(c => <option key={c} value={c}>{c}</option>)}<option value="__new">New category…</option></select></label>
      {cat === "__new" && <label className="small">New category<input type="text" value={newCat} onChange={e => setNewCat(e.target.value)} autoFocus /></label>}
      {!isNew && t!.kind !== "link" ? <fieldset className="lk-mode"><legend className="small">Link</legend>
        <label><input type="radio" checked={mode === "auto"} onChange={() => setMode("auto")} /> {t!.kind === "container" ? "Detected" : "From the apps list"}: <span className="mono small">{t!.detected || "none found"}</span></label>
        {t!.kind === "container" && <label><input type="radio" checked={mode === "port"} onChange={() => setMode("port")} /> A port on {host || "the server"}</label>}
        {mode === "port" && <div className="row">
          <select value={scheme} onChange={e => setScheme(e.target.value as any)} aria-label="Protocol"><option value="http">http</option><option value="https">https</option></select>
          {ports.length > 0 && <select value={ports.some(p => String(p.public || p.private) === port) ? port : ""} onChange={e => e.target.value && setPort(e.target.value)} aria-label="Container port">
            <option value="">Pick a port…</option>{ports.map(p => <option key={`${p.private}-${p.public}`} value={String(p.public || p.private)}>{p.public || p.private}{p.public && p.public !== p.private ? ` (container ${p.private})` : ""}</option>)}</select>}
          <input type="number" min={1} max={65535} value={port} onChange={e => setPort(e.target.value)} aria-label="Port" style={{ width: "7em" }} /></div>}
        <label><input type="radio" checked={mode === "url"} onChange={() => setMode("url")} /> Another address</label>
        {mode === "url" && <input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://plex.example.com" aria-label="Address" />}
      </fieldset> : <label className="small">Address<input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" required /></label>}
      <label className="small">Icon address (optional)<input type="url" value={icon} onChange={e => setIcon(e.target.value)} placeholder={t?.found?.icon || "https://…/icon.png"} /></label>
      <label className="small row"><input type="checkbox" checked={hidden} onChange={e => setHidden(e.target.checked)} /> Hidden</label>
      <div className="row"><button className="btn primary" type="submit" disabled={!ok}>Save</button><button className="btn" type="button" onClick={onClose}>Cancel</button>
        {onRemove && <button className="btn" type="button" onClick={onRemove}>Remove link</button>}</div>
    </form></div>, document.body);
}

// ---------------- the grid ----------------
function Portals() {
  const ui = useUi(), { cfg, tiles, cats, found, save } = useLinks();
  const [arrange, setArrange] = useState(false), [q, setQ] = useState(""), [edit, setEdit] = useState<Tile | "new" | null>(null);
  const [drag, setDrag] = useState<{ key: string; x: number; y: number } | null>(null), [drop, setDrop] = useState<{ key?: string; cat: string; after: boolean } | null>(null);
  const moved = useRef(false);
  const show = tiles.filter(t => (arrange || !t.hidden) && (!q || t.name.toLowerCase().includes(q.toLowerCase())));
  const setOver = (key: string, o: Over) => save(c => ({ items: { ...c.items, [key]: Object.fromEntries(Object.entries({ ...c.items[key], ...o }).filter(([, v]) => v !== undefined && v !== "")) } })).catch(ui.error);

  // Dragging works with a mouse, a finger or a pen: pointer events on the window, so it doesn't depend on HTML drag and drop.
  const latest = useRef({ tiles, cfg, cats, save }); latest.current = { tiles, cfg, cats, save };
  const dropRef = useRef<typeof drop>(null);
  const start = (e: React.PointerEvent, t: Tile) => {
    if (!arrange || e.button > 0 || (e.target as HTMLElement).closest(".lk-acts")) return;
    moved.current = false; const x0 = e.clientX, y0 = e.clientY;
    const mv = (ev: PointerEvent) => {
      if (!moved.current && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 8) return;
      if (!moved.current) { moved.current = true; setDrag({ key: t.key, x: x0, y: y0 }); }
      ev.preventDefault();
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null, tile = el?.closest<HTMLElement>("[data-lk]"), sec = el?.closest<HTMLElement>("[data-cat]");
      let d: typeof drop = null;
      if (tile && tile.dataset.lk !== t.key) { const r = tile.getBoundingClientRect(); d = { key: tile.dataset.lk, cat: tile.closest<HTMLElement>("[data-cat]")!.dataset.cat!, after: ev.clientX > r.left + r.width / 2 }; }
      else if (sec && !tile) d = { cat: sec.dataset.cat!, after: true };
      dropRef.current = d; setDrop(d);
    };
    const up = () => {
      removeEventListener("pointermove", mv); removeEventListener("pointerup", up); removeEventListener("pointercancel", up);
      const d = dropRef.current, { tiles, cfg, cats, save } = latest.current;
      if (moved.current && d) {
        const keys = tiles.map(x => x.key).filter(k => k !== t.key);
        const inCat = tiles.filter(x => x.cat === d.cat && x.key !== t.key);
        const at = d.key ? keys.indexOf(d.key) + (d.after ? 1 : 0) : inCat.length ? keys.indexOf(inCat[inCat.length - 1].key) + 1 : keys.length;
        keys.splice(at, 0, t.key);
        const extra = t.kind === "link" ? cfg.extra.map(x => (x.key === t.key ? { ...x, cat: d.cat } : x)) : cfg.extra;
        const items = t.kind === "link" ? cfg.items : { ...cfg.items, [t.key]: { ...cfg.items[t.key], cat: d.cat } };
        // Keep the places of apps not listed right now (a container whose server didn't answer).
        const listed = new Set(keys), order = [...keys, ...cfg.order.filter(k => !listed.has(k))];
        save({ order, items, extra, cats }).catch(ui.error);
      }
      dropRef.current = null; setDrag(null); setDrop(null);
    };
    addEventListener("pointermove", mv, { passive: false }); addEventListener("pointerup", up); addEventListener("pointercancel", up);
  };
  const addCat = () => { const n = prompt("Name of the new category"); if (n?.trim() && !cats.includes(n.trim())) save({ cats: [...cats, n.trim()] }).catch(ui.error); };
  const renameCat = (c: string) => { const n = prompt(`Rename “${c}” to`, c)?.trim(); if (!n || n === c) return;
    const items = { ...cfg.items }; for (const t of tiles) if (t.cat === c && t.kind !== "link") items[t.key] = { ...items[t.key], cat: n };
    save({ cats: cats.map(x => (x === c ? n : x)), items, extra: cfg.extra.map(x => ((x.cat || "Links") === c ? { ...x, cat: n } : x)) }).catch(ui.error); };
  const moveCat = (c: string, d: number) => { const i = cats.indexOf(c), j = i + d; if (j < 0 || j >= cats.length) return; const n = [...cats]; [n[i], n[j]] = [n[j], n[i]]; save({ cats: n }).catch(ui.error); };

  const notConnected = found.data && !found.data.sources.unraid && !found.data.sources.docker;
  return <div className={"lk" + (arrange ? " arranging" : "")}>
    <div className="row lk-bar">
      <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Find an app" aria-label="Find an app" />
      <button className={"btn" + (arrange ? " on" : "")} aria-pressed={arrange} disabled={!arrange && !found.data && !found.error} title={!found.data && !found.error ? "Waiting for the server's apps" : undefined} onClick={() => setArrange(!arrange)}>{arrange ? "Done arranging" : "Arrange"}</button>
      {arrange && <><button className="btn" onClick={() => setEdit("new")}>Add link</button><button className="btn" onClick={addCat}>New category</button></>}
      <span className="hint">{arrange ? "Drag icons to move them. ✎ edits, the eye shows or hides." : found.data ? `${tiles.filter(t => !t.hidden).length} links${found.data.sources.unraid ? " · from Unraid" : found.data.sources.docker ? " · from Docker" : ""}` : "Looking for apps…"}</span>
    </div>
    {notConnected && <div className="empty small">Connect the Unraid Management Agent in <a href="#config">Settings → Connections</a> to list every container here. Apps from the apps list and links you add show either way.</div>}
    {(found.data?.notes || []).map((n, k) => <div key={k} className="err-inline small">{n}</div>)}
    {cats.map(c => { const list = show.filter(t => t.cat === c); if (!list.length && !arrange) return null;
      return <section key={c} className={"lk-cat" + (drop && !drop.key && drop.cat === c ? " drop" : "")} data-cat={c}>
        <h4 className="group-name">{c}{arrange && <span className="lk-catbtns"><button className="btn" onClick={() => moveCat(c, -1)} aria-label={`Move ${c} up`}>↑</button><button className="btn" onClick={() => moveCat(c, 1)} aria-label={`Move ${c} down`}>↓</button><button className="btn" onClick={() => renameCat(c)}>Rename</button>{!tiles.some(t => t.cat === c) && <button className="btn" onClick={() => save({ cats: cats.filter(x => x !== c) }).catch(ui.error)}>Remove</button>}</span>}</h4>
        <div className="lk-grid">
          {list.map(t => { const cls = "lk-tile" + (t.hidden ? " hid" : "") + (drag?.key === t.key ? " dragging" : "") + (drop?.key === t.key ? (drop.after ? " drop-after" : " drop-before") : "");
            const body = <><Icon t={t} />{t.state && <i className={"lk-dot " + (t.state === "running" ? "up" : "down")} title={t.state} />}{t.update && <i className="lk-upd" title="Update available">↑</i>}<span className="lk-name">{t.name}</span></>;
            return <div key={t.key} className={cls} data-lk={t.key} onPointerDown={e => start(e, t)} onDragStart={e => { if (arrange) e.preventDefault(); }}>
              {arrange || !t.url ? <button className="lk-face" onClick={() => { if (!moved.current) setEdit(t); }} title={t.url || "No link yet: set one"}>{body}</button>
                : <a className="lk-face" href={t.url} target="_blank" rel="noopener noreferrer" title={t.url}>{body}</a>}
              {arrange && <span className="lk-acts"><button className="btn" onClick={() => setOver(t.key, { hidden: !t.hidden })} aria-label={t.hidden ? `Show ${t.name}` : `Hide ${t.name}`}>{t.hidden ? "◌" : "◉"}</button><button className="btn" onClick={() => setEdit(t)} aria-label={`Edit ${t.name}`}>✎</button></span>}
            </div>; })}
          {arrange && !list.length && <div className="hint lk-emptycat">Drag icons here.</div>}
        </div></section>; })}
    {!tiles.length && found.data && <div className="empty">No apps yet. Connect Unraid, add apps in Settings → Apps, or add a link.</div>}
    {edit && <Editor t={edit === "new" ? null : edit} cats={cats.length ? cats : ["Links"]} host={found.data?.host || location.hostname} onClose={() => setEdit(null)}
      onSave={(o, extra) => { const t = edit === "new" ? null : edit;
        const p = extra ? save({ extra: t ? cfg.extra.map(x => (x.key === extra.key ? extra : x)) : [...cfg.extra, extra], items: { ...cfg.items, [extra.key]: { ...cfg.items[extra.key], hidden: o.hidden } } }) : setOver(t!.key, o);
        Promise.resolve(p).then(() => setEdit(null), ui.error); }}
      onRemove={edit !== "new" && edit.kind === "link" ? () => save({ extra: cfg.extra.filter(x => x.key !== edit.key) }).then(() => setEdit(null), ui.error) : undefined} />}
  </div>;
}

export const LinksPage: PageDef = {
  id: "links", label: "Links", title: "Portals", flavor: "Every app with a web page, one click away.",
  usePanels: () => ({ panels: [{ key: "portals", title: "Apps", node: <Portals />, w: 12, h: 60 }] }),
};
