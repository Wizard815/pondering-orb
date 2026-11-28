import { createHash, randomBytes } from "node:crypto";
import type { Store } from "./db.js";
import { newId } from "./db.js";

/** Orb's own apps (desktop and Android) sign in once with ORB_PASSWORD and
 *  get a key for that device. The key acts as you, like the session cookie,
 *  but it is named, listed in Settings → Devices and can be removed there.
 *  Only a hash of each key is stored. */
export type Device = { id: string; name: string; platform: string; createdAt: number; lastSeen: number };
export const PLATFORMS = ["windows", "linux", "mac", "android", "other"];
const PREFIX = "orbd_";

export class Devices {
  constructor(private store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)`);
  }
  add(name: string, platform: string): Device & { token: string } {
    const id = newId(), token = PREFIX + randomBytes(32).toString("base64url"), now = Date.now();
    const n = String(name || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60) || "Device";
    const p = PLATFORMS.includes(platform) ? platform : "other";
    this.store.db.prepare("INSERT INTO devices (id, name, platform, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)").run(id, n, p, hash(token), now, now);
    return { id, name: n, platform: p, createdAt: now, lastSeen: now, token };
  }
  /** The device id for a key, or null. Marks it seen (at most once a minute). */
  check(token: string): string | null {
    if (!token.startsWith(PREFIX)) return null;
    const r = this.store.db.prepare("SELECT id, last_seen FROM devices WHERE token_hash = ?").get(hash(token)) as any;
    if (!r) return null;
    const now = Date.now();
    if (now - r.last_seen > 60_000) this.store.db.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").run(now, r.id);
    return r.id;
  }
  list(): Device[] {
    return (this.store.db.prepare("SELECT id, name, platform, created_at, last_seen FROM devices ORDER BY created_at").all() as any[])
      .map(r => ({ id: r.id, name: r.name, platform: r.platform, createdAt: r.created_at, lastSeen: r.last_seen }));
  }
  remove(id: string) { return this.store.db.prepare("DELETE FROM devices WHERE id = ?").run(String(id)).changes > 0; }
  get count() { return Number((this.store.db.prepare("SELECT COUNT(*) AS n FROM devices").get() as any).n) || 0; }
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
