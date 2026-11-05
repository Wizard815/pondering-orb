import { randomUUID } from "node:crypto";
import type { Store } from "./db.js";

/** Writes to other apps that failed (CalDAV down, the wiki unreachable, a
 *  task changed elsewhere) wait here and are retried every minute, so a
 *  failure never loses a change silently. Kept in SQLite (collection
 *  "outbox", not writable through the records API). */
export type OutboxItem = { id: string; kind: string; label: string; payload: any; tries: number; lastError: string; created: number; next: number };
type Handler = (payload: any) => Promise<void>;

export class Outbox {
  private handlers = new Map<string, Handler>();
  private running = false;
  constructor(private store: Store, private onChange: () => void = () => {}) {}
  on(kind: string, h: Handler) { this.handlers.set(kind, h); }
  list(): OutboxItem[] { return this.store.list("outbox") as any; }
  /** Queue a failed write. `key` replaces an older entry for the same thing
   *  (two failed pushes of one task become one). */
  add(kind: string, label: string, payload: any, error: string, key?: string) {
    const id = key ? `${kind}:${key}` : randomUUID();
    const prev = this.store.get("outbox", id) as any;
    this.store.set("outbox", id, { kind, label, payload, tries: prev?.tries ?? 0, lastError: error, created: prev?.created ?? Date.now(), next: Date.now() + 60000 });
    this.onChange();
  }
  drop(id: string) { const ok = this.store.delete("outbox", id); if (ok) this.onChange(); return ok; }
  /** Try everything that's due (or everything, with force). */
  async flush(force = false) {
    if (this.running) return { done: 0, failed: 0 };
    this.running = true; let done = 0, failed = 0;
    try {
      for (const it of this.list()) {
        if (!force && it.next > Date.now()) continue;
        const h = this.handlers.get(it.kind); if (!h) continue;
        try {
          await h(it.payload); done++;
          // A newer failure for the same thing may have replaced this entry
          // while the retry ran; keep that one.
          if ((this.store.get("outbox", it.id) as any)?.version === (it as any).version) this.store.delete("outbox", it.id);
        } catch (e: any) {
          failed++;
          if ((this.store.get("outbox", it.id) as any)?.version !== (it as any).version) continue;
          const tries = it.tries + 1, wait = Math.min(60, 2 ** Math.min(tries, 6)) * 60000; // 2, 4, 8 ... 60 minutes
          const { id: _i, version: _v, ...rest } = it as any;
          this.store.set("outbox", it.id, { ...rest, tries, lastError: e?.message || String(e), next: Date.now() + wait });
        }
      }
    } finally { this.running = false; if (done || failed) this.onChange(); }
    return { done, failed };
  }
}
