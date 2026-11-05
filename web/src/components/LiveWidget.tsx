import { useFetch } from "../lib/useFetch";

/** Live data for an app with `widget:` in the apps YAML (Plex, SABnzbd),
 *  fetched through the server so the app's key never reaches the browser. */
export function LiveWidget({ name }: { name: string }) {
  const { data, error } = useFetch<any>(`/api/widgets/${encodeURIComponent(name)}`, 15000);
  if (error) return <div className="err-inline small">{error}</div>;
  if (!data) return <div className="hint">Loading…</div>;
  const bar = (pct: number) => <div className="bar"><span style={{ width: Math.min(100, pct) + "%" }} /></div>;
  if (data.type === "plex") return data.sessions.length ? <div>{data.sessions.map((s: any, i: number) => <div key={i} className="lv">
      <div className="row" style={{ justifyContent: "space-between" }}><b className="grow" style={{ overflowWrap: "anywhere" }}>{s.title}</b><span className="hint">{s.user}{s.player ? " · " + s.player : ""}{s.state === "paused" ? " · paused" : ""}{s.transcode ? " · transcoding" : ""}</span></div>{bar(s.progress)}</div>)}</div>
    : <div className="empty small">Nothing playing.</div>;
  if (data.type === "sabnzbd") return <>
    <div className="row small mono" style={{ justifyContent: "space-between" }}><span>{data.paused ? "paused" : data.speed || "idle"}</span><span>{data.timeleft ? `${data.timeleft} left` : ""}{data.sizeLeft ? ` · ${data.sizeLeft}` : ""}</span></div>
    {data.queue.length ? data.queue.map((q: any, i: number) => <div key={i} className="lv"><div className="row" style={{ justifyContent: "space-between" }}><span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.name}</span><span className="mono small">{q.pct}%</span></div>{bar(q.pct)}</div>)
      : <div className="empty small">Queue empty.</div>}</>;
  return null;
}
