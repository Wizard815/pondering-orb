import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Store } from "./db.js";

/** Two ways in:
 *  - People sign in with ORB_PASSWORD and get an HttpOnly session cookie.
 *  - Agents send `Authorization: Bearer <token>`; ORB_API_TOKENS holds
 *    "name:token" pairs, and the name is recorded as `by` on what they write.
 *  With neither set, Orb is open, which is only for a private LAN; the
 *  server warns about it on start. */
export class Auth {
  tokens = new Map<string, string>();
  constructor(private store: Store, private password = process.env.ORB_PASSWORD || "", tokens = process.env.ORB_API_TOKENS || "") {
    for (const pair of tokens.split(",").map(s => s.trim()).filter(Boolean)) {
      const i = pair.indexOf(":");
      if (i > 0) this.tokens.set(pair.slice(i + 1), pair.slice(0, i));
    }
  }
  get open() { return !this.password && this.tokens.size === 0; }
  checkPassword(p: string) {
    if (!this.password) return false;
    const a = Buffer.from(p), b = Buffer.from(this.password);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  newSession() {
    const t = randomBytes(32).toString("base64url");
    this.store.db.prepare("INSERT INTO sessions (token, created_at) VALUES (?, ?)").run(t, Date.now());
    return t;
  }
  endSession(t: string) { this.store.db.prepare("DELETE FROM sessions WHERE token = ?").run(t); }
  /** Who is calling: "you" for a signed-in person, the token name for an
   *  agent, or null when not allowed. */
  who(req: FastifyRequest): string | null {
    const h = req.headers.authorization || "";
    if (h.startsWith("Bearer ")) return this.tokens.get(h.slice(7).trim()) ?? null;
    const c = (req as any).cookies?.orb_session as string | undefined;
    if (c && this.store.db.prepare("SELECT 1 FROM sessions WHERE token = ?").get(c)) return "you";
    return this.open ? "you" : null;
  }
  guard = async (req: FastifyRequest, reply: FastifyReply) => {
    const who = this.who(req);
    if (!who) return reply.code(401).send({ error: "Sign in first, or send an API token." });
    (req as any).who = who;
  };
}
