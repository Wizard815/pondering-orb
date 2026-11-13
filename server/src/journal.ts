import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Records } from "./records.js";
import { HttpError } from "./records.js";
import type { OrbConfig } from "./config.js";
import type { Upstream } from "./integrations/upstream.js";
import type { Hermes } from "./integrations/hermes.js";
import type { Outbox } from "./outbox.js";
import { uptime } from "./integrations/uptime.js";
import { companion, omiDays, omiConversations } from "./integrations/companions.js";
import { ffDay } from "./integrations/firefly.js";
import { cpSummary } from "./integrations/coinpile.js";
import { today, localDay, localClock, isDay } from "./dates.js";

/** The Journal: one record per day ("journal", id = YYYY-MM-DD) holding what
 *  you wrote (text) and your drawing pages, plus the day's log that Orb puts
 *  together from everything it can see. Ink strokes live in "ink" (one record
 *  per page) so a busy page doesn't make the day's record heavy. Images and
 *  PDF pages you bring in are files in <data>/journal/.
 *
 *  The day's log is worked out live for today; after the day ends it is
 *  saved into the record (`auto`), so it still says what happened even when
 *  the apps have moved on. */

export type AutoLog = {
  day: string; at: number; final: boolean;
  money: { source: "firefly" | "coinpile"; spent: number; income: number; currency: string; items: { description: string; amount: number; category: string; account: string }[] } | null;
  tasksDone: { title: string; list: string; by: string }[];
  choresDone: { name: string }[];
  logs: { project: string; text: string; by: string; time: string }[];
  commits: { repo: string; subject: string; sha: string; time: string }[];
  requests: { repo: string; type: string; status: string; what: "raised" | "decided"; comment: string }[];
  agents: { title: string; agent: string; status: string; task: string; project: string; time: string; last: string }[];
  omi: { headline: string; overview: string; decisions: string[]; questions: string[]; highlights: { topic: string; summary: string }[] } | null;
  omiConversations: { title: string; overview: string; time: string }[];
  omiTasks: { title: string; done: boolean }[];
  events: { time: string; title: string; calendar: string }[];
  picks: { symbol: string; decision: string; amount: number; action: string }[];
  alerts: { source: string; severity: "critical" | "warning" | "info"; title: string; detail: string }[];
  notes: string[];
};

