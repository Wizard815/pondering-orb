import type { FastifyInstance } from "fastify";
import type { Records } from "./records.js";
import { HttpError } from "./records.js";
import type { OrbConfig } from "./config.js";
import { secret } from "./config.js";
import type { CalDav } from "./integrations/caldav.js";
import { parseEvents, type CalEvent } from "./integrations/ical.js";
import { weather, news, quotes, type NewsItem } from "./integrations/daily.js";
import { chat } from "./integrations/llm.js";
import { companion, goblinSummary, omiDays, isOmiEvent } from "./integrations/companions.js";
import { today, localDay, isDay, timeZone } from "./dates.js";

/** Settings → Daily page. */
export type DailySettings = { location: string; units: "F" | "C"; feeds: string[]; watchlist: string[]; briefOn: boolean; briefHour: number };
export const DAILY_DEFAULTS: DailySettings = {
  location: "", units: "F", watchlist: ["SPY", "QQQ", "DIA"], briefOn: true, briefHour: 7,
  feeds: ["https://feeds.npr.org/1001/rss.xml", "https://feeds.bbci.co.uk/news/world/rss.xml", "https://www.cnbc.com/id/100003114/device/rss/rss.html"],
};
export const dailySettings = (records: Records): DailySettings => {
  const s: any = (records.get("settings", "app") as any)?.daily || {};
  const list = (v: unknown, d: string[]) => (Array.isArray(v) ? v.map(String).map(x => x.trim()).filter(Boolean) : d);
  return { ...DAILY_DEFAULTS, ...s, units: s.units === "C" ? "C" : "F", feeds: list(s.feeds, DAILY_DEFAULTS.feeds), watchlist: list(s.watchlist, DAILY_DEFAULTS.watchlist),
    briefOn: s.briefOn !== false, briefHour: Math.max(0, Math.min(23, Number.isFinite(+s.briefHour) ? Math.round(+s.briefHour) : 7)) };
};

/** Start of a local day (in TZ) as a Date. */
const dayStart = (iso: string) => new Date(`${iso}T00:00:00`);
const addDays = (iso: string, n: number) => localDay(dayStart(iso).getTime() + n * 864e5 + 3 * 3600e3); // +3h keeps DST changes on the right day

