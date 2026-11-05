import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Orb keeps its own records (projects, logs, chores, board cards, layouts,
 *  settings) as JSON documents in SQLite, grouped by collection. This mirrors
 *  the demo page's data model so the web app can port screen by screen. Data
 *  owned by other apps (CalDAV tasks, the wiki, UpstreamManager) is fetched
 *  from them and at most cached here. */
export class Store {
  db: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS docs (
        coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
        PRIMARY KEY (coll, id));
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    `);
  }
  list(coll: string): Doc[] {
    return (this.db.prepare("SELECT id, data, version FROM docs WHERE coll = ? ORDER BY updated_at, rowid").all(coll) as any[])
      .map(r => ({ id: r.id, version: r.version, ...JSON.parse(r.data) }));
  }
  get(coll: string, id: string): Doc | null {
    const r = this.db.prepare("SELECT id, data, version FROM docs WHERE coll = ? AND id = ?").get(coll, id) as any;
    return r ? { id: r.id, version: r.version, ...JSON.parse(r.data) } : null;
  }
  set(coll: string, id: string, data: Record<string, unknown>): Doc {
    const clean = strip(data);
    const cur = this.get(coll, id);
    const version = (cur?.version ?? 0) + 1;
    this.db.prepare(`INSERT INTO docs (coll, id, data, version, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (coll, id) DO UPDATE SET data = excluded.data, version = excluded.version, updated_at = excluded.updated_at`)
      .run(coll, id, JSON.stringify(clean), version, Date.now());
    return { id, version, ...clean };
  }
  update(coll: string, id: string, patch: Record<string, unknown>): Doc | null {
    const cur = this.get(coll, id);
    if (!cur) return null;
    const { id: _i, version: _v, ...rest } = cur;
    return this.set(coll, id, { ...rest, ...strip(patch) });
  }
  delete(coll: string, id: string): boolean {
    return this.db.prepare("DELETE FROM docs WHERE coll = ? AND id = ?").run(coll, id).changes > 0;
  }
}
export type Doc = { id: string; version: number; [k: string]: unknown };
function strip(d: Record<string, unknown>) { const { id: _id, version: _v, ...rest } = d as any; return rest; }
export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
