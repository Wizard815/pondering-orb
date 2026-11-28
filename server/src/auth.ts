import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Store } from "./db.js";
import { Devices } from "./devices.js";

/** Two ways in:
 *  - People sign in with ORB_PASSWORD and get an HttpOnly session cookie.
 *  - Agents send `Authorization: Bearer <token>`; ORB_API_TOKENS holds
 *    "name:token" pairs, and the name is recorded as `by` on what they write.
 *  With neither set, Orb is open, which is only for a private LAN; the
 *  server warns about it on start. */
export class Auth {
  tokens = new Map<string, string>();
  devices: Devices;
  constructor(private store: Store, private password = process.env.ORB_PASSWORD || "", tokens = process.env.ORB_API_TOKENS || "") {
    this.devices = new Devices(store);
    for (const pair of tokens.split(",").map(s => s.trim()).filter(Boolean)) {
      const i = pair.indexOf(":");
      const name = pair.slice(0, i).trim(), token = pair.slice(i + 1).trim();
      // A pair with no name or no token would let an empty Bearer header in.
      if (i > 0 && name && token) this.tokens.set(hash(token), name);
    }
  }
  get open() { return !this.password && this.tokens.size === 0; }
  checkPassword(p: string) {
    if (!this.password) return false;
    // Hash both sides so the compare takes the same time whatever the length.
    return timingSafeEqual(hashBuf(String(p ?? "")), hashBuf(this.password));
  }
  /** Wrong passwords per address: 10 in 10 minutes, then that address waits. Orb can
   *  place trades, so its one password must not be guessable at full speed. */
  static MAX_FAILS = 10;
  static FAIL_WINDOW = 10 * 60_000;
  private fails = new Map<string, number[]>();
  private recent(addr: string, now: number) { return (this.fails.get(addr) ?? []).filter(t => now - t < Auth.FAIL_WINDOW); }
  /** Minutes this address still has to wait, or 0 when it may try. */
  lockedFor(addr: string, now = Date.now()) {
    const r = this.recent(addr, now);
    return r.length >= Auth.MAX_FAILS ? Math.max(1, Math.ceil((r[0] + Auth.FAIL_WINDOW - now) / 60_000)) : 0;
  }
  noteFail(addr: string, now = Date.now()) {
    for (const [k, v] of this.fails) if (!v.some(t => now - t < Auth.FAIL_WINDOW)) this.fails.delete(k);
    this.fails.set(addr, [...this.recent(addr, now), now]);
  }
  clearFails(addr: string) { this.fails.delete(addr); }
  newSession() {
    this.prune();
    const t = randomBytes(32).toString("base64url");
    this.store.db.prepare("INSERT INTO sessions (token, created_at) VALUES (?, ?)").run(t, Date.now());
    return t;
  }
  endSession(t: string) { this.store.db.prepare("DELETE FROM sessions WHERE token = ?").run(t); }
  /** Sessions last as long as the cookie (30 days); older rows are refused and pruned. */
  static MAX_AGE = 30 * 864e5;
  prune() { this.store.db.prepare("DELETE FROM sessions WHERE created_at < ?").run(Date.now() - Auth.MAX_AGE); }
  /** Who is calling: "you" for a signed-in person, the token name for an
   *  agent, or null when not allowed. */
  who(req: FastifyRequest): string | null {
    const h = req.headers.authorization || "";
    if (h.startsWith("Bearer ")) { const t = h.slice(7).trim(); if (!t) return null; return this.tokens.get(hash(t)) ?? (this.devices.check(t) ? "you" : null); }
    const c = (req as any).cookies?.orb_session as string | undefined;
    if (c && this.store.db.prepare("SELECT 1 FROM sessions WHERE token = ? AND created_at >= ?").get(c, Date.now() - Auth.MAX_AGE)) return "you";
    return this.open ? "you" : null;
  }
  guard = async (req: FastifyRequest, reply: FastifyReply) => {
    const who = this.who(req);
    if (!who) return reply.code(401).send({ error: "Sign in first, or send an API token." });
    (req as any).who = who;
  };
}

const hashBuf = (s: string) => createHash("sha256").update(s).digest();
const hash = (s: string) => hashBuf(s).toString("hex");