const FILE = /^[a-f0-9]{32}\.(png|jpg|webp|gif)$/;
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
/** The file's real type from its first bytes; the Content-Type header alone isn't trusted. */
export function sniff(b: Buffer): keyof typeof TYPES | null {
  if (b.length > 8 && b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return "png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (b.length > 6 && /^GIF8[79]a$/.test(b.toString("latin1", 0, 6))) return "gif";
  return null;
}

const dayOfIso = (s: string) => { const t = Date.parse(s); return Number.isNaN(t) ? "" : localDay(t); };
const clockOf = (ms: number) => localClock(new Date(ms).toISOString());

export function journalApi(app: FastifyInstance, deps: {
  records: Records; cfg: () => OrbConfig; guard: any; who: (req: any) => string; filesDir: string;
  upstream: Upstream; hermes: Hermes; outbox: Outbox; appsYaml: () => string;
  events: (from: string, days: number) => Promise<{ title: string; start: string; allDay: boolean; calendar?: string; day: string }[]>;
}) {
  const { records, cfg, guard, filesDir } = deps;

  async function build(day: string): Promise<AutoLog> {
    const notes: string[] = [], isToday = day === today();
    const safe = async <T>(what: string, f: () => Promise<T>, dflt: T): Promise<T> => { try { return await f(); } catch (e: any) { notes.push(`${what}: ${e.message}`); return dflt; } };
    const yaml = deps.appsYaml(), ff = companion(yaml, "firefly"), cp = companion(yaml, "coinpile"), om = companion(yaml, "omi");
    const c = cfg();

    // Money: Coinpile's daily totals when it shares them, else Firefly III's transactions for the day.
    const money = await safe("Money", async () => {
      const cps = cp ? await cpSummary(cp).catch(() => null) : null, d = cps?.daily?.find(x => x.date === day);
      if (d && !ff) return { source: "coinpile" as const, spent: d.spent, income: d.income, currency: "", items: [] };
      if (!ff) return null;
      const f = await ffDay(ff, day);
      return { source: "firefly" as const, spent: d?.spent ?? f.spent, income: d?.income ?? f.income, currency: f.currency,
        items: f.items.filter(t => t.type === "withdrawal" || t.type === "deposit").map(t => ({ description: t.description, amount: t.amount, category: t.category, account: t.account })) };
    }, null);

    const tasks = records.list("tasks") as any[];
    const tasksDone = tasks.filter(t => t.done && t.doneAt === day).map(t => ({ title: t.title, list: t.list || "", by: t.doneBy || "" }));
    const choresDone = (records.list("chores") as any[]).filter(x => x.lastDone === day).map(x => ({ name: x.name }));
    const logs = (records.list("logs") as any[]).filter(l => l.date === day).sort((a, b) => (a.created || 0) - (b.created || 0))
      .map(l => ({ project: l.project || "", text: l.text, by: l.by || "", time: l.created ? clockOf(l.created) : "" }));

    // UpstreamManager: commits made that day on every repo it watches, and requests raised or decided.
    const [commits, requests] = !c.upstream.baseUrl ? [[], []] : await Promise.all([
      safe("UpstreamManager commits", async () => {
        const repos: any[] = (await deps.upstream.repos()) || [], out: AutoLog["commits"] = [];
        for (const r of repos.slice(0, 40)) {
          const items: any[] = (await deps.upstream.commits(r.id, 50).catch(() => null))?.items || [];
          for (const x of items) if (dayOfIso(x.date) === day) out.push({ repo: r.name || r.id, subject: String(x.subject || ""), sha: String(x.sha || "").slice(0, 10), time: localClock(String(x.date)) });
        }
        return out.sort((a, b) => a.time.localeCompare(b.time));
      }, [] as AutoLog["commits"]),
      safe("UpstreamManager requests", async () => ((await deps.upstream.requests()) || []).flatMap((r: any): AutoLog["requests"] => {
        const base = { repo: r.repo_name || r.repo_id || "", type: r.type || "", status: r.status || "", comment: r.comment || "" };
        return [...(dayOfIso(r.created_at || "") === day ? [{ ...base, what: "raised" as const }] : []), ...(r.decided_at && dayOfIso(r.decided_at) === day ? [{ ...base, what: "decided" as const }] : [])];
      }), [] as AutoLog["requests"]),
    ]);

    // Hermes Studio: chats working on Orb's tasks and projects that moved that day, with the latest word on how it went.
    const agents = !c.hermes.baseUrl ? [] : await safe("Hermes Studio", async () => {
      const work = (await deps.hermes.agents()).agents.filter((a: any) => a.updatedAt && localDay(a.updatedAt) === day);
      return Promise.all(work.slice(0, 12).map(async (a: any) => {
        const s = await deps.hermes.session(a.chatId, 6).catch(() => null);
        const last = [...(s?.messages || [])].reverse().find(m => /assistant|agent/i.test(m.role))?.text || "";
        return { title: a.title, agent: a.agent, status: a.status, task: a.task?.title || "", project: a.project || "", time: clockOf(a.updatedAt), last: last.slice(0, 600) };
      }));
    }, [] as AutoLog["agents"]);

    // Omi: its recap of the day, that day's conversations, and its action items (they arrive through CalDAV).
    const omi = !om ? null : await safe("Omi", async () => {
      const d = (await omiDays(om, 1, day))[0]; if (!d || d.date !== day) return null;
      return { headline: d.headline, overview: d.overview, decisions: d.decisions, questions: d.questions, highlights: d.highlights.map((h: any) => ({ topic: h.topic, summary: h.summary })) };
    }, null);
    const omiConvs = !om ? [] : await safe("Omi conversations", async () => (await omiConversations(om, 25)).filter(x => dayOfIso(String(x.at)) === day)
      .map(x => ({ title: x.title, overview: x.overview, time: localClock(String(x.at)) })), [] as AutoLog["omiConversations"]);
    const omiTasks = tasks.filter(t => t.source === "omi" && (!t.done || t.doneAt === day)).map(t => ({ title: t.title, done: !!t.done }));

    const events = await safe("Calendar", async () => (await deps.events(day, 1)).filter(e => e.day === day)
      .map(e => ({ time: e.allDay ? "all day" : localClock(e.start), title: e.title, calendar: e.calendar || "" })), [] as AutoLog["events"]);
    const picks = (records.list("picks") as any[]).filter(p => p.decision !== "pending" && p.decidedAt && localDay(p.decidedAt) === day)
      .map(p => ({ symbol: p.symbol, decision: p.decision, amount: p.amount || 0, action: p.verdict?.answers?.action?.choice || "" }));

    // Alerts are what's wrong right now, so only today's log gathers them live.
    const alerts: AutoLog["alerts"] = [];
    if (isToday) {
      if (cp) for (const a of (await safe("Coinpile alerts", async () => (await cpSummary(cp)).alertList || [], [] as any[]))) if (a.severity !== "info") alerts.push({ source: "Coinpile", severity: a.severity, title: a.title, detail: a.detail });
      if (c.uptime.baseUrl) for (const m of (await safe("Uptime", async () => (await uptime(c.uptime.baseUrl, c.uptime.statusPage)).monitors, [] as any[]))) if (m.status === "down") alerts.push({ source: "Uptime", severity: "critical", title: `${m.name} is down`, detail: m.group });
      for (const o of deps.outbox.list()) alerts.push({ source: "Sync", severity: "warning", title: `Waiting to sync: ${o.label}`, detail: o.lastError || "" });
      const r: any = records.get("research", day); if (r?.status === "failed") alerts.push({ source: "Picks", severity: "warning", title: "Stock research failed", detail: r.error || "" });
    }

    return { day, at: Date.now(), final: false, money, tasksDone, choresDone, logs, commits, requests, agents, omi, omiConversations: omiConvs, omiTasks, events, picks, alerts, notes };
  }

  /** Save a finished day's log into its journal record (once). */
  async function snapshot(day: string, force = false) {
    const cur: any = records.get("journal", day);
    if (cur?.auto?.final && !force) return cur.auto as AutoLog;
    const auto = { ...(await build(day)), final: true };
    const { id: _i, version: _v, ...rest } = cur || { date: day, text: "", pages: [] };
    records.put("journal", day, { ...rest, auto }, "orb");
    return auto;
  }

  /** The day's log: saved for a finished day, worked out now for today (or a past day never saved). */
  async function autoFor(day: string, refresh = false): Promise<AutoLog> {
    const cur: any = records.get("journal", day);
    if (day < today()) return refresh || !cur?.auto?.final ? snapshot(day, refresh) : cur.auto;
    return build(day);
  }

  const dayParam = (v: unknown) => { const d = String(v || ""); if (!isDay(d)) throw new HttpError(400, "The day is YYYY-MM-DD."); if (d > today()) throw new HttpError(400, "That day hasn't happened yet."); return d; };
  const you = (req: any) => { if (deps.who(req) !== "you") throw new HttpError(403, "Only a signed-in person can change the journal."); };

  app.get("/api/journal/:day/auto", { preHandler: guard }, async (req: any) => autoFor(dayParam(req.params.day), req.query.refresh === "1"));

  // Images (and PDF pages, which the browser turns into images) for drawing pages.
  app.addContentTypeParser(/^image\/(png|jpeg|webp|gif)$/, { parseAs: "buffer", bodyLimit: 25 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.post("/api/journal/files", { preHandler: guard, bodyLimit: 25 * 1024 * 1024 }, async (req: any) => {
    you(req);
    const b = req.body; if (!Buffer.isBuffer(b) || !b.length) throw new HttpError(400, "Send the image itself (PNG, JPEG, WebP or GIF) as the request body.");
    const ext = sniff(b); if (!ext) throw new HttpError(415, "That isn't a PNG, JPEG, WebP or GIF image.");
    await mkdir(filesDir, { recursive: true });
    const id = `${randomUUID().replace(/-/g, "")}.${ext}`; await writeFile(join(filesDir, id), b);
    return { id, type: TYPES[ext], bytes: b.length };
  });
  app.get("/api/journal/files/:id", { preHandler: guard }, async (req: any, reply) => {
    const id = String(req.params.id); if (!FILE.test(id)) throw new HttpError(404, "No such file.");
    const data = await readFile(join(filesDir, id)).catch(() => { throw new HttpError(404, "No such file."); });
    reply.header("Content-Type", TYPES[id.split(".")[1]]).header("X-Content-Type-Options", "nosniff").header("Content-Security-Policy", "default-src 'none'").header("Cache-Control", "private, max-age=31536000, immutable");
    return reply.send(data);
  });
  app.delete("/api/journal/files/:id", { preHandler: guard }, async (req: any, reply) => {
    you(req); const id = String(req.params.id); if (!FILE.test(id)) throw new HttpError(404, "No such file.");
    await unlink(join(filesDir, id)).catch(() => {}); reply.code(204).send();
  });

  /** After midnight, yesterday's log is saved for good. */
  async function tick() { const y = localDay(Date.now() - 864e5); const cur: any = records.get("journal", y); if (!cur?.auto?.final) await snapshot(y); }
  return { build, autoFor, snapshot, tick };
}
