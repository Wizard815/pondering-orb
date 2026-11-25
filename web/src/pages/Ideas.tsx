import { useEffect, useRef, useState } from "react";
import type { PageDef } from "./types";
import { useOrbConfig } from "./upkeep/config";
import { useFetch } from "../lib/useFetch";
import { useColl } from "../lib/store";
import { post } from "../lib/api";
import { useUi } from "../lib/ui";
import { ago, clip } from "../lib/util";

/** A board another page asked to open (a project's linked board). */
let wanted = "";
export function openBoard(id: string) { wanted = id; dispatchEvent(new Event("orb:open-board")); location.hash = "ideas"; }

type Change = { id: number; at: number; actor: string; summary: string; canvasId: string | null; boardTitle: string | null };

/** What agents (Hermes, Ekko, coding agents, Golem) changed on the boards, newest first, and their requests to remove
 *  something, which wait for you here. Milaclone refreshes the open board by itself when an agent edits it. */
function BoardActivity({ onOpen }: { onOpen: (id: string) => void }) {
  const ui = useUi(), [busy, setBusy] = useState("");
  const { data } = useFetch<{ configured: boolean; items: Change[]; error?: string }>("/api/ideas/activity", 5000);
  const asks = useColl("approvals").filter((a: any) => a.source === "orb-board" && a.state === "pending").sort((a: any, b: any) => (a.askedAt || 0) - (b.askedAt || 0));
  const items = data?.items || [], newest = items[0];
  const decide = async (a: any, decision: "approve" | "reject") => {
    setBusy(a.id);
    try { ui.status((await post<{ message: string }>(`/api/ideas/approvals/${encodeURIComponent(a.id)}/decide`, { decision })).message); }
    catch (e) { ui.error(e); } finally { setBusy(""); }
  };
  if (!data?.configured && !asks.length) return null;
  return <div className="mila-activity" aria-label="What agents changed on your boards">
    {/* Only the newest change is announced, not the whole list every few seconds. */}
    <span className="sr-only" role="status" aria-live="polite">{newest ? `${newest.actor} ${newest.summary}${newest.boardTitle ? ` on ${newest.boardTitle}` : ""}` : ""}</span>
    {asks.map((a: any) => <div className="mila-ask" key={a.id} data-testid="board-ask">
      <div className="grow"><b>{a.agent || "An agent"} asks:</b> {a.title}{a.summary ? <span className="small muted"> · {clip(a.summary, 160)}</span> : null}</div>
      <button className="btn" disabled={!!busy} onClick={() => decide(a, "approve")}>{busy === a.id ? "…" : "Approve"}</button>
      <button className="btn" disabled={!!busy} onClick={() => decide(a, "reject")}>Reject</button>
    </div>)}
    {data?.error ? <span className="hint">{data.error}</span> : items.length ? <ul className="mila-feed">{items.slice(0, 6).map(x => <li key={x.id}>
      <button className="mila-change" disabled={!x.canvasId} onClick={() => x.canvasId && onOpen(x.canvasId)} title={x.boardTitle ? `Open ${x.boardTitle}` : undefined}>
        <span className="mila-who">{x.actor}</span> {clip(x.summary, 90)}{x.boardTitle ? <span className="muted"> · {clip(x.boardTitle, 30)}</span> : null} <span className="muted small">{ago(x.at)}</span>
      </button></li>)}</ul>
      : data?.configured ? <span className="hint">No agent has changed a board yet. Agents use the orb_board_ tools (or Milaclone's own MCP), and what they do shows here.</span> : null}
  </div>;
}

/** Ideas live in Milaclone (Miladash): boards, cards, mind maps and drawings.
 *  This tab shows it in place; set its address in Settings → Connections. */
const milaUrl = (cfg: any) => (/^https?:\/\//.test(cfg?.milaclone?.url || "") ? String(cfg.milaclone.url) : "");

function Milaclone() {
  const cfg = useOrbConfig(), url = milaUrl(cfg), box = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false), [slow, setSlow] = useState(false), [down, setDown] = useState(false), [tries, setTries] = useState(0);
  // The board to show: one a project asked for, or one picked in the activity strip. Milaclone opens #<board id>.
  const [board, setBoard] = useState(() => { const w = wanted; wanted = ""; return w; });
  useEffect(() => { const f = () => { if (wanted) { setBoard(wanted); wanted = ""; } }; addEventListener("orb:open-board", f); return () => removeEventListener("orb:open-board", f); }, []);
  useEffect(() => { setLoaded(false); setSlow(false); if (!url) return; const t = setTimeout(() => setSlow(true), 8000); return () => clearTimeout(t); }, [url, tries]);
  // The frame "loads" even when nothing answers (the browser shows its own error page), so ask Milaclone first.
  // An opaque answer is enough: it only tells us something is listening there.
  useEffect(() => { if (!url || (location.protocol === "https:" && url.startsWith("http:"))) return; let live = true; setDown(false);
    fetch(new URL("api/health", url.replace(/\/?$/, "/")).toString(), { mode: "no-cors", cache: "no-store" }).catch(() => { if (live) setDown(true); });
    return () => { live = false; }; }, [url, tries]);
  if (!cfg) return <div className="hint">Opening…</div>;
  if (!url) return <div className="empty">Set Milaclone's address in <a href="#config">Settings → Connections</a> (or <code>MILACLONE_URL</code> in <code>.env</code>), e.g. <code>http://tower:4321</code>, and your boards show here.</div>;
  // A page served over https can't show an http page inside it (the browser blocks it).
  if (location.protocol === "https:" && url.startsWith("http:")) return <div className="empty">
    Orb is open over https, and Milaclone's address is plain http, so the browser won't show it inside Orb. Use an https address for Milaclone (for example through the same reverse proxy as Orb), or <a href={url} target="_blank" rel="noopener">open Milaclone in its own tab</a>.</div>;
  if (down) return <div className="empty">Milaclone isn't answering at <code>{url}</code>. Is it running, and is that the address your browser uses for it? <button className="btn" onClick={() => setTries(n => n + 1)}>Try again</button> <a className="btn" href="#config">Settings</a></div>;
  const full = () => { const el = box.current; if (el?.requestFullscreen) el.requestFullscreen().catch(() => window.open(url, "_blank", "noopener")); else window.open(url, "_blank", "noopener"); };
  return <div className="mila" ref={box}>
    <BoardActivity onOpen={setBoard} />
    <div className="row small mila-bar"><span className="hint grow">{!loaded && slow ? <>Milaclone hasn't answered yet. Is it running at <code>{url}</code>? <a href={url} target="_blank" rel="noopener">Open it directly</a>.</> : "Your Milaclone boards."}</span>
      <button className="btn" onClick={full}>Full screen</button><a className="btn" href={url} target="_blank" rel="noopener">New tab</a></div>
    <iframe key={tries} className="mila-frame" src={board ? `${url.replace(/#.*$/, "")}#${encodeURIComponent(board)}` : url} title="Milaclone" referrerPolicy="no-referrer" allow="clipboard-read; clipboard-write; fullscreen" onLoad={() => setLoaded(true)} />
  </div>;
}

export const IdeasPage: PageDef = {
  id: "ideas", label: "Ideas", title: "Alchemy Bench", flavor: "Your boards, mind maps and drawings, in Milaclone. Agents work on them too.",
  usePanels: () => ({ panels: [{ key: "milaclone", title: "Milaclone", node: <Milaclone />, w: 12, h: 30, minH: 12 }] }),
};
