import Fastify, { FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import fstatic from "@fastify/static";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { Store } from "./db.js";
import { Records, HttpError, isColl, Change } from "./records.js";
import { Auth } from "./auth.js";
import { OrbConfig, loadConfig, secret } from "./config.js";
import { Upstream } from "./integrations/upstream.js";
import { uptime } from "./integrations/uptime.js";
import { hostStats, containers } from "./integrations/system.js";
import { chat, Msg } from "./integrations/llm.js";
import { call, trimSlash } from "./integrations/http.js";
import { orbTools } from "./tools.js";
import { mountMcp } from "./mcp.js";
import { logCommits } from "./pollers.js";

export const VERSION = "0.1.0";

export interface AppOptions { dataFile?: string; config?: OrbConfig; webDir?: string; password?: string; tokens?: string; logger?: boolean }

export async function buildApp(o: AppOptions = {}) {
  const store = new Store(o.dataFile ?? ":memory:");
  const base = o.config ?? loadConfig();
  // Settings saved from the web app (Settings → Connections, Golem) override orb.yaml.
  const cfg = (): OrbConfig => {
    const s: any = store.get("settings", "app") || {};
    const c = s.connections || {};
    return {
      ...base, logMax: Number(s.logMax) || base.logMax,
      golem: { ...base.golem, ...(s.golem || {}) },
      upstream: { ...base.upstream, ...(c.upstream || {}) },
      uptime: { ...base.uptime, ...(c.uptime || {}) },
      caldav: { ...base.caldav, ...(c.caldav || {}) },
      wiki: { ...base.wiki, ...(c.wiki || {}) },
      hermes: { ...base.hermes, ...(c.hermes || {}) },
    };
  };
  const records = new Records(store, cfg);
  const auth = new Auth(store, o.password ?? process.env.ORB_PASSWORD ?? "", o.tokens ?? process.env.ORB_API_TOKENS ?? "");
  const upstream = new Upstream(() => cfg().upstream.baseUrl, () => cfg().upstream.headerEnv);
  const tools = () => { const all = orbTools(records); return cfg().golem.canWrite ? all : all.filter(t => !t.write); };

  const app: FastifyInstance = Fastify({ logger: o.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cookie);
  app.setErrorHandler((e: any, _req, reply) => {
    const status = e instanceof HttpError ? e.status : e.statusCode && e.statusCode < 500 ? e.statusCode : 500;
    if (status >= 500 && !(e instanceof HttpError)) app.log.error(e);
    reply.code(status).send({ error: e.message || "Something went wrong." });
  });
  const guard = auth.guard;
  const who = (req: any) => req.who as string;

  // ---- health and sign-in ----
  app.get("/api/health", async () => ({ ok: true, version: VERSION, signIn: auth.open ? "open" : "password" }));
  app.post("/api/login", async (req, reply) => {
    const { password } = (req.body as any) || {};
    if (!auth.checkPassword(String(password || ""))) return reply.code(401).send({ error: "That password isn't right." });
    reply.setCookie("orb_session", auth.newSession(), { httpOnly: true, sameSite: "strict", path: "/", maxAge: 60 * 60 * 24 * 30, secure: req.protocol === "https" });
    return { ok: true };
  });
  app.post("/api/logout", async (req, reply) => { const c = (req as any).cookies?.orb_session; if (c) auth.endSession(c); reply.clearCookie("orb_session", { path: "/" }); return { ok: true }; });
  app.get("/api/me", { preHandler: guard }, async req => ({ who: who(req), open: auth.open }));

  // ---- records ----
  const coll = (c: string) => { if (!isColl(c)) throw new HttpError(404, `No collection ${c}.`); return c; };
  app.get("/api/c/:coll", { preHandler: guard }, async (req: any) => records.list(coll(req.params.coll)));
  app.get("/api/c/:coll/:id", { preHandler: guard }, async (req: any) => records.get(coll(req.params.coll), req.params.id) ?? (() => { throw new HttpError(404, "Not found."); })());
  app.post("/api/c/:coll", { preHandler: guard }, async (req: any, reply) => {
    const c = coll(req.params.coll), body = { ...(req.body || {}) };
    if (c === "logs" && !body.by && who(req) !== "you") body.by = who(req);
    const id = typeof body.id === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(body.id) ? body.id : undefined;
    reply.code(201); return records.create(c, body, id);
  });
  app.put("/api/c/:coll/:id", { preHandler: guard }, async (req: any) => records.put(coll(req.params.coll), req.params.id, req.body || {}));
  app.patch("/api/c/:coll/:id", { preHandler: guard }, async (req: any) => {
    const v = Number(String(req.headers["if-match"] || "").replace(/"/g, "")) || undefined;
    return records.patch(coll(req.params.coll), req.params.id, req.body || {}, v);
  });
  app.delete("/api/c/:coll/:id", { preHandler: guard }, async (req: any, reply) => { records.remove(coll(req.params.coll), req.params.id); reply.code(204).send(); });

  // ---- live updates (Server-Sent Events) ----
  app.get("/api/stream", { preHandler: guard }, (req, reply) => {
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    reply.raw.write(": connected\n\n");
    const send = (c: Change) => reply.raw.write(`event: change\ndata: ${JSON.stringify(c)}\n\n`);
    const beat = setInterval(() => reply.raw.write(": ping\n\n"), 25000);
    records.on("change", send);
    req.raw.on("close", () => { clearInterval(beat); records.off("change", send); });
  });

  // ---- UpstreamManager (runs on another computer; git happens there) ----
  app.get("/api/upstream/repos", { preHandler: guard }, async () => {
    const repos = await upstream.repos();
    // Attach GitHub owner/repo for pull-request links, best effort.
    await Promise.all((repos || []).map(async (r: any) => { try { const p = await upstream.publish(r.id); if (p?.owner && p?.github_repo) r.github = `${p.owner}/${p.github_repo}`; } catch { /* no remote */ } }));
    return repos;
  });
  app.get("/api/upstream/requests", { preHandler: guard }, async () => upstream.requests());
  app.get("/api/upstream/repo/:id/commits", { preHandler: guard }, async (req: any) => upstream.commits(req.params.id, Math.min(Number(req.query.limit) || 30, 200)));
  app.post("/api/upstream/repo/:id/fetch", { preHandler: guard }, async (req: any) => upstream.fetchRepo(req.params.id));
  app.post("/api/upstream/run-daily", { preHandler: guard }, async () => upstream.runDaily());
  app.post("/api/upstream/request/:id/decide", { preHandler: guard }, async (req: any) => {
    const { decision, comment, only } = req.body || {};
    if (decision !== "approve" && decision !== "deny") throw new HttpError(400, "decision must be approve or deny.");
    if (decision === "approve" && Array.isArray(only) && only.length) {
      const reqs: any[] = await upstream.requests(); const r = reqs.find(x => x.id === req.params.id);
      if (!r) throw new HttpError(404, "No such request.");
      const all = (r.components || r.upstreams || []).map((x: any) => x.name);
      if (only.length < all.length) return upstream.approvePart(r, only, comment);
    }
    return upstream.decide(req.params.id, decision, comment);
  });
  app.post("/api/upstream/poll", { preHandler: guard }, async () => ({ logged: await logCommits(records, upstream, cfg().logMax) }));

  // ---- Uptime Kuma, host stats ----
  app.get("/api/uptime", { preHandler: guard }, async () => uptime(cfg().uptime.baseUrl, cfg().uptime.statusPage));
  app.get("/api/system", { preHandler: guard }, async () => {
    const c = cfg().system;
    const stats = await hostStats(c.proc, c.disks);
    let ctr: any[] = []; let dockerError = "";
    try { ctr = await containers(c.docker); } catch (e: any) { dockerError = e?.message || String(e); }
    return { hosts: [{ name: process.env.ORB_HOSTNAME || hostname(), ...stats, containers: ctr, dockerError }] };
  });

  // ---- Golem ----
  app.post("/api/golem", { preHandler: guard }, async (req: any) => {
    const g = cfg().golem, msgs: Msg[] = ((req.body?.messages || []) as any[]).slice(-16).map(m => ({ role: m.role === "user" ? "user" : "assistant", content: String(m.content || "") }));
    if (!msgs.length || msgs[msgs.length - 1].role !== "user") throw new HttpError(400, "Send at least one user message.");
    const max = cfg().logMax;
    const system: Msg = { role: "system", content: `You are Golem, the stone servant of the Pondering Orb, a homelab dashboard. Speak plainly with a light touch of wizard flavour; be brief and concrete. Use Markdown for lists and emphasis. Use the tools to read the dashboard before answering questions about it. ${g.canWrite ? `When the user says they finished something or asks you to log it, call orb_add_log with a short entry (at most ${max} characters). When finished work matches an open task, offer to complete it.` : "You are read-only."} Today is ${new Date().toISOString().slice(0, 10)}.` };
    return chat({ baseUrl: g.baseUrl, model: g.model, key: secret(g.keyEnv), messages: [system, ...msgs], tools: tools(), who: who(req) });
  });

  // ---- settings helpers and connection tests ----
  app.get("/api/config", { preHandler: guard }, async () => {
    const c = cfg();
    return { logMax: c.logMax, golem: { baseUrl: c.golem.baseUrl, model: c.golem.model, keyEnv: c.golem.keyEnv, keySet: !!secret(c.golem.keyEnv), canWrite: c.golem.canWrite },
      upstream: { baseUrl: c.upstream.baseUrl }, uptime: c.uptime, caldav: { url: c.caldav.url, choresList: c.caldav.choresList, userSet: !!secret(c.caldav.userEnv) },
      wiki: { baseUrl: c.wiki.baseUrl, keySet: !!secret(c.wiki.tokenEnv), vault: c.wiki.vault }, hermes: { baseUrl: c.hermes.baseUrl, userSet: !!secret(c.hermes.userEnv) } };
  });
  app.post("/api/connections/test/:id", { preHandler: guard }, async (req: any) => {
    const c = cfg(), id = req.params.id;
    try {
      if (id === "upstream") { const r = await upstream.repos(); return { ok: true, detail: `Reached UpstreamManager: ${r.length} repo${r.length === 1 ? "" : "s"}.` }; }
      if (id === "uptime") { const r = await uptime(c.uptime.baseUrl, c.uptime.statusPage); return { ok: true, detail: `Reached Uptime Kuma: ${r.monitors.length} monitors on "${c.uptime.statusPage}".` }; }
      if (id === "golem") { const r = await call(`${trimSlash(c.golem.baseUrl)}/models`, { headers: secret(c.golem.keyEnv) ? { Authorization: `Bearer ${secret(c.golem.keyEnv)}` } : {} });
        if (!r.ok) return { ok: false, detail: `The model endpoint answered ${r.status}.` }; return { ok: true, detail: `Reached the model endpoint: ${(r.body?.data || []).length} models.` }; }
      if (id === "wiki") { const k = secret(c.wiki.tokenEnv); const r = await call(`${trimSlash(c.wiki.baseUrl)}/`, { headers: k ? { Authorization: `Bearer ${k}` } : {} });
        return { ok: r.ok && !!r.body?.authenticated, detail: r.ok ? (r.body?.authenticated ? "Reached the wiki and the key works." : "Reached the wiki, but the key wasn't accepted.") : `The wiki answered ${r.status}.` }; }
      if (id === "hermes") { const r = await call(`${trimSlash(c.hermes.baseUrl)}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: secret(c.hermes.userEnv), password: secret(c.hermes.passwordEnv) }) });
        return { ok: r.ok, detail: r.ok ? "Signed in to Hermes Studio." : `Hermes Studio answered ${r.status}${r.body?.error ? ": " + r.body.error : ""}.` }; }
      if (id === "caldav") { if (!c.caldav.url) return { ok: false, detail: "Set a CalDAV URL first." };
        const u = secret(c.caldav.userEnv), p = secret(c.caldav.passwordEnv);
        const r = await call(c.caldav.url, { method: "PROPFIND", headers: { Depth: "1", "Content-Type": "application/xml", ...(u ? { Authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") } : {}) }, body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>` });
        return { ok: r.status === 207, detail: r.status === 207 ? "Reached the CalDAV server." : `The CalDAV server answered ${r.status}.` }; }
      return { ok: false, detail: `No test for ${id}.` };
    } catch (e: any) { return { ok: false, detail: e.message }; }
  });

  mountMcp(app, tools, guard, VERSION);

  // ---- the web app ----
  const webDir = o.webDir ?? process.env.ORB_WEB;
  if (webDir && existsSync(webDir)) {
    await app.register(fstatic, { root: webDir, prefix: "/" });
    app.setNotFoundHandler((req, reply) => req.url.startsWith("/api/") || req.url.startsWith("/mcp") ? reply.code(404).send({ error: "Not found." }) : reply.sendFile("index.html"));
  }

  return { app, records, store, auth, upstream, cfg };
}
