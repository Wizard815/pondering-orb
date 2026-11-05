import { useEffect, useMemo, useState } from "react";
import type { PageDef } from "./types";
import { get, post } from "../lib/api";
import { useFetch } from "../lib/useFetch";
import { useUi } from "../lib/ui";
import { mdToHtml } from "../lib/markdown";

type Meta = { path: string; title: string; type?: string; area?: string; project_status?: string; status?: string; tags?: string[]; updated?: string };
type Note = Meta & { body: string };
const PARA: [string, string][] = [["wiki/1-projects/", "Projects"], ["wiki/2-areas/", "Areas"], ["wiki/3-resources/", "Resources"], ["wiki/4-archive/", "Archive"], ["wiki/logs/", "Logs"]];

// The open note is shared between panels on this page.
let openPath = "", setters = new Set<(p: string) => void>();
const openNote = (p: string) => { openPath = p; setters.forEach(f => f(p)); };
function useOpen() { const [p, setP] = useState(openPath); useEffect(() => { setters.add(setP); return () => { setters.delete(setP); }; }, []); return p; }

function section(body: string, heading: string) {
  const lines = body.split("\n"), i = lines.findIndex(l => /^##\s/.test(l) && l.replace(/^#+\s*/, "").trim().toLowerCase() === heading.toLowerCase());
  if (i < 0) return ""; let j = i + 1; while (j < lines.length && !/^#{1,2}\s/.test(lines[j])) j++;
  return lines.slice(i + 1, j).join("\n").trim();
}

function Vault({ tree }: { tree: Meta[] }) {
  const cur = useOpen();
  const other = useMemo(() => [...new Set(tree.map(n => n.path.split("/").slice(0, -1).join("/") + "/").filter(f => !PARA.some(([p]) => f.startsWith(p))))], [tree]);
  const groups: [string, string][] = [...PARA, ...other.map(f => [f, f.replace(/\/$/, "") + " (read only)"] as [string, string])];
  return <>{groups.map(([pre, label]) => { const notes = tree.filter(n => n.path.startsWith(pre) && n.path.slice(pre.length).indexOf("/") < 0).sort((a, b) => a.title.localeCompare(b.title));
    return <div key={pre}><h4 className="group-name">{label}</h4><ul className="note-list">{notes.length ? notes.map(n => <li key={n.path}><button aria-current={cur === n.path} onClick={() => openNote(n.path)}><span className="grow">{n.title}</span></button></li>) : <li className="empty small">Empty</li>}</ul></div>; })}</>;
}

function NoteView() {
  const ui = useUi(), path = useOpen(), [note, setNote] = useState<Note | null>(null), [err, setErr] = useState(""), [edit, setEdit] = useState<{ heading: string; text: string } | null>(null);
  useEffect(() => { if (!path) return; setNote(null); setEdit(null); get<Note>(`/api/wiki/note?path=${encodeURIComponent(path)}`).then(n => { setNote(n); setErr(""); }).catch(e => setErr(e.message)); }, [path]);
  if (!path) return <div className="empty">Pick a note on the left.</div>;
  if (err) return <div className="err-inline">{err}</div>;
  if (!note) return <div className="hint">Opening…</div>;
  const writable = note.path.startsWith("wiki/") && note.type === "project";
  return <>
    <div className="fm"><span className="src">{note.path}</span>{note.type && <span className="pill"><i />{note.type}</span>}{note.area && <span className="pill"><i />area: {note.area}</span>}
      {note.project_status && <span className="pill info"><i />project_status: {note.project_status}</span>}{note.status && <span className="pill"><i />status: {note.status}</span>}
      {(note.tags || []).map(t => <span key={t} className="src">#{t}</span>)}{note.updated && <span className="hint">updated {note.updated}</span>}</div>
    {writable && <div className="row">{["Current state", "Next steps"].map(h => <button key={h} className="btn" onClick={() => setEdit({ heading: h, text: section(note.body, h) })}>Edit {h}</button>)}</div>}
    {edit && <form className="editor" onSubmit={async e => { e.preventDefault(); try { setNote(await post<Note>("/api/wiki/section", { path: note.path, heading: edit.heading, text: edit.text })); setEdit(null); ui.status("Section saved and logged in the wiki."); } catch (x) { ui.error(x); } }}>
      <label className="hint">{edit.heading} (replaces only this section; the edit is logged in today's wiki log)</label>
      <textarea rows={6} value={edit.text} onChange={e => setEdit({ ...edit, text: e.target.value })} autoFocus />
      <div className="row"><button className="btn primary" type="submit">Save section</button><button className="btn" type="button" onClick={() => setEdit(null)}>Cancel</button></div></form>}
    <div className="md mdc" dangerouslySetInnerHTML={{ __html: mdToHtml(note.body) }} />
  </>;
}

function Search({ tree }: { tree: Meta[] }) {
  const [q, setQ] = useState(""), [hits, setHits] = useState<{ path: string; snippet: string }[] | null>(null), [err, setErr] = useState("");
  const local = q.trim() ? tree.filter(n => n.title.toLowerCase().includes(q.toLowerCase())).slice(0, 10) : [];
  return <><form className="row" onSubmit={async e => { e.preventDefault(); if (!q.trim()) return; try { setHits(await get(`/api/wiki/search?q=${encodeURIComponent(q)}`)); setErr(""); } catch (x: any) { setErr(x.message); } }}>
      <input type="search" value={q} onChange={e => { setQ(e.target.value); setHits(null); }} placeholder="Search titles; Enter searches the text" aria-label="Search the wiki" style={{ flex: 1 }} /><button className="btn" type="submit">Search text</button></form>
    {err && <div className="err-inline">{err}</div>}
    {local.length > 0 && <ul className="list">{local.map(n => <li key={n.path}><button className="btn link" onClick={() => openNote(n.path)}>{n.title}</button> <span className="src">{n.path.split("/").slice(0, -1).join("/")}</span></li>)}</ul>}
    {hits && (hits.length ? <ul className="list">{hits.slice(0, 20).map(h => <li key={h.path}><div className="grow"><button className="btn link" onClick={() => openNote(h.path)}>{h.path.split("/").pop()?.replace(/\.md$/, "")}</button>{h.snippet && <div className="small muted">…{h.snippet}…</div>}</div></li>)}</ul> : <div className="empty">No notes match.</div>)}</>;
}

function Tags({ tree }: { tree: Meta[] }) {
  const [tag, setTag] = useState("");
  const counts = useMemo(() => { const c: Record<string, number> = {}; tree.forEach(n => (n.tags || []).forEach(t => (c[t] = (c[t] || 0) + 1))); return Object.entries(c).sort((a, b) => b[1] - a[1]); }, [tree]);
  return <><div className="chips">{counts.map(([t, n]) => <button key={t} aria-pressed={tag === t} onClick={() => setTag(tag === t ? "" : t)}>#{t} <span className="mono">{n}</span></button>)}</div>
    {tag && <ul className="list">{tree.filter(n => (n.tags || []).includes(tag)).map(n => <li key={n.path}><button className="btn link" onClick={() => openNote(n.path)}>{n.title}</button></li>)}</ul>}</>;
}

export const WikiPage: PageDef = {
  id: "wiki", label: "Wiki", title: "Library", flavor: "Your LLMWIKI vault, sorted by PARA.",
  usePanels: () => {
    const { data, error } = useFetch<{ mount: boolean; notes: Meta[] }>("/api/wiki/tree", 120000);
    const tree = data?.notes || [];
    useEffect(() => { if (!openPath && tree.length) { const first = tree.find(n => n.path.startsWith("wiki/1-projects/")) || tree[0]; openNote(first.path); } }, [tree.length]);
    const extra = error ? <span className="pill warn" title={error}><i />Wiki not reachable</span> : data ? <span className={"pill " + (data.mount ? "ok" : "info")}><i />{data.mount ? "Reading the vault mount" : "Reading over the REST API"}</span> : null;
    const panels = error
      ? [{ key: "vault", title: "Vault", w: 12, h: 4, node: <div className="err-inline">{error}</div> }]
      : [
        { key: "vault", title: "Vault", w: 3, h: 16, node: <Vault tree={tree} /> },
        { key: "note", title: "Note", w: 9, h: 16, node: <NoteView /> },
        { key: "search", title: "Search", w: 6, h: 7, node: <Search tree={tree} /> },
        { key: "tags", title: "Tags", w: 6, h: 7, node: <Tags tree={tree} /> },
      ];
    return { panels, extra };
  },
};
