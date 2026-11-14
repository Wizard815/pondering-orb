import { useEffect, useRef, useState } from "react";
import type { PageDef } from "./types";
import { useOrbConfig } from "./upkeep/config";

/** Ideas live in Milaclone (Miladash): boards, cards, mind maps and drawings.
 *  This tab shows it in place; set its address in Settings → Connections. */
const milaUrl = (cfg: any) => (/^https?:\/\//.test(cfg?.milaclone?.url || "") ? String(cfg.milaclone.url) : "");

function Milaclone() {
  const cfg = useOrbConfig(), url = milaUrl(cfg), box = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false), [slow, setSlow] = useState(false), [down, setDown] = useState(false), [tries, setTries] = useState(0);
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
    <div className="row small mila-bar"><span className="hint grow">{!loaded && slow ? <>Milaclone hasn't answered yet. Is it running at <code>{url}</code>? <a href={url} target="_blank" rel="noopener">Open it directly</a>.</> : "Your Milaclone boards."}</span>
      <button className="btn" onClick={full}>Full screen</button><a className="btn" href={url} target="_blank" rel="noopener">New tab</a></div>
    <iframe key={tries} className="mila-frame" src={url} title="Milaclone" referrerPolicy="no-referrer" allow="clipboard-read; clipboard-write; fullscreen" onLoad={() => setLoaded(true)} />
  </div>;
}

export const IdeasPage: PageDef = {
  id: "ideas", label: "Ideas", title: "Alchemy Bench", flavor: "Your boards, mind maps and drawings, in Milaclone.",
  usePanels: () => ({ panels: [{ key: "milaclone", title: "Milaclone", node: <Milaclone />, w: 12, h: 30, minH: 12 }] }),
};