export function dailyApi(app: FastifyInstance, deps: { records: Records; dav: CalDav; cfg: () => OrbConfig; guard: any; who: (req: any) => string }) {
  const { records, dav, cfg, guard } = deps;

  /** CalDAV events (every calendar) plus Orb's own events, from a day for n days. */
  async function events(from: string, days: number): Promise<(CalEvent & { day: string })[]> {
    const out: (CalEvent & { day: string })[] = [];
    if (dav.configured) {
      const lists = await dav.eventLists();
      const a = dayStart(from), b = dayStart(addDays(from, days));
      // Omi's day reviews and conversation events are logs of what happened, not plans: the Omi panel shows them.
      for (const l of lists) for (const ics of await dav.events(l, a, b).catch(() => [] as string[])) for (const e of parseEvents(ics)) if (!isOmiEvent(e.uid)) out.push({ ...e, calendar: l.name, day: e.allDay ? e.start : localDay(Date.parse(e.start.endsWith("Z") ? e.start : e.start)) });
    }
    const last = addDays(from, days - 1);
    for (const e of records.list("events") as any[]) if (e.date >= from && e.date <= last) out.push({ uid: e.id, title: e.title, start: e.time ? `${e.date}T${e.time}:00` : e.date, end: "", allDay: !e.time, location: "", calendar: "Orb", day: e.date });
    // An all-day event that spans several days shows on each of them.
    const spread = out.flatMap(e => {
      if (!e.allDay || !e.end || e.end <= addDays(e.start, 1)) return [e];
      const days: typeof out = []; for (let d = e.start; d < e.end && days.length < 31; d = addDays(d, 1)) if (d >= from && d <= last) days.push({ ...e, day: d });
      return days;
    });
    return spread.filter(e => e.day >= from && e.day <= last).sort((x, y) => x.day.localeCompare(y.day) || Number(y.allDay) - Number(x.allDay) || x.start.localeCompare(y.start));
  }

  const PRIO: Record<number, string> = { 1: "Do now", 2: "Urgent", 3: "High", 4: "High", 5: "Medium", 6: "Low", 7: "Low", 8: "Low", 9: "Low" };
  /** Everything the brief is written from. Any one source failing leaves a note, not a failed brief. */
  async function gather(day = today()) {
    const s = dailySettings(records), notes: string[] = [];
    const safe = async <T>(what: string, f: () => Promise<T>): Promise<T | null> => { try { return await f(); } catch (e: any) { notes.push(`${what}: ${e.message}`); return null; } };
    const [wx, headlines, prices, cal] = await Promise.all([
      s.location ? safe("Weather", () => weather(s.location, s.units)) : Promise.resolve(null),
      safe("News", () => news(s.feeds, 15)),
      s.watchlist.length ? safe("Stocks", () => quotes(s.watchlist)) : Promise.resolve([]),
      safe("Calendar", () => events(day, 7)),
    ]);
    const tasks = (records.list("tasks") as any[]).filter(t => !t.done)
      .sort((a, b) => (a.priority || 10) - (b.priority || 10) || String(a.due || "9").localeCompare(String(b.due || "9"))).slice(0, 15)
      .map(t => ({ title: t.title, list: t.list, due: t.due || "", priority: PRIO[t.priority] || "", overdue: !!t.due && t.due < day, dueToday: t.due === day, fromOmi: t.source === "omi" }));
    const chores = (records.list("chores") as any[]).map(c => ({ name: c.name, due: c.lastDone ? addDays(c.lastDone, Number(c.everyDays) || 7) : day })).filter(c => c.due <= addDays(day, 2)).sort((a, b) => a.due.localeCompare(b.due));
    // Your own apps, read only: Goblin-Bank's shared summary and Omi's recap of yesterday.
    const yaml = String((records.get("settings", "apps") as any)?.yaml || ""), gb = companion(yaml, "goblinbank"), om = companion(yaml, "omi");
    const money = gb ? await safe("Goblin-Bank", () => goblinSummary(gb)) : null;
    const omi = om ? await safe("Omi", async () => (await omiDays(om, 1, addDays(day, -1)))[0] || null) : null;
    const omiTasks = tasks.filter(t => t.fromOmi).length;
    return { day, timeZone: timeZone(), weather: wx, news: headlines || [], stocks: prices || [], events: cal || [], tasks, chores, notes,
      money: money && { netWorth: money.netWorth, people: money.people.map(p => ({ name: p.name, netWorth: p.netWorth, subscriptionsMonthly: p.subscriptionsMonthly })),
        billsThisWeek: money.bills.filter(b => b.date <= addDays(day, 6)).map(b => ({ day: b.date, name: b.name, amount: b.amount, person: b.person, paidBy: b.paidBy })),
        maturitiesThisWeek: money.maturities.filter(m => m.date <= addDays(day, 6)).map(m => ({ day: m.date, title: m.title, detail: m.detail, person: m.person })),
        alerts: money.alerts.filter(a => a.severity !== "info").map(a => ({ severity: a.severity, title: a.title, person: a.person })) },
      omiYesterday: omi && { headline: omi.headline, overview: omi.overview.slice(0, 800), decisions: omi.decisions, questions: omi.questions }, omiOpenTasks: omiTasks };
  }

  /** The morning brief, written by Golem's model from gather(). Stored per day in "daily". */
  async function writeBrief(day = today(), who = "orb") {
    const g = cfg().golem, data = await gather(day);
    const compact = {
      ...data,
      news: data.news.slice(0, 12).map((n: NewsItem) => ({ title: n.title, source: n.source })),
      stocks: data.stocks.map((q: any) => q.error ? { symbol: q.symbol, error: q.error } : { symbol: q.symbol, price: +q.price.toFixed(2), changePct: +q.changePct.toFixed(2) }),
      events: data.events.map(e => ({ day: e.day, time: e.allDay ? "all day" : e.start.slice(11, 16) || e.start, title: e.title, calendar: e.calendar })),
    };
    let text = "";
    try {
      const r = await chat({ baseUrl: g.baseUrl, model: g.model, key: secret(g.keyEnv), who, tools: [], maxRounds: 1, messages: [
        { role: "system", content: "You are Golem, the stone servant of the Pondering Orb, writing the user's morning brief. Plain, warm and short, with a light touch of wizard flavour. Markdown. Sections in this order: a one-line greeting with the weather; **Today** (events with times, tasks due or overdue, chores due); **This week** (the notable events); **Tasks to pick up** (top 3 by priority; tasks marked fromOmi came from Omi); **Money** (only if money is present: bills due this week with amounts, and any critical or warning alerts); **Yesterday, per Omi** (two lines from omiYesterday, only if present); **News** (5 bullets, one line each, most important first); **Markets** (one line on the watchlist, and net worth from money only if present). Use only the data given; never invent events, tasks or prices. If a source failed, say so in one short line." },
        { role: "user", content: `Today is ${day} (${data.timeZone}). Data:\n${JSON.stringify(compact).slice(0, 24000)}` }] });
      text = r.text;
    } catch (e: any) { text = `_The Golem couldn't write today's brief: ${e.message}_`; }
    const id = day, doc = { date: day, brief: text, generatedAt: Date.now(), by: who, notes: data.notes };
    return records.get("daily", id) ? records.put("daily", id, doc) : records.create("daily", doc, id);
  }

  /** Bills from Goblin-Bank's shared bill lists, for Today and This week. */
  app.get("/api/daily/bills", { preHandler: guard }, async (req: any) => {
    const gb = companion(String((records.get("settings", "apps") as any)?.yaml || ""), "goblinbank"); if (!gb) return [];
    const from = today(), to = addDays(from, Math.max(1, Math.min(31, Number(req.query.days) || 7)) - 1);
    return (await goblinSummary(gb)).bills.filter(b => b.date >= from && b.date <= to);
  });
  /** CDs and bonds about to mature, from Goblin-Bank's shared alert list, for Today and This week. */
  app.get("/api/daily/maturities", { preHandler: guard }, async (req: any) => {
    const gb = companion(String((records.get("settings", "apps") as any)?.yaml || ""), "goblinbank"); if (!gb) return [];
    const from = today(), to = addDays(from, Math.max(1, Math.min(60, Number(req.query.days) || 7)) - 1);
    return (await goblinSummary(gb)).maturities.filter(m => m.date >= from && m.date <= to);
  });
  app.get("/api/daily/weather", { preHandler: guard }, async () => { const s = dailySettings(records); return weather(s.location, s.units); });
  app.get("/api/daily/news", { preHandler: guard }, async () => news(dailySettings(records).feeds, 25));
  app.get("/api/daily/quotes", { preHandler: guard }, async () => quotes(dailySettings(records).watchlist));
  app.get("/api/daily/events", { preHandler: guard }, async (req: any) => {
    const from = req.query.from ? String(req.query.from) : today(); if (!isDay(from)) throw new HttpError(400, "from must be YYYY-MM-DD.");
    return events(from, Math.max(1, Math.min(31, Number(req.query.days) || 7)));
  });
  app.post("/api/daily/brief", { preHandler: guard }, async (req: any) => {
    const day = req.body?.date ? String(req.body.date) : today(); if (!isDay(day)) throw new HttpError(400, "date must be YYYY-MM-DD.");
    return writeBrief(day, deps.who(req));
  });

  let running = false;
  /** Called every few minutes: writes today's brief once the morning hour has passed. */
  async function morningTick() {
    const s = dailySettings(records), day = today();
    if (!s.briefOn || running || records.get("daily", day) || new Date().getHours() < s.briefHour) return;
    running = true; try { await writeBrief(day); } finally { running = false; }
  }
  return { gather, writeBrief, morningTick, events };
}
