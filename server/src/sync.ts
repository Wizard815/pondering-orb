import { createHash, randomUUID } from "node:crypto";
import type { Records, Change } from "./records.js";
import type { OrbConfig } from "./config.js";
import { CalDav, Collection } from "./integrations/caldav.js";
import { parseTodo, writeTodo, rruleDays, daysRrule, managedOf } from "./integrations/ical.js";
import type { Outbox } from "./outbox.js";
import { today } from "./dates.js";
import { isOmiTask } from "./integrations/companions.js";

const ORIGIN = "caldav";
const idFor = (uid: string) => "cd-" + createHash("sha1").update(uid).digest("hex").slice(0, 16);
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);

/** Keeps the `tasks` and `chores` records in step with CalDAV.
 *  - Pull: every task list becomes tasks; the chores list becomes chores.
 *  - Push: when Orb changes a synced record (done, priority, title, due, a
 *    chore's Done), the VTODO is rewritten with If-Match; new tasks in a
 *    CalDAV list are created there; deletes are deleted there.
 *  Records written by the sync carry origin "caldav" and are not pushed back. */
export class TaskSync {
  lists: Collection[] = [];
  lastSync = 0; lastError = "";
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private r: Records, private dav: CalDav, private cfg: () => OrbConfig, private outbox?: Outbox) {
    r.on("change", (c: Change) => { if (c.origin !== ORIGIN && (c.coll === "tasks" || c.coll === "chores")) this.queue = this.queue.then(() => this.push(c)).then(() => { this.outbox?.drop(`caldav:${c.coll}:${c.id}`); }, e => this.failed(c, e)); });
    // A retry pushes the record as it is now (or the delete), not the stale change.
    outbox?.on("caldav", async (p: { coll: "tasks" | "chores"; id: string; op: "set" | "delete"; prev?: any }) => {
      if (p.op === "delete") return this.push({ coll: p.coll, id: p.id, op: "delete", prev: p.prev } as Change);
      const doc = this.r.get(p.coll, p.id); if (!doc) return;
      await this.push({ coll: p.coll, id: p.id, op: "set", doc } as Change);
    });
  }
  private failed(c: Change, e: any) {
    this.lastError = e?.message || String(e);
    const name = (c.doc as any)?.title || (c.doc as any)?.name || (c.prev as any)?.title || (c.prev as any)?.name || c.id;
    this.outbox?.add("caldav", `${c.op === "delete" ? "Delete" : "Save"} “${name}” in CalDAV`, { coll: c.coll, id: c.id, op: c.op, prev: c.prev }, this.lastError, `${c.coll}:${c.id}`);
  }
  private choresName() { return this.cfg().caldav.choresList || "Chores"; }

  private pulling: Promise<{ lists: number; tasks: number }> | null = null;
  /** One pull at a time: callers that arrive during a pull share it. */
  pull() {
    // A failed pull is shown as the sync status until the next one works.
    if (!this.pulling) this.pulling = this.pullNow().catch(e => { this.lastError = e?.message || String(e); throw e; }).finally(() => { this.pulling = null; });
    return this.pulling;
  }
  private async pullNow() {
    if (!this.dav.configured) return { lists: 0, tasks: 0 };
    this.lists = await this.dav.lists();
    let n = 0;
    for (const list of this.lists) {
      const items = await this.dav.todos(list), seen = new Set<string>();
      const isChores = list.name === this.choresName(), coll = isChores ? "chores" : "tasks";
      for (const it of items) {
        const t = parseTodo(it.ics); if (!t || !t.uid) continue;
        const id = idFor(t.uid); seen.add(id); n++;
        const caldav = { href: it.href, etag: it.etag, uid: t.uid, list: list.name, ics: it.ics };
        const data = isChores
          ? { name: t.summary || "Chore", everyDays: t.rrule ? rruleDays(t.rrule) : 7, lastDone: t.completed || (t.due && t.rrule ? addDays(t.due, -rruleDays(t.rrule)) : ""), due: t.due, caldav }
          : { title: t.summary || "Untitled", list: list.name, due: t.due, done: t.status === "COMPLETED", priority: t.priority, doneAt: t.completed, caldav, source: isOmiTask(t.uid) ? "omi" : "" };
        const cur: any = this.r.get(coll, id);
        if (!cur) this.r.create(coll, data, id, ORIGIN);
        else if (cur.caldav?.etag !== it.etag) this.r.put(coll, id, { ...strip(cur), ...data }, ORIGIN);
      }
      for (const d of this.r.list(coll) as any[]) if (d.caldav?.list === list.name && !seen.has(d.id)) this.r.remove(coll, d.id, ORIGIN);
    }
    // Lists that are gone on the server (or a chores list that was renamed in
    // Settings) leave records behind; drop their synced copies.
    if (this.lists.length) {
      const names = new Set(this.lists.map(l => l.name));
      for (const coll of ["tasks", "chores"] as const) for (const d of this.r.list(coll) as any[]) {
        const l = d.caldav?.list; if (!l) continue;
        if (!names.has(l) || (coll === "chores") !== (l === this.choresName())) this.r.remove(coll, d.id, ORIGIN);
      }
    }
    this.lastSync = Date.now(); this.lastError = "";
    return { lists: this.lists.length, tasks: n };
  }

  private async push(c: Change) {
    if (!this.dav.configured) return;
    if (c.op === "delete") { const p: any = c.prev; if (p?.caldav?.href && !isOmiTask(p.caldav.uid)) await this.dav.del(p.caldav.href, p.caldav.etag); return; }
    // Push the record as it is now, not the snapshot from when it changed: a
    // quick second edit would otherwise still see no href (and create the
    // task twice) or an old etag.
    const d: any = this.r.get(c.coll, c.id); if (!d) return;
    // Omi's own tasks are Omi's: Orb reads them and never writes them back.
    if (isOmiTask(d.caldav?.uid)) return;
    if (c.coll === "tasks") {
      if (d.caldav?.href) {
        const fields = { uid: d.caldav.uid, summary: d.title, done: !!d.done, due: d.due || "", priority: Number(d.priority) || 0 };
        const ics = writeTodo(d.caldav.ics, fields);
        const target = this.lists.find(l => l.name === d.list);
        if (target && d.list !== d.caldav.list) { // moved to another list: create it there, then remove the old one
          const href = target.href.replace(/\/?$/, "/") + encodeURIComponent(d.caldav.uid) + ".ics";
          await this.save(c.coll, d, href, ics, undefined, undefined, target.name);
          await this.dav.del(d.caldav.href, d.caldav.etag).catch(() => this.dav.del(d.caldav.href));
          return;
        }
        // Only Orb-side fields changed (notes, layout): nothing to write.
        if (managedOf(ics) === managedOf(d.caldav.ics)) return;
        await this.save(c.coll, d, d.caldav.href, ics, d.caldav.etag);
      } else {
        if (!this.lists.length) await this.pull(); // unreachable: throws, so the change is queued
        const list = this.lists.find(l => l.name === d.list); if (!list) return; // a list that only lives in Orb
        const uid = randomUUID(), href = list.href.replace(/\/?$/, "/") + uid + ".ics";
        const ics = writeTodo(null, { uid, summary: d.title, done: !!d.done, due: d.due || "", priority: Number(d.priority) || 0 });
        await this.save(c.coll, d, href, ics, undefined, uid, list.name);
      }
    } else if (c.coll === "chores") {
      const every = Math.max(1, Number(d.everyDays) || 7), due = addDays(d.lastDone || today(), every);
      // DTSTART must come before DUE (RFC 5545), so it is the last time it was done.
      const fields = { summary: d.name, done: false, due, priority: 0, rrule: daysRrule(every), dtstart: addDays(due, -every) };
      if (d.caldav?.href) {
        const ics = writeTodo(d.caldav.ics, { uid: d.caldav.uid, ...fields });
        if (d.caldav.due === due && managedOf(ics) === managedOf(d.caldav.ics)) return;
        await this.save(c.coll, d, d.caldav.href, ics, d.caldav.etag, undefined, undefined, due);
      } else {
        if (!this.lists.length) await this.pull(); // unreachable: throws, so the change is queued
        const list = this.lists.find(l => l.name === this.choresName()); if (!list) return;
        const uid = randomUUID(), href = list.href.replace(/\/?$/, "/") + uid + ".ics";
        await this.save(c.coll, d, href, writeTodo(null, { uid, ...fields }), undefined, uid, list.name, due);
      }
    }
  }
  /** PUT, then record the new href/etag. A missing etag in the answer means a
   *  pull is needed to learn it. 409 (changed elsewhere) also pulls. */
  private async save(coll: "tasks" | "chores", d: any, href: string, ics: string, etag?: string, uid?: string, list?: string, due?: string) {
    try {
      const r = await this.dav.put(href, ics, etag);
      const caldav = { ...(d.caldav || {}), href, ics, etag: r.etag || "", ...(uid ? { uid } : {}), ...(list ? { list } : {}), ...(due ? { due } : {}) };
      if (this.r.get(coll, d.id)) this.r.patch(coll, d.id, { caldav }, undefined, ORIGIN);
      if (!r.etag) await this.pull();
    } catch (e: any) { if (e.status === 409) await this.pull(); throw e; }
  }
}
function strip(d: any) { const { id: _i, version: _v, ...rest } = d; return rest; }
