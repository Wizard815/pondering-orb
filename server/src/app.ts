import Fastify, { FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import fstatic from "@fastify/static";
import { existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { dirname, join as pjoin } from "node:path";
import { Store } from "./db.js";
import { Records, HttpError, isColl, Change } from "./records.js";
import { Auth } from "./auth.js";
import { OrbConfig, loadConfig, secret, envSafe } from "./config.js";
import { Upstream } from "./integrations/upstream.js";
import { uptime } from "./integrations/uptime.js";
import { hostStats, containers } from "./integrations/system.js";
import { chat, chatStream, Msg, Tool } from "./integrations/llm.js";
import { widgetsFrom, widgetData } from "./integrations/widgets.js";
import { companion, companionByName, omiDays, omiConversations, omiSearchMemories, isOmiTask } from "./integrations/companions.js";
import { ffAccounts, ffOverview, ffRecent, ffSearch } from "./integrations/firefly.js";
import { cpSummary } from "./integrations/coinpile.js";
import { call, trimSlash } from "./integrations/http.js";
import { orbTools } from "./tools.js";
import { mountMcp } from "./mcp.js";
import { logCommits } from "./pollers.js";
import { CalDav } from "./integrations/caldav.js";
import { TaskSync } from "./sync.js";
import { Wiki, notePath, isNoteName } from "./integrations/wiki.js";
import { Hermes } from "./integrations/hermes.js";
import { AllGlance } from "./integrations/allglance.js";
import { Outbox } from "./outbox.js";
import { dailyApi } from "./daily.js";
import { marketApi } from "./market.js";
import { robinhoodApi } from "./robinhood.js";
import { journalApi } from "./journal.js";
import { serverApps, linkHost, appUrl, suggestions, unraidSystem, unraidContainers } from "./integrations/unraid.js";
import { today, localDay, isDay, timeZone } from "./dates.js";

export const VERSION = "0.1.0";
/** Without a data file (tests), journal images go to one temporary folder per process. */
let tmpFiles = "";
const tempFiles = () => (tmpFiles ||= mkdtempSync(pjoin(tmpdir(), "orb-journal-")));

export interface AppOptions { filesDir?: string; dataFile?: string; config?: OrbConfig; webDir?: string; password?: string; tokens?: string; logger?: boolean }

export async function buildApp(o: AppOptions = {}) {
  const store = new Store(o.dataFile ?? ":memory:");
  const base = o.config ?? loadConfig();
  // Settings saved from the web app (Settings → Connections, Golem) override orb.yaml.
  const cfg = (): OrbConfig => {
    const s: any = store.get("settings", "app") || {};
    const c = s.connections || {};
    const out: OrbConfig = {
      ...base, logMax: Math.max(20, Math.min(200, Number(s.logMax) || base.logMax || 50)),
      golem: { ...base.golem, ...envSafe(s.golem) },
      upstream: { ...base.upstream, ...envSafe(c.upstream) },
      uptime: { ...base.uptime, ...envSafe(c.uptime) },
      caldav: { ...base.caldav, ...envSafe(c.caldav) },
      // The vault mount path is fixed by orb.yaml / compose, never by settings.
      wiki: { ...base.wiki, ...envSafe(c.wiki), vault: base.wiki.vault },
      hermes: { ...base.hermes, ...envSafe(c.hermes) },
      allglance: { ...base.allglance, ...envSafe(c.allglance) },
      unraid: { ...base.unraid, ...envSafe(c.unraid) },
    };
    // The ALLGlance stack serves Vikunja's CalDAV at the gateway's /dav: with
    // no CalDAV URL of its own, Orb uses that one address for tasks too.
    if (!out.caldav.url && out.allglance.baseUrl) out.caldav = { ...out.caldav, url: trimSlash(out.allglance.baseUrl) + "/dav/" };
    return out;
  };
  const records = new Records(store, cfg);
  const outbox = new Outbox(store, () => records.emit("outbox")); // browsers refresh the "waiting to sync" pill
  const auth = new Auth(store, o.password ?? process.env.ORB_PASSWORD ?? "", o.tokens ?? process.env.ORB_API_TOKENS ?? "");
  const upstream = new Upstream(() => cfg().upstream.baseUrl, () => cfg().upstream.headerEnv);
  const dav = new CalDav(() => cfg().caldav.url, () => ({ user: secret(cfg().caldav.userEnv), pass: secret(cfg().caldav.passwordEnv) }));
  const sync = new TaskSync(records, dav, cfg, outbox);
  const wiki = new Wiki(() => cfg().wiki.baseUrl, () => secret(cfg().wiki.tokenEnv), () => cfg().wiki.vault);
  const hermes = new Hermes(() => cfg().hermes.baseUrl, () => ({ user: secret(cfg().hermes.userEnv), pass: secret(cfg().hermes.passwordEnv) }), () => cfg().hermes.publicUrl || "");
  const glance = new AllGlance(() => cfg().allglance.baseUrl, () => secret(cfg().allglance.tokenEnv));
  // The board's five states map onto the wiki's three; only project_status is written.
  const WIKI_STATUS: Record<string, string> = { next: "active", active: "active", blocked: "active", paused: "paused", shipped: "done" };
  const lastStatus = new Map((store.list("projects") as any[]).map(p => [p.id, p.status]));
  records.on("change", (c: Change) => {
    if (c.coll !== "projects" || c.op !== "set" || !c.doc) return;
    const p: any = c.doc, before = lastStatus.get(p.id); lastStatus.set(p.id, p.status);
    if (!p.wikiNote || !before || before === p.status || WIKI_STATUS[before] === WIKI_STATUS[p.status] || !cfg().wiki.baseUrl) return;
    const ws = WIKI_STATUS[p.status] || "active";
    wikiWrite(`Set ${p.name}'s wiki project_status to ${ws}`, [
      { type: "front", path: p.wikiNote, key: "project_status", value: ws },
      { type: "front", path: p.wikiNote, key: "updated", value: today() },
      { type: "log", line: `[[${p.name}]]: project_status set to ${ws}` }], `status:${p.id}`);
  });
  /** Background wiki writes: tried now, queued in the outbox when the wiki is unreachable. */
  type WikiOp = { type: "front"; path: string; key: string; value: unknown } | { type: "log"; line: string };
  const runWikiOps = async (ops: WikiOp[]) => { for (const op of ops) op.type === "front" ? await wiki.setFront(op.path, op.key, op.value) : await wiki.log(op.line); };
  outbox.on("wiki", (p: { ops: WikiOp[] }) => runWikiOps(p.ops));
  function wikiWrite(label: string, ops: WikiOp[], key?: string) {
    // Success drops an older queued write for the same thing, so a stale
    // retry can't overwrite this newer one.
    runWikiOps(ops).then(() => { if (key) outbox.drop(`wiki:${key}`); }, e => { app.log.warn({ err: e.message }, "wiki write queued"); outbox.add("wiki", label, { ops }, e.message, key); });
  }
  const glanceTools = () => !cfg().allglance.baseUrl ? [] : [
    { name: "allglance_day", description: "The day's plan from dayGLANCE through the ALLGlance gateway: time blocks with start time and length. date is YYYY-MM-DD (default today).",
      parameters: { type: "object", properties: { date: { type: "string" } } }, run: ({ date }: any) => glance.day(/^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : today()) },
    { name: "allglance_dayglance_tasks", description: "dayGLANCE tasks (the inbox and every scheduled day) with priority 0 none to 5 do now.", parameters: { type: "object", properties: {} }, run: () => glance.dayglanceTasks() },
  ];
  const appsYaml = () => String((store.get("settings", "apps") as any)?.yaml || "");
  /** Golem's read-only tools for Firefly III and Omi, when they're in the apps YAML. */
  const companionTools = (): Tool[] => {
    const om = companion(appsYaml(), "omi"), ff = companion(appsYaml(), "firefly"), cp = companion(appsYaml(), "coinpile");
    return [
      ...(cp ? [{ name: "coinpile_summary", description: "Coinpile (the friendly view over Firefly III): what you share with the Orb: net worth, subscriptions per month, bills due, savings set aside vs free, goals and their progress (pct 0-1), alerts (CDs maturing, a bank to sign in again, accounts running short), this month's spending forecast and Robinhood value. Read only; never transactions.",
        parameters: { type: "object", properties: {} }, run: () => cpSummary(cp) }] : []),
      ...(ff ? [
        { name: "finance_summary", description: "Firefly III this month: net worth, balance, spent, earned, left to spend, bills paid and unpaid; plus bills due in the next 30 days, budgets (limit, spent, % used) and piggy banks. Read only.",
          parameters: { type: "object", properties: {} }, run: () => ffOverview(ff) },
        { name: "finance_accounts", description: "Firefly III asset and liability accounts with their current balances. Read only.", parameters: { type: "object", properties: {} }, run: () => ffAccounts(ff) },
        { name: "finance_search_transactions", description: "Search Firefly III transactions with its search syntax, e.g. 'amazon', 'category:Groceries date_after:2026-10-01', 'amount_more:100'. Returns date, description, amount (negative = spent), category, budget, accounts. Read only.",
          parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] }, run: ({ query, limit }: any) => ffSearch(ff, String(query || ""), Number(limit) || 25) },
      ] : []),
      ...(om ? [
        { name: "omi_search_memories", description: "Search the user's Omi memories (things Omi learned from their conversations). Read only.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          run: ({ query }: any) => omiSearchMemories(om, String(query || ""), 10) },
        { name: "omi_daily_summary", description: "Omi's recap of a day (headline, overview, decisions, open questions). date is YYYY-MM-DD; empty for the latest. Read only.", parameters: { type: "object", properties: { date: { type: "string" } } },
          run: async ({ date }: any) => (await omiDays(om, 1, String(date || "")))[0] || { none: true } },
        { name: "omi_recent_conversations", description: "The user's most recent Omi conversations: title and overview. Read only.", parameters: { type: "object", properties: { limit: { type: "number" } } },
          run: ({ limit }: any) => omiConversations(om, Number(limit) || 5) },
      ] : []),
    ];
  };
  // Read-only tools for the wiki (search, read a note) and linked Hermes chats.
  const readTools = (): Tool[] => [
    ...(cfg().wiki.baseUrl ? [
      { name: "wiki_search", description: "Search the LLMWIKI vault's text. Returns note paths with a snippet.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        run: async ({ query }: any) => (await wiki.search(String(query || ""))).slice(0, 10) },
      { name: "wiki_read", description: "Read one LLMWIKI note (front-matter and body) by its path, e.g. wiki/1-projects/Argos.md. Read only.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        run: async ({ path }: any) => { const n = await wiki.note(notePath(path)); return { ...n, body: n.body.slice(0, 12000) }; } },
    ] : []),
    { name: "journal_day", description: "The user's journal for a day: what they typed, how many drawing pages, and the day's log Orb put together (money spent and earned, tasks and chores done, log entries, commits, UpstreamManager requests, Hermes Studio agent work, Omi's recap, calendar, stock-pick calls, alerts). date is YYYY-MM-DD (default today). Read only.",
      parameters: { type: "object", properties: { date: { type: "string" } } },
      run: async ({ date }: any) => { const d = isDay(date) && date <= today() ? date : today(); const j: any = records.get("journal", d) || {};
        return { date: d, text: String(j.text || "").slice(0, 8000), drawingPages: (j.pages || []).length, log: await journal.autoFor(d) }; } },
    ...companionTools(),
    ...(cfg().hermes.baseUrl ? [
      { name: "project_chats", description: "The Hermes chats linked to a project, with their newest messages. Read only.", parameters: { type: "object", properties: { project: { type: "string" } }, required: ["project"] },
        run: async ({ project }: any) => { const p: any = records.list("projects").find((x: any) => String(x.name).toLowerCase() === String(project).toLowerCase()); if (!p) throw new Error(`No project named ${project}`);
          return Promise.all((p.chats || []).slice(0, 5).map((id: string) => hermes.session(id, 12).catch(e => ({ id, error: e.message })))); } },
    ] : []),
  ];
  const tools = () => { const all = [...orbTools(records), ...glanceTools(), ...readTools()]; return cfg().golem.canWrite ? all : all.filter(t => !(t as any).write); };

  const app: FastifyInstance = Fastify({ logger: o.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cookie);
  // Only JSON bodies. A text/plain or form POST is a "simple" cross-site
  // request that any web page could send to a LAN dashboard.
  app.removeContentTypeParser("text/plain");
  // Refuse writes from other sites (browsers send Origin / Sec-Fetch-Site),
  // which matters most in open mode where there is no sign-in at all.
  app.addHook("onRequest", async (req, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || !req.url.startsWith("/api/") && !req.url.startsWith("/mcp")) return;
    const site = String(req.headers["sec-fetch-site"] || ""), origin = String(req.headers.origin || "");
    let cross = site === "cross-site";
    if (!cross && origin && origin !== "null") { try { const h = new URL(origin).host; cross = h !== req.headers.host && h !== String(req.headers["x-forwarded-host"] || "").split(",")[0].trim(); } catch { cross = true; } }
    if (cross) return reply.code(403).send({ error: "Requests from other sites are refused." });
  });
  app.setErrorHandler((e: any, _req, reply) => {
    const status = e instanceof HttpError ? e.status : e.statusCode && e.statusCode < 500 ? e.statusCode : 500;
    if (status >= 500 && !(e instanceof HttpError)) app.log.error(e);
    reply.code(status).send({ error: e.message || "Something went wrong." });
  });
  const guard = auth.guard;
  const who = (req: any) => req.who as string;

  // ---- health and sign-in ----
  app.get("/api/health", async () => ({ ok: true, version: VERSION, signIn: auth.open ? "open" : "password", timeZone: timeZone() }));
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
  /** What a caller may write. Agents (API tokens) can't change settings, so
   *  they can't point a connection at another host or name another secret.
   *  Sync bookkeeping (`caldav`) is the server's own: a client-set href would
   *  send the CalDAV login wherever it points. Agents sign their own logs. */
  const writable = (req: any, c: string, id?: string) => {
    if (c === "settings" && who(req) !== "you") throw new HttpError(403, "Only a signed-in person can change settings.");
    // The brief, research and stock picks are written by Orb; only you decide on a pick.
    if (c === "orders") throw new HttpError(403, "Orders are written by Orb when you place one.");
    if ((c === "daily" || c === "picks" || c === "research" || c === "journal" || c === "ink") && who(req) !== "you") throw new HttpError(403, "Only a signed-in person can change these.");
    const raw = req.body ?? {};
    if (typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "Send a JSON object.");
    const body: Record<string, any> = { ...raw };
    if (c === "settings" && body.btopUrl && !/^https?:\/\//i.test(String(body.btopUrl))) throw new HttpError(422, "The btop address must start with http:// or https://.");
    if (c === "tasks" || c === "chores") {
      const cur: any = id && records.get(c, id);
      // Omi's action items reach Orb through CalDAV and are read only here: change them in Omi.
      if (c === "tasks" && isOmiTask(cur?.caldav?.uid)) throw new HttpError(403, "This task comes from Omi. Change it in Omi; Orb only reads it.");
      delete body.caldav; delete body.source; if (cur?.caldav && req.method === "PUT") { body.caldav = cur.caldav; body.source = cur.source; }
    }
    // The journal's day log is Orb's to write; a save from the page keeps it.
    if (c === "journal") { delete body.auto; const cur: any = id && records.get("journal", id); if (cur?.auto && req.method === "PUT") body.auto = cur.auto; }
    if (c === "logs" && who(req) !== "you" && (req.method === "POST" || "by" in body)) body.by = who(req);
    return body;
  };
  app.post("/api/c/:coll", { preHandler: guard }, async (req: any, reply) => {
    const c = coll(req.params.coll), body = writable(req, c);
    const id = typeof body.id === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(body.id) ? body.id : undefined;
    reply.code(201); return records.create(c, body, id);
  });
  app.put("/api/c/:coll/:id", { preHandler: guard }, async (req: any) => { const c = coll(req.params.coll); return records.put(c, req.params.id, writable(req, c, req.params.id)); });
  app.patch("/api/c/:coll/:id", { preHandler: guard }, async (req: any) => {
    const m = String(req.headers["if-match"] || "").trim(), v = m ? Number(m.replace(/^W\//, "").replace(/"/g, "")) : undefined;
    if (m && !Number.isInteger(v)) throw new HttpError(400, "If-Match must be a record version, like \"3\".");
    const c = coll(req.params.coll); return records.patch(c, req.params.id, writable(req, c, req.params.id), v);
  });
  app.delete("/api/c/:coll/:id", { preHandler: guard }, async (req: any, reply) => {
    const c = coll(req.params.coll);
    // Deletes follow the same rules as writes (an agent can't remove settings, picks or orders).
    if (c === "orders") throw new HttpError(403, "Orders are kept as a record.");
    if (["settings", "daily", "picks", "research", "journal", "ink"].includes(c) && who(req) !== "you") throw new HttpError(403, "Only a signed-in person can delete these.");
    if (c === "tasks" && isOmiTask((records.get("tasks", req.params.id) as any)?.caldav?.uid)) throw new HttpError(403, "This task comes from Omi. Change it in Omi; Orb only reads it.");
    records.remove(c, req.params.id); reply.code(204).send();
  });

  /** Rename a project. Logs are filed by project name, so they move with it;
   *  a task list named after the project keeps its name (it lives in CalDAV)
   *  and stays linked. The wiki note keeps its file: Orb never moves vault files. */
  app.post("/api/projects/:id/rename", { preHandler: guard }, async (req: any) => {
    const p: any = records.get("projects", req.params.id); if (!p) throw new HttpError(404, "No such project.");
    const name = String(req.body?.name ?? "").trim(), old = p.name;
    if (name === old) return { project: p, logs: 0 };
    const taskList = p.taskList || ((records.list("tasks") as any[]).some(t => (t.list || "Inbox") === old) ? old : undefined);
    const project = records.patch("projects", p.id, { name, ...(taskList ? { taskList } : {}) }); // checks name and uniqueness
    let logs = 0;
    for (const l of records.list("logs") as any[]) if (l.project === old) { records.patch("logs", l.id, { project: name }); logs++; }
    return { project, logs, taskList: taskList || "" };
  });

  const daily = dailyApi(app, { records, dav, cfg, guard, who, glance });
  const market = marketApi(app, { records, cfg, guard, who });
  robinhoodApi(app, { records, store, guard, who });
  const journal = journalApi(app, { records, cfg, guard, who, upstream, hermes, outbox, appsYaml, events: daily.events,
    filesDir: o.filesDir ?? (o.dataFile && o.dataFile !== ":memory:" ? pjoin(dirname(o.dataFile), "journal") : tempFiles()) });

  // ---- live updates (Server-Sent Events) ----
  app.get("/api/stream", { preHandler: guard }, (req, reply) => {
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    reply.raw.write(": connected\n\n");
    const send = (c: Change) => reply.raw.write(`event: change\ndata: ${JSON.stringify({ coll: c.coll, id: c.id, op: c.op, doc: c.doc })}\n\n`);
    const ob = () => reply.raw.write("event: outbox\ndata: {}\n\n");
    const beat = setInterval(() => reply.raw.write(": ping\n\n"), 25000);
    records.on("change", send); records.on("outbox", ob); streams.add(reply.raw);
    req.raw.on("close", () => { clearInterval(beat); records.off("change", send); records.off("outbox", ob); streams.delete(reply.raw); });
  });
  // On shutdown (docker stop) end the open streams, or close() would wait on
  // them forever; browsers then reconnect to the new server.
  const streams = new Set<import("node:http").ServerResponse>();
  app.addHook("preClose", async () => { for (const s of streams) s.end(); streams.clear(); });

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
  // ---- Links: the server's containers (Unraid Management Agent and/or Docker), with where each answers ----
  let appsCache: { at: number; key: string; v: Awaited<ReturnType<typeof serverApps>> } | null = null;
  const linkApps = async () => {
    const c = cfg(), key = `${c.unraid.baseUrl}|${c.system.docker}|${c.unraid.tokenEnv}|${secret(c.unraid.tokenEnv)}`;
    if (!appsCache || appsCache.key !== key || Date.now() - appsCache.at > 30000) appsCache = { at: Date.now(), key, v: await serverApps({ base: c.unraid.baseUrl, token: secret(c.unraid.tokenEnv), dockerHost: c.system.docker }) };
    return appsCache.v;
  };
  /** The page passes its own host name, used when neither a link address nor the agent's is known. */
  const hostFor = (q: unknown) => { const c = cfg(), h = linkHost(c.unraid.linkHost, c.unraid.baseUrl); if (h) return h; const v = String(q || ""); return /^[A-Za-z0-9.-]{1,253}$|^\[[0-9a-fA-F:]+\]$/.test(v) ? v : ""; };
  app.get("/api/links", { preHandler: guard }, async (req: any) => {
    const { apps, notes, sources } = await linkApps(), host = hostFor(req.query.host);
    return { host, sources, notes, apps: apps.map(a => ({ ...a, url: appUrl(a, host) })) };
  });
  app.get("/api/links/suggest", { preHandler: guard }, async (req: any) => {
    const c: any = cfg(), host = hostFor(req.query.host);
    return suggestions((await linkApps()).apps, host, (conn, field) => String(c[conn]?.[field] || ""));
  });

  app.get("/api/uptime", { preHandler: guard }, async () => uptime(cfg().uptime.baseUrl, cfg().uptime.statusPage));
  app.get("/api/system", { preHandler: guard }, async () => {
    const c = cfg().system;
    const stats = await hostStats(c.proc, c.disks);
    let ctr: any[] = []; let dockerError = "";
    try { ctr = await containers(c.docker); } catch (e: any) { dockerError = e?.message || String(e); }
    return { hosts: [{ name: process.env.ORB_HOSTNAME || hostname(), ...stats, containers: ctr, dockerError }] };
  });

  // ---- Golem ----
  const golemMessages = (body: any): Msg[] => {
    const msgs: Msg[] = ((body?.messages || []) as any[]).slice(-16).map(m => ({ role: m.role === "user" ? "user" : "assistant", content: String(m.content || "") }));
    if (!msgs.length || msgs[msgs.length - 1].role !== "user") throw new HttpError(400, "Send at least one user message.");
    return [golemSystem(), ...msgs];
  };
  // Streams Golem's reply as Server-Sent Events: text deltas, tool names, then done.
  app.post("/api/golem/stream", { preHandler: guard }, async (req: any, reply) => {
    const g = cfg().golem, messages = golemMessages(req.body), ctl = new AbortController();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // The response closing before we end it means the browser stopped (Stop,
    // or the tab went away): abort the model and skip any further tool rounds.
    reply.hijack();
    reply.raw.on("close", () => { if (!reply.raw.writableEnded) ctl.abort(); });
    try {
      const r = await chatStream({ baseUrl: g.baseUrl, model: g.model, key: secret(g.keyEnv), messages, tools: tools(), who: who(req), signal: ctl.signal,
        onEvent: e => send(e.type, e.type === "text" ? { delta: e.delta } : { name: e.name }) });
      send("done", r);
    } catch (e: any) { if (!ctl.signal.aborted) send("error", { error: e.message }); }
    reply.raw.end();
  });
  app.post("/api/golem", { preHandler: guard }, async (req: any) => {
    const g = cfg().golem;
    return chat({ baseUrl: g.baseUrl, model: g.model, key: secret(g.keyEnv), messages: golemMessages(req.body), tools: tools(), who: who(req) });
  });
  function golemSystem(): Msg {
    const g = cfg().golem, max = cfg().logMax;
    return { role: "system", content: `You are Golem, the stone servant of the Pondering Orb, a homelab dashboard. Speak plainly with a light touch of wizard flavour; be brief and concrete. Use Markdown for lists and emphasis. Use the tools to read the dashboard before answering questions about it. ${g.canWrite ? `When the user says they finished something or asks you to log it, call orb_add_log with a short entry (at most ${max} characters). When finished work matches an open task, offer to complete it.` : "You are read-only."} ${cfg().wiki.baseUrl ? " Use wiki_search and wiki_read to look things up in the user's notes." : ""}${cfg().hermes.baseUrl ? " project_chats reads chats linked to a project." : ""} Today is ${today()}.` };
  }

  // ---- settings helpers and connection tests ----
  app.get("/api/config", { preHandler: guard }, async () => {
    const c = cfg();
    return { logMax: c.logMax, golem: { baseUrl: c.golem.baseUrl, model: c.golem.model, keyEnv: c.golem.keyEnv, keySet: !!secret(c.golem.keyEnv), canWrite: c.golem.canWrite },
      // Variable names (never their values), so the Settings forms show them.
      upstream: { baseUrl: c.upstream.baseUrl, headerEnv: c.upstream.headerEnv || "" }, uptime: c.uptime,
      caldav: { url: c.caldav.url, choresList: c.caldav.choresList, userEnv: c.caldav.userEnv, passwordEnv: c.caldav.passwordEnv, userSet: !!secret(c.caldav.userEnv) },
      wiki: { baseUrl: c.wiki.baseUrl, tokenEnv: c.wiki.tokenEnv, keySet: !!secret(c.wiki.tokenEnv), vault: c.wiki.vault, mount: await wiki.hasMount() },
      hermes: { baseUrl: c.hermes.baseUrl, userEnv: c.hermes.userEnv, passwordEnv: c.hermes.passwordEnv, userSet: !!secret(c.hermes.userEnv) },
      allglance: { baseUrl: c.allglance.baseUrl, tokenEnv: c.allglance.tokenEnv, tokenSet: !!secret(c.allglance.tokenEnv) },
      unraid: { baseUrl: c.unraid.baseUrl, tokenEnv: c.unraid.tokenEnv, tokenSet: !!secret(c.unraid.tokenEnv), linkHost: c.unraid.linkHost } };
  });
  app.post("/api/connections/test/:id", { preHandler: guard }, async (req: any) => {
    const c = cfg(), id = req.params.id;
    try {
      if (id === "unraid") { const s = await unraidSystem(c.unraid.baseUrl, secret(c.unraid.tokenEnv)); const a = await unraidContainers(c.unraid.baseUrl, secret(c.unraid.tokenEnv));
        return { ok: true, detail: `Reached the Unraid Management Agent on ${s.hostname || "the server"}${s.version ? ` (Unraid ${s.version})` : ""}: ${a.length} container${a.length === 1 ? "" : "s"}.` }; }
      if (id === "upstream") { const r = await upstream.repos(); return { ok: true, detail: `Reached UpstreamManager: ${r.length} repo${r.length === 1 ? "" : "s"}.` }; }
      if (id === "uptime") { const r = await uptime(c.uptime.baseUrl, c.uptime.statusPage); return { ok: true, detail: `Reached Uptime Kuma: ${r.monitors.length} monitors on "${c.uptime.statusPage}".` }; }
      if (id === "golem") { const r = await call(`${trimSlash(c.golem.baseUrl)}/models`, { headers: secret(c.golem.keyEnv) ? { Authorization: `Bearer ${secret(c.golem.keyEnv)}` } : {} });
        if (!r.ok) return { ok: false, detail: `The model endpoint answered ${r.status}.` }; return { ok: true, detail: `Reached the model endpoint: ${(r.body?.data || []).length} models.` }; }
      if (id === "wiki") { const k = secret(c.wiki.tokenEnv); const r = await call(`${trimSlash(c.wiki.baseUrl)}/`, { headers: k ? { Authorization: `Bearer ${k}` } : {} });
        return { ok: r.ok && !!r.body?.authenticated, detail: r.ok ? (r.body?.authenticated ? "Reached the wiki and the key works." : "Reached the wiki, but the key wasn't accepted.") : `The wiki answered ${r.status}.` }; }
      if (id === "allglance") { const h = await glance.health(); const a = h?.adapters || {}; const up = Object.entries(a).filter(([, v]: any) => v?.ok).map(([k]) => k);
        await glance.users(); return { ok: true, detail: `Reached the ALLGlance gateway. Working: ${up.join(", ") || "none"}${Object.keys(a).length > up.length ? `; not working: ${Object.keys(a).filter(k => !up.includes(k)).join(", ")}` : ""}.` }; }
      if (id === "hermes") { const r = await call(`${trimSlash(c.hermes.baseUrl)}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: secret(c.hermes.userEnv), password: secret(c.hermes.passwordEnv) }) });
        return { ok: r.ok, detail: r.ok ? "Signed in to Hermes Studio." : `Hermes Studio answered ${r.status}${r.body?.error ? ": " + r.body.error : ""}.` }; }
      if (id === "caldav") { if (!c.caldav.url) return { ok: false, detail: "Set a CalDAV URL first." };
        const u = secret(c.caldav.userEnv), p = secret(c.caldav.passwordEnv);
        const r = await call(c.caldav.url, { method: "PROPFIND", headers: { Depth: "1", "Content-Type": "application/xml", ...(u ? { Authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") } : {}) }, body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>` });
        return { ok: r.status === 207, detail: r.status === 207 ? "Reached the CalDAV server." : `The CalDAV server answered ${r.status}.` }; }
      return { ok: false, detail: `No test for ${id}.` };
    } catch (e: any) { return { ok: false, detail: e.message }; }
  });

  // ---- CalDAV tasks and chores ----
  app.get("/api/caldav/status", { preHandler: guard }, async () => ({ configured: dav.configured, lists: sync.lists.map(l => l.name), lastSync: sync.lastSync, lastError: sync.lastError, choresList: cfg().caldav.choresList }));
  app.post("/api/caldav/sync", { preHandler: guard }, async () => sync.pull());

  // ---- LLMWIKI (reads from the read-only mount when present; writes over REST) ----
  app.get("/api/wiki/tree", { preHandler: guard }, async () => ({ mount: await wiki.hasMount(), notes: await wiki.tree() }));
  app.get("/api/wiki/note", { preHandler: guard }, async (req: any) => wiki.note(notePath(req.query.path)));
  app.get("/api/wiki/search", { preHandler: guard }, async (req: any) => wiki.search(String(req.query.q || "")));
  app.post("/api/wiki/section", { preHandler: guard }, async (req: any) => {
    const { path, heading, text } = req.body || {};
    if (!["Current state", "Next steps"].includes(heading)) throw new HttpError(400, "Orb edits only Current state and Next steps.");
    const n = notePath(path, true), title = n.split("/").pop()!.replace(/\.md$/, "");
    await wiki.replaceSection(n, heading, String(text || ""), `[[${title}]]: edited ${heading}`);
    return wiki.note(n);
  });
  const HUBS: Record<string, string> = { homelab: "Homelab", ai: "Local AI", ...(((base as any).wiki?.areaHubs) || {}) };
  app.post("/api/wiki/project", { preHandler: guard }, async (req: any) => {
    const { projectId, area } = req.body || {};
    const p: any = records.get("projects", String(projectId)); if (!p) throw new HttpError(404, "No such project.");
    const areas = ["ai", "homelab", "automation", "hardware", "ttrpg", "gaming", "travel", "personal", "knowledge"];
    if (!areas.includes(area)) throw new HttpError(400, `Area must be one of ${areas.join(", ")}.`);
    const hub = HUBS[area] || area[0].toUpperCase() + area.slice(1);
    const r = await wiki.createProject(p.name, area, WIKI_STATUS[p.status] || "active", p.next || "", hub);
    records.patch("projects", p.id, { wikiNote: r.path, area });
    return r;
  });

  // ---- ALLGlance gateway: dayGLANCE day plan and inbox, lastGLANCE chores, lifeGLANCE milestones ----
  const dateParam = (v: unknown) => { const s = String(v || today()); if (!isDay(s)) throw new HttpError(400, "date must be YYYY-MM-DD."); return s; };
  app.get("/api/allglance/day", { preHandler: guard }, async (req: any) => glance.day(dateParam(req.query.date), req.query.owner));
  app.get("/api/allglance/dayglance-tasks", { preHandler: guard }, async (req: any) => glance.dayglanceTasks(req.query.owner));
  app.get("/api/allglance/chores", { preHandler: guard }, async (req: any) => glance.chores(req.query.owner));
  app.get("/api/allglance/milestones", { preHandler: guard }, async () => glance.milestones());
  app.get("/api/allglance/users", { preHandler: guard }, async () => glance.users());
  /** Add an event to the family calendar (a dayGLANCE block) through the gateway. */
  app.post("/api/allglance/events", { preHandler: guard }, async (req: any, reply) => {
    const b = req.body || {}, title = String(b.title || "").trim();
    if (!title) throw new HttpError(422, "An event needs a title.");
    if (!isDay(String(b.date || ""))) throw new HttpError(422, "date must be YYYY-MM-DD.");
    if (b.time && !/^\d{2}:\d{2}$/.test(String(b.time))) throw new HttpError(422, "time must be HH:MM.");
    const minutes = b.minutes ? Math.max(5, Math.min(24 * 60, Math.round(Number(b.minutes)) || 0)) : undefined;
    reply.code(201);
    return glance.addEvent({ title: title.slice(0, 200), date: String(b.date), time: b.time ? String(b.time) : undefined, minutes, owner: b.owner ? String(b.owner) : undefined });
  });

  // ---- Hermes Studio chats (read only) ----
  app.get("/api/hermes/sessions", { preHandler: guard }, async (req: any) => hermes.sessions(String(req.query.q || "")));
  // ---- Orb's work in Hermes Studio: watch the chats, and send a plan to a new one ----
  app.get("/api/hermes/agents", { preHandler: guard }, async () => hermes.agents());
  app.get("/api/hermes/agent-kinds", { preHandler: guard }, async () => hermes.agentKinds());
  app.post("/api/hermes/launch", { preHandler: guard }, async (req: any) => {
    const b = req.body || {};
    const agentId = String(b.agentId || ""), title = String(b.title || "").trim(), prompt = String(b.prompt || "").trim();
    if (!agentId || !title || !prompt) throw new HttpError(400, "agentId, title and prompt are required.");
    const orb = b.orb?.task?.title ? { task: { title: String(b.orb.task.title), list: String(b.orb.task.list || "") } } : b.orb?.project ? { project: String(b.orb.project) } : undefined;
    const out = await hermes.launch({ agentId, title, prompt: prompt.slice(0, 20000), workspace: b.workspace ? String(b.workspace) : undefined, orb });
    // The project log shows where the plan went.
    if (b.project) { try { const who = (req as any).who; records.create("logs", { project: String(b.project), text: `Sent to ${agentId} in Hermes Studio`.slice(0, records.logMax()), by: who === "you" ? "orb" : who }); } catch { /* the launch already happened */ } }
    return out;
  });

  // ---- writes waiting to reach another app ----
  app.get("/api/outbox", { preHandler: guard }, async () => outbox.list().map(({ payload: _p, ...it }) => it));
  app.post("/api/outbox/retry", { preHandler: guard }, async () => outbox.flush(true));
  app.delete("/api/outbox/:id", { preHandler: guard }, async (req: any, reply) => { outbox.drop(req.params.id); reply.code(204).send(); });

  // ---- live app panels (Plex, SABnzbd) from the apps YAML ----
  // Full pages for Firefly III and Omi (page: true in the apps YAML). Read only, like the widgets.
  const comp = (name: string, type: string) => { const c = companionByName(appsYaml(), name); if (!c || c.type !== type) throw new HttpError(404, `No ${type} app called ${name} in the apps YAML.`); return c; };
  app.get("/api/apps/:name/coinpile", { preHandler: guard }, async (req: any) => cpSummary(comp(req.params.name, "coinpile")));
  app.get("/api/apps/:name/firefly/overview", { preHandler: guard }, async (req: any) => ffOverview(comp(req.params.name, "firefly")));
  app.get("/api/apps/:name/firefly/accounts", { preHandler: guard }, async (req: any) => ffAccounts(comp(req.params.name, "firefly")));
  app.get("/api/apps/:name/firefly/transactions", { preHandler: guard }, async (req: any) => req.query.q ? ffSearch(comp(req.params.name, "firefly"), String(req.query.q), 50) : ffRecent(comp(req.params.name, "firefly"), Number(req.query.limit) || 25));
  app.get("/api/apps/:name/omi/days", { preHandler: guard }, async (req: any) => omiDays(comp(req.params.name, "omi"), Number(req.query.limit) || 14, "", Number(req.query.offset) || 0));
  app.get("/api/apps/:name/omi/conversations", { preHandler: guard }, async (req: any) => omiConversations(comp(req.params.name, "omi"), Number(req.query.limit) || 25));
  app.get("/api/apps/:name/omi/memories", { preHandler: guard }, async (req: any) => omiSearchMemories(comp(req.params.name, "omi"), String(req.query.q || ""), 20));
  app.get("/api/widgets/:name", { preHandler: guard }, async (req: any) => {
    const w = widgetsFrom(String((store.get("settings", "apps") as any)?.yaml || ""))[req.params.name];
    if (!w) throw new HttpError(404, `${req.params.name} has no widget in the apps YAML.`);
    return widgetData(req.params.name, w);
  });

  // ---- wiki related links (add only) ----
  app.post("/api/wiki/related", { preHandler: guard }, async (req: any) => {
    const { path, titles } = req.body || {};
    if (!Array.isArray(titles)) throw new HttpError(400, "titles must be a list.");
    return wiki.addRelated(notePath(path, true), titles.map(String));
  });

  // ---- chores: Done, and the chore that runs UpstreamManager's daily check ----
  app.post("/api/chores/:id/done", { preHandler: guard }, async (req: any) => {
    const c: any = records.get("chores", req.params.id); if (!c) throw new HttpError(404, "No such chore.");
    let result: unknown = null;
    if (c.action === "upstream-daily") result = await upstream.runDaily(); // fails before the chore is marked when UpstreamManager is down
    return { chore: records.patch("chores", c.id, { lastDone: today() }), result };
  });

  // ---- daily digest of Orb's log in the wiki's log (Settings → Logs) ----
  app.post("/api/wiki/digest", { preHandler: guard }, async (req: any) => ({ written: await writeDigest(String(req.body?.date || ""), true) }));
  async function writeDigest(date = "", force = false) {
    const s: any = store.get("settings", "app") || {};
    if (!s.wikiDigest && !force) return "";
    const day = date || localDay(Date.now() - 864e5); // yesterday
    if (!isDay(day)) throw new HttpError(400, "date must be YYYY-MM-DD.");
    const jobs: any = store.get("settings", "jobs") || {};
    if (!force && jobs.digestFor >= day) return "";
    const counts = new Map<string, number>();
    for (const l of records.list("logs") as any[]) if (l.date === day) counts.set(l.project, (counts.get(l.project) || 0) + 1);
    if (counts.size) {
      const title = (name: string) => { const p: any = records.list("projects").find((x: any) => x.name === name); return p?.wikiNote ? `[[${p.wikiNote.split("/").pop()!.replace(/\.md$/, "")}]]` : name; };
      const parts = [...counts].sort((a, b) => b[1] - a[1]).map(([n, k]) => `${k} on ${title(n)}`);
      const line = `Orb, ${day}: ${[...counts.values()].reduce((a, b) => a + b, 0)} log entries (${parts.join(", ")})`;
      wikiWrite(`Daily digest for ${day}`, [{ type: "log", line }], `digest:${day}`);
    }
    const { id: _i, version: _v, ...rest } = jobs;
    // A manual digest for another day doesn't move the automatic job's marker back.
    if (!jobs.digestFor || day > jobs.digestFor) store.set("settings", "jobs", { ...rest, digestFor: day });
    return day;
  }

  mountMcp(app, tools, guard, VERSION);

  // ---- the web app ----
  const webDir = o.webDir ?? process.env.ORB_WEB;
  if (webDir && existsSync(webDir)) {
    await app.register(fstatic, { root: webDir, prefix: "/" });
    app.setNotFoundHandler((req, reply) => req.url.startsWith("/api/") || req.url.startsWith("/mcp") ? reply.code(404).send({ error: "Not found." }) : reply.sendFile("index.html"));
  }

  return { app, records, store, auth, upstream, cfg, sync, outbox, writeDigest, daily, market, journal };
}
