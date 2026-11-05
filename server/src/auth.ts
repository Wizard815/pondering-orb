import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
    if (h.startsWith("Bearer ")) { const t = h.slice(7).trim(); return t ? this.tokens.get(hash(t)) ?? null : null; }
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
