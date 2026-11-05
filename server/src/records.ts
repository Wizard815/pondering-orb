import { EventEmitter } from "node:events";
import { Store, Doc, newId } from "./db.js";
import type { OrbConfig } from "./config.js";

/** Collections the web app and agents may read and write through
 *  /api/c/<name>. Anything else is refused. */
export const COLLECTIONS = ["projects", "logs", "tasks", "chores", "canvas", "edges", "events", "layouts", "settings", "chats"] as const;
export type Coll = typeof COLLECTIONS[number];
export const isColl = (c: string): c is Coll => (COLLECTIONS as readonly string[]).includes(c);

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

export const STATUSES = ["next", "active", "blocked", "paused", "shipped"];
const today = () => new Date().toISOString().slice(0, 10);

export type Change = { coll: Coll; id: string; op: "set" | "delete"; doc?: Doc };

/** The one place records are written, so checks and live updates can't be
 *  skipped. Every write emits a change that /api/stream sends to browsers. */
export class Records extends EventEmitter {
  constructor(public store: Store, public cfg: () => OrbConfig) { super(); this.setMaxListeners(200); }

  list(coll: Coll) { return this.store.list(coll); }
  get(coll: Coll, id: string) { return this.store.get(coll, id); }

  private logMax() {
    const s = this.store.get("settings", "app") as any;
    const n = Number(s?.logMax) || this.cfg().logMax || 50;
    return Math.max(20, Math.min(200, n));
  }

  private check(coll: Coll, data: Record<string, any>, partial: boolean): Record<string, any> {
    const d = { ...data };
    if (coll === "logs") {
      if (!partial || "text" in d) {
        const t = String(d.text ?? "").trim();
        if (!t) throw new HttpError(422, "A log entry needs text.");
        const max = this.logMax();
        if (t.length > max) throw new HttpError(422, `A log entry can be at most ${max} characters (this one has ${t.length}).`);
        d.text = t;
      }
      if (!partial) { d.date ??= today(); d.project ??= "General"; d.created ??= Date.now(); }
    }
    if (coll === "projects") {
      if (!partial || "name" in d) { const n = String(d.name ?? "").trim(); if (!n) throw new HttpError(422, "A project needs a name."); d.name = n; }
      if ("status" in d && !STATUSES.includes(d.status)) throw new HttpError(422, `Status must be one of ${STATUSES.join(", ")}.`);
      if (!partial) d.status ??= "next";
      d.updated = today();
    }
    if (coll === "tasks") {
      if (!partial || "title" in d) { const t = String(d.title ?? "").trim(); if (!t) throw new HttpError(422, "A task needs a title."); d.title = t; }
      if ("priority" in d) { const p = Number(d.priority) || 0; if (p < 0 || p > 9) throw new HttpError(422, "Priority is 0 to 9."); d.priority = p; }
      if (!partial) { d.list ??= "Inbox"; d.done ??= false; }
    }
    if (coll === "chores" && !partial) {
      if (!String(d.name ?? "").trim()) throw new HttpError(422, "A chore needs a name.");
      d.everyDays = Math.max(1, Number(d.everyDays) || 7); d.lastDone ??= "";
    }
    return d;
  }

  create(coll: Coll, data: Record<string, any>, id = newId()) {
    const doc = this.store.set(coll, id, this.check(coll, data, false));
    this.emit("change", { coll, id, op: "set", doc } satisfies Change);
    return doc;
  }
  put(coll: Coll, id: string, data: Record<string, any>) {
    const doc = this.store.set(coll, id, this.check(coll, data, false));
    this.emit("change", { coll, id, op: "set", doc } satisfies Change);
    return doc;
  }
  patch(coll: Coll, id: string, data: Record<string, any>, ifVersion?: number) {
    const cur = this.store.get(coll, id);
    if (!cur) throw new HttpError(404, `No ${coll} record ${id}.`);
    if (ifVersion && cur.version !== ifVersion) throw new HttpError(409, `That record changed (now version ${cur.version}). Reload and try again.`);
    const doc = this.store.update(coll, id, this.check(coll, data, true))!;
    this.emit("change", { coll, id, op: "set", doc } satisfies Change);
    return doc;
  }
  remove(coll: Coll, id: string) {
    const ok = this.store.delete(coll, id);
    if (ok) this.emit("change", { coll, id, op: "delete" } satisfies Change);
    return ok;
  }
}
