import { useState } from "react";
import type { PageDef } from "./types";
import { useColl } from "../lib/store";
import { useFetch } from "../lib/useFetch";
import { ago, sortTasks } from "../lib/util";
import { TaskRows, fromOmi } from "../components/Common";
import type { App } from "../lib/apps";

/** Omi's full page, turned on with `page: true` (or a tab name) in its widget
 *  in the apps YAML. Read only. Firefly III's page is in Finances.tsx. */
// ---------------- Omi ----------------
function Days({ app }: { app: App }) {
  const [i, setI] = useState(0), { data, error } = useFetch<any[]>(`/api/apps/${encodeURIComponent(app.name)}/omi/days?limit=30`, 10 * 60000);
  if (error) return <div className="err-inline">{error}</div>;
  if (!data) return <div className="hint">Listening back…</div>;
  if (!data.length) return <div className="empty">No daily summaries yet.</div>;
  const d = data[Math.min(i, data.length - 1)], st = d.stats || {};
  return <>
    <div className="row"><button className="btn" disabled={i >= data.length - 1} onClick={() => setI(i + 1)} aria-label="Earlier day">‹</button>
      <select value={i} onChange={e => setI(Number(e.target.value))} aria-label="Day">{data.map((x, k) => <option key={k} value={k}>{x.date} {x.emoji} {x.headline.slice(0, 40)}</option>)}</select>
      <button className="btn" disabled={i <= 0} onClick={() => setI(i - 1)} aria-label="Later day">›</button></div>
    <div className="omi-head"><b>{d.emoji} {d.headline || "Your day"}</b></div><div className="hint">{d.date}{st.total_conversations ? ` · ${st.total_conversations} conversations` : ""}{st.total_duration_minutes ? ` · ${st.total_duration_minutes} min` : ""}</div>
    <p>{d.overview}</p>
    {d.highlights?.length > 0 && <><h4 className="group-name">Highlights</h4><ul className="list">{d.highlights.map((h: any, k: number) => <li key={k}><div className="grow"><b>{h.emoji} {h.topic}</b><div className="small">{h.summary}</div></div></li>)}</ul></>}
    {d.decisions?.length > 0 && <><h4 className="group-name">Decided</h4><ul className="small">{d.decisions.map((x: string, k: number) => <li key={k}>{x}</li>)}</ul></>}
    {d.questions?.length > 0 && <><h4 className="group-name">Still open</h4><ul className="small">{d.questions.map((x: string, k: number) => <li key={k}>{x}</li>)}</ul></>}
    {d.nuggets?.length > 0 && <><h4 className="group-name">Learned</h4><ul className="small">{d.nuggets.map((x: string, k: number) => <li key={k}>{x}</li>)}</ul></>}
  </>;
}
function Conversations({ app }: { app: App }) {
  const { data, error } = useFetch<any[]>(`/api/apps/${encodeURIComponent(app.name)}/omi/conversations?limit=25`, 5 * 60000);
  if (error) return <div className="err-inline">{error}</div>;
  if (!data) return <div className="hint">…</div>;
  return data.length ? <ul className="list">{data.map(c => <li key={c.id}><div className="grow"><b>{c.emoji} {c.title}</b><div className="hint">{c.overview}</div></div><span className="hint">{c.at ? ago(c.at) : ""}</span></li>)}</ul>
    : <div className="empty">No conversations yet.</div>;
}
function Memories({ app }: { app: App }) {
  const [q, setQ] = useState(""), [asked, setAsked] = useState("");
  const { data, error, loading } = useFetch<any[]>(asked ? `/api/apps/${encodeURIComponent(app.name)}/omi/memories?q=${encodeURIComponent(asked)}` : null, 0);
  return <>
    <form className="row" onSubmit={e => { e.preventDefault(); setAsked(q.trim()); }}><input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="What did I say about…" aria-label="Search Omi's memories" style={{ flex: 1 }} /><button className="btn primary" type="submit">Search</button></form>
    {error && <div className="err-inline small">{error}</div>}
    {loading && <div className="hint">Remembering…</div>}
    {data && (data.length ? <ul className="list">{data.map((m, k) => <li key={k}><div className="grow">{m.content}</div>{m.category && <span className="tag">{m.category}</span>}</li>)}</ul> : <div className="empty">Nothing found.</div>)}
  </>;
}
function OmiTasks() {
  const all = useColl("tasks").filter(fromOmi), open = sortTasks(all.filter(t => !t.done)), done = all.filter(t => t.done).slice(0, 10);
  return <>{open.length ? <TaskRows tasks={open} showList /> : <div className="empty">No open action items.</div>}
    {done.length > 0 && <details><summary className="small">Done recently ({done.length})</summary><TaskRows tasks={done} /></details>}
    <div className="hint">Read from CalDAV, where Omi writes them. Change them in Omi.</div></>;
}
export function omiPage(app: App, label: string): PageDef {
  return { id: "omi", label, title: "The Listening Stone", flavor: `${app.name}: your days, conversations and what Omi remembers, read only.`,
    usePanels: () => ({ panels: [
      { key: "day", title: "Day recap", node: <Days app={app} />, w: 7, h: 16 },
      { key: "tasks", title: "Action items", node: <OmiTasks />, w: 5, h: 8 },
      { key: "memories", title: "Search memories", node: <Memories app={app} />, w: 5, h: 8 },
      { key: "conversations", title: "Conversations", node: <Conversations app={app} />, w: 12, h: 10 },
    ] }) };
}
