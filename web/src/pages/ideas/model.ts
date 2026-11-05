import { create, getColl, patch, remove, Doc } from "../../lib/store";
import { listOf, todayISO } from "../../lib/util";

/** Card types, colours and helpers for the Ideas board (ported from the demo's mc* code). */
export type CardType = "note" | "idea" | "todo" | "tasks" | "link" | "column" | "board" | "comment";
export type Tool = "select" | "connect" | CardType;

export const MC_TYPES: Record<CardType, { label: string; icon: string; w: number }> = {
  note: { label: "Note", icon: "✎", w: 220 }, idea: { label: "Idea", icon: "✧", w: 240 }, todo: { label: "To-do", icon: "☑", w: 230 }, tasks: { label: "Tasks", icon: "☰", w: 250 },
  link: { label: "Link", icon: "↗", w: 220 }, column: { label: "Column", icon: "▥", w: 250 }, board: { label: "Board", icon: "▣", w: 190 }, comment: { label: "Comment", icon: "❝", w: 200 },
};
export const CARD_TYPES = Object.keys(MC_TYPES) as CardType[];
export const MC_COLORS: [string, string][] = [["", "Plain"], ["gold", "Gold"], ["arcane", "Teal"], ["ok", "Green"], ["warn", "Amber"], ["bad", "Red"], ["muted", "Grey"]];
export const STAGES = ["thought", "design", "code"] as const;
export const STAGE_LABEL: Record<string, string> = { thought: "Thought", design: "Design", code: "Code" };
export const MC_PH: Record<string, string> = { note: "Title (optional)", idea: "New idea", todo: "To-do", tasks: "Card title (optional)", link: "Link title", column: "New column", board: "New board" };
export const EDGE_KINDS: [string, string][] = [["relates", "Relates to"], ["depends", "Depends on"], ["became", "Became"]];

export const boardOf = (i: Doc) => i.board || "root";
export const typeOf = (i: Doc): CardType => (MC_TYPES[i.type as CardType] ? i.type : "note");
export const taskLists = () => [...new Set(getColl("tasks").map(listOf))].sort();

/** Strip the server's bookkeeping so a record can be written back. */
export const bare = (d: Doc) => { const { id: _i, version: _v, ...rest } = d; return rest; };

// Camera per board, kept in localStorage like the demo.
export type Cam = { x: number; y: number; z: number };
let cams: Record<string, Cam> = {};
try { cams = JSON.parse(localStorage.getItem("orb.mccam") || "{}") || {}; } catch { cams = {}; }
export const camOf = (b: string): Cam => (cams[b] ||= { x: 40, y: 30, z: 1 });
export const setCam = (b: string, c: Cam) => { cams[b] = c; };
export const saveCams = () => { try { localStorage.setItem("orb.mccam", JSON.stringify(cams)); } catch { /* storage blocked */ } };
export const clampZ = (z: number) => Math.max(0.3, Math.min(2.2, z));

export function isEmptyCard(i: Doc) {
  const canvas = getColl("canvas");
  return !String(i.title || "").trim() && !String(i.text || "").trim() && !(i.items || []).length && !i.list && !(i.url && i.url !== "https://")
    && !canvas.some(k => k.parent === i.id || boardOf(k) === i.id);
}

export async function createCard(board: string, type: CardType, at: { x: number; y: number }) {
  const base = { board, type, x: Math.round(at.x), y: Math.round(at.y), w: MC_TYPES[type].w, color: "", updated: todayISO() };
  const extra = type === "idea" ? { title: "", text: "", stage: "thought" } : type === "todo" ? { title: "", items: [] } : type === "tasks" ? { title: "", list: "" }
    : type === "link" ? { title: "", url: "" } : type === "comment" ? { text: "" } : type === "note" ? { title: "", text: "" } : { title: "" };
  return create("canvas", { ...base, ...extra });
}

/** Delete a card: release its column children, drop its arrows. Returns an undo function. */
export async function deleteCard(i: Doc) {
  const id = i.id, data = bare(i);
  const kids = getColl("canvas").filter(k => k.parent === id).map(k => ({ id: k.id, parent: k.parent, x: k.x, y: k.y, order: k.order }));
  const edges = getColl("edges").filter(e => e.from === id || e.to === id).map(e => ({ id: e.id, data: bare(e) }));
  for (const k of kids) await patch("canvas", k.id, { parent: "", x: (i.x || 0) + 20, y: (i.y || 0) + 40 + (k.order || 0) * 30 });
  for (const e of edges) await remove("edges", e.id);
  await remove("canvas", id);
  return async () => {
    await create("canvas", { ...data, id });
    for (const k of kids) await patch("canvas", k.id, { parent: k.parent, x: k.x ?? 0, y: k.y ?? 0, order: k.order ?? 0 });
    for (const e of edges) await create("edges", { ...e.data, id: e.id });
  };
}

export const cardName = (i: Doc) => (i.title ? `“${i.title}”` : (MC_TYPES[i.type as CardType]?.label || "card").toLowerCase());
