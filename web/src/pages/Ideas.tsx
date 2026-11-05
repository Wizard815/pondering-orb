import type { PageDef } from "./types";
import { useColl } from "../lib/store";
import { fmtDate } from "../lib/util";
import { Board } from "./ideas/Board";

function Promoted() {
  const canvas = useColl("canvas");
  const done = canvas.filter(i => i.type === "idea" && i.promoted).sort((a, b) => String(b.promoted).localeCompare(String(a.promoted)));
  if (!done.length) return <div className="empty">Nothing promoted yet. Right-click an idea card and choose Promote.</div>;
  return <ul className="list">{done.map(i => <li key={i.id}><span className="date">{fmtDate(i.promoted)}</span><div className="grow">{i.title || "Untitled idea"}</div></li>)}</ul>;
}

export const IdeasPage: PageDef = {
  id: "ideas", label: "Ideas", title: "Alchemy Bench", flavor: "A free board for ideas: cards, columns, boards inside boards, and arrows between them.",
  usePanels: () => ({
    panels: [
      { key: "board", title: "Board", node: <Board />, w: 12, h: 16, minH: 10 },
      { key: "promoted", title: "Promoted to projects", node: <Promoted />, w: 6, h: 6 },
    ],
  }),
};
