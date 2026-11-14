import type { PageDef } from "./types";
import { useOrbConfig } from "./upkeep/config";

/** Ideas live in Milaclone (Miladash): boards, cards, mind maps and drawings.
 *  This tab shows it in place; set its address in Settings → Connections. */
function Milaclone() {
  const cfg = useOrbConfig(), url = /^https?:\/\//.test(cfg?.milaclone?.url || "") ? String(cfg.milaclone.url) : "";
  if (!cfg) return <div className="hint">Opening…</div>;
  if (!url) return <div className="empty">Set Milaclone's address in <a href="#config">Settings → Connections</a> (or <code>MILACLONE_URL</code> in <code>.env</code>), e.g. <code>http://tower:4321</code>, and your boards show here.</div>;
  return <div className="mila"><iframe className="mila-frame" src={url} title="Milaclone" referrerPolicy="no-referrer" /></div>;
}

export const IdeasPage: PageDef = {
  id: "ideas", label: "Ideas", title: "Alchemy Bench", flavor: "Your boards, mind maps and drawings, in Milaclone.",
  usePanels: () => {
    const cfg = useOrbConfig(), url = /^https?:\/\//.test(cfg?.milaclone?.url || "") ? String(cfg.milaclone.url) : "";
    return {
      extra: url ? <a className="btn" href={url} target="_blank" rel="noopener">Open Milaclone</a> : undefined,
      panels: [{ key: "milaclone", title: "Milaclone", node: <Milaclone />, w: 12, h: 30, minH: 12 }],
    };
  },
};
