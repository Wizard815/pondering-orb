import { useSyncExternalStore } from "react";
import { api } from "./api";

/** Orb's own records, kept in memory and live: one GET per collection on
 *  start, then changes from /api/stream. Same shapes as the demo page. */
export const COLLS = ["projects", "logs", "tasks", "chores", "canvas", "edges", "events", "layouts", "settings", "chats", "daily", "picks", "research"] as const;
export type Coll = typeof COLLS[number];
export type Doc = { id: string; version?: number; [k: string]: any };

const data: Record<string, Doc[]> = Object.fromEntries(COLLS.map(c => [c, []]));
const listeners = new Set<() => void>();
let ready = false, online = true;
const emit = () => listeners.forEach(f => f());
const subscribe = (f: () => void) => { listeners.add(f); return () => listeners.delete(f); };

function apply(coll: string, id: string, doc: Doc | null) {
  const cur = data[coll] || [];
  const i = cur.findIndex(d => d.id === id);
  data[coll] = doc ? (i < 0 ? [...cur, doc] : cur.map((d, j) => (j === i ? doc : d))) : cur.filter(d => d.id !== id);
}

export async function startStore() {
  const lists = await Promise.all(COLLS.map(c => api<Doc[]>("GET", `/api/c/${c}`)));
  COLLS.forEach((c, i) => (data[c] = lists[i]));
  ready = true; emit();
  const connect = () => {
    const es = new EventSource("/api/stream");
    es.addEventListener("change", (e: MessageEvent) => { const ch = JSON.parse(e.data); apply(ch.coll, ch.id, ch.op === "delete" ? null : ch.doc); emit(); });
    es.addEventListener("outbox", () => dispatchEvent(new Event("orb:outbox")));
    es.onopen = () => { if (!online) { online = true; resync(); } };
    es.onerror = () => { online = false; emit(); };
  };
  connect();
}
async function resync() { const lists = await Promise.all(COLLS.map(c => api<Doc[]>("GET", `/api/c/${c}`))); COLLS.forEach((c, i) => (data[c] = lists[i])); emit(); }

export const useColl = (c: Coll) => useSyncExternalStore(subscribe, () => data[c]);
export const useReady = () => useSyncExternalStore(subscribe, () => ready);
export const useOnline = () => useSyncExternalStore(subscribe, () => online);
export const getColl = (c: Coll) => data[c];
export const getDoc = (c: Coll, id: string) => data[c].find(d => d.id === id);
export function useDoc(c: Coll, id: string) { const list = useColl(c); return list.find(d => d.id === id); }

// Writes. The server answers with the stored record, which is applied right away
// (the stream sends it too; applying twice is harmless).
export async function create(c: Coll, body: Record<string, any>) { const d = await api<Doc>("POST", `/api/c/${c}`, body); apply(c, d.id, d); emit(); return d; }
export async function put(c: Coll, id: string, body: Record<string, any>) { const d = await api<Doc>("PUT", `/api/c/${c}/${encodeURIComponent(id)}`, body); apply(c, id, d); emit(); return d; }
export async function patch(c: Coll, id: string, body: Record<string, any>) { const d = await api<Doc>("PATCH", `/api/c/${c}/${encodeURIComponent(id)}`, body); apply(c, id, d); emit(); return d; }
export async function remove(c: Coll, id: string) { await api("DELETE", `/api/c/${c}/${encodeURIComponent(id)}`); apply(c, id, null); emit(); }

/** App settings live in settings/app. */
export function useSettings(): Record<string, any> { const s = useColl("settings"); return s.find(d => d.id === "app") || {}; }
export async function saveSettings(p: Record<string, any>) {
  const cur = getDoc("settings", "app");
  if (cur) { const { id: _i, version: _v, ...rest } = cur; return put("settings", "app", { ...rest, ...p }); }
  return put("settings", "app", p);
}
