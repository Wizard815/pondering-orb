// Synthetic stand-ins for every app Pondering Orb talks to, for the demo
// stack only. One plain Node server, no dependencies, everything in memory.
// Dates are relative to today (in TZ), so the demo always looks current.
// Every name, number and headline here is made up.
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { join, normalize } from "node:path";

const PORT = Number(process.env.PORT || 8300);
const VAULT = process.env.VAULT || "/vault";

// ---------- dates ----------
const fmt = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
const dayOf = (ms) => fmt.format(new Date(ms));
const day = (n = 0) => dayOf(Date.now() + n * 864e5);
const compact = (iso) => iso.replace(/-/g, "");
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const at = (iso, hhmm) => { const [h, m] = hhmm.split(":").map(Number); const d = new Date(`${iso}T00:00:00`); d.setHours(h, m, 0, 0); return d; };
const weekday = (iso) => new Date(`${iso}T12:00:00`).getDay();

// ---------- deterministic randomness ----------
const hash = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
function rng(seed) { let x = hash(seed) || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }

// ---------- HTTP helpers ----------
const json = (res, body, code = 200, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
const text = (res, body, type = "text/plain", code = 200, headers = {}) => { res.writeHead(code, { "content-type": type, ...headers }); res.end(body); };
const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// =====================================================================
// Weather, prices, news
// =====================================================================
const wx = () => {
  const r = rng("wx" + day()), base = 52;
  const days = Array.from({ length: 7 }, (_, k) => day(k));
  const codes = days.map(() => [0, 1, 2, 3, 61, 80, 2][Math.floor(r() * 7)]);
  const hi = days.map((_, k) => Math.round(base + 6 * Math.sin(k / 2) + r() * 4));
  return { current: { temperature_2m: hi[0] - 6, apparent_temperature: hi[0] - 9, weather_code: codes[0], wind_speed_10m: 7 + Math.round(r() * 8) },
    daily: { time: days, weather_code: codes, temperature_2m_max: hi, temperature_2m_min: hi.map(h => h - 11 - Math.round(r() * 3)), precipitation_probability_max: codes.map(c => (c >= 61 ? 60 + Math.round(r() * 30) : Math.round(r() * 15))) } };
};

// Fictional companies. The ETFs keep their tickers but every price is made up.
const NAMES = { SPY: "S&P 500 ETF (demo prices)", QQQ: "Nasdaq-100 ETF (demo prices)", DIA: "Dow ETF (demo prices)", GLMR: "Glimmerworks Inc.", RUNE: "Runestone Robotics", OWLX: "Owlpost Logistics",
  EMBR: "Ember Foods", TWRH: "Tower Holdings", MOSS: "Mossgate Energy", QUIL: "Quill Software", BRZN: "Brazen Bell Health" };
/** About two years of weekday closes ending today: a seeded random walk. */
function series(sym) {
  const r = rng("px" + sym), out = [];
  let p = 40 + (hash(sym) % 260), drift = 0.0004 + (hash(sym + "d") % 7) / 10000;
  for (let k = 740; k >= 0; k--) {
    const iso = day(-k), wd = weekday(iso); if (wd === 0 || wd === 6) continue;
    p *= 1 + drift + (r() - 0.5) * 0.034; out.push({ iso, close: +p.toFixed(2) });
  }
  return out;
}
function chart(sym) {
  const s = series(sym), ts = s.map(b => Math.floor(Date.parse(`${b.iso}T20:00:00Z`) / 1000)), closes = s.map(b => b.close);
  return { chart: { result: [{ meta: { shortName: NAMES[sym] || `${sym} (demo)`, regularMarketPrice: closes.at(-1), chartPreviousClose: closes.at(-2), currency: "USD", regularMarketTime: Math.floor(Date.now() / 1000) - 600 },
    timestamp: ts, indicators: { quote: [{ close: closes }] } }] } };
}

const HEADLINES = [
  ["Glimmerworks shares jump after it raises full-year guidance", "GLMR"], ["Runestone Robotics wins warehouse automation contract", "RUNE"], ["Owlpost Logistics misses on margins as fuel costs bite", "OWLX"],
  ["Ember Foods to buy regional bakery chain", "EMBR"], ["Analyst upgrades Quill Software to buy on cloud growth", "QUIL"], ["Mossgate Energy delays its new turbine plant", "MOSS"],
  ["Central bank holds rates steady and signals patience", ""], ["Retail sales beat estimates for a second month", ""], ["Chip stocks lead a broad rally", ""],
  ["Town of Elderglen opens its new library wing", ""], ["Storm watch issued for the coast this weekend", ""], ["Rail strike talks resume", ""],
];
function rss(title, q) {
  const r = rng(title + q + day()), pick = HEADLINES.filter(([h, s]) => !q || h.toLowerCase().includes(q.toLowerCase().split(" ")[0]) || s === q.toUpperCase().split(" ")[0]);
  const items = (pick.length ? pick : HEADLINES).slice(0, 10).map(([h], k) => `<item><title>${xmlEsc(h)}</title><link>https://example.com/demo/${k}-${encodeURIComponent(h.slice(0, 20))}</link><source>${xmlEsc(title)}</source><pubDate>${new Date(Date.now() - (k + 1) * (40 + r() * 80) * 60000).toUTCString()}</pubDate><description>${xmlEsc(h)}. (Synthetic demo headline.)</description></item>`);
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>${xmlEsc(title)}</title>${items.join("")}</channel></rss>`;
}

// =====================================================================
// The model (Golem, the brief, research) and the decision model
// =====================================================================
function briefFrom(user) {
  let d = {}; try { d = JSON.parse(user.slice(user.indexOf("{"))); } catch { /* text only */ }
  const w = d.weather, L = [];
  L.push(`Good morning, wizard. ${w ? `**${w.now.temp}°${w.units} and ${String(w.now.text || "fair").toLowerCase()}** over ${w.place}; a high of ${w.days?.[0]?.high}°.` : "The skies are unread today."}`);
  const today = (d.events || []).filter(e => e.day === d.day), due = (d.tasks || []).filter(t => t.dueToday || t.overdue);
  L.push("", "**Today**");
  for (const e of today.slice(0, 6)) L.push(`- ${e.time} ${e.title}${e.calendar ? ` (${e.calendar})` : ""}`);
  for (const t of due.slice(0, 4)) L.push(`- ${t.overdue ? "Overdue" : "Due"}: ${t.title}${t.priority ? ` (${t.priority})` : ""}`);
  for (const c of (d.chores || []).slice(0, 3)) L.push(`- Chore: ${c.name}`);
  const later = (d.events || []).filter(e => e.day > d.day);
  if (later.length) { L.push("", "**This week**"); for (const e of later.slice(0, 5)) L.push(`- ${new Date(e.day + "T12:00:00").toLocaleDateString("en-US", { weekday: "short" })}: ${e.title}`); }
  const open = (d.tasks || []).filter(t => !t.dueToday && !t.overdue).slice(0, 3);
  if (open.length) { L.push("", "**Tasks to pick up**"); open.forEach((t, k) => L.push(`${k + 1}. ${t.title} (${t.list})`)); }
  const f = d.finances, c = d.coinpile;
  if (f || c) {
    L.push("", "**Money**");
    if (f) L.push(`- Spent $${Math.round(f.spentThisMonth)} this month, $${Math.round(f.leftToSpend)} left to spend.`);
    for (const b of f?.billsThisWeek || c?.billsThisWeek || []) L.push(`- ${b.name}, $${b.amount}, on ${b.day}`);
    for (const b of f?.budgetsNearLimit || []) L.push(`- ${b.name} budget is at ${b.pctUsed}%`);
    if (c?.spendingForecast) L.push(`- On track to spend $${c.spendingForecast.projected}, ${c.spendingForecast.pctOfIncome}% of income.`);
    for (const a of (c?.alerts || []).slice(0, 3)) L.push(`- ${a.severity === "critical" ? "⚠ " : ""}${a.title}`);
  }
  if ((d.stocks || []).length) L.push("", `**Markets** ${(d.stocks || []).filter(s => !s.error).map(s => `${s.symbol} ${s.changePct >= 0 ? "+" : ""}${s.changePct}%`).join(", ")}.`);
  if ((d.news || []).length) { L.push("", "**News**"); for (const n of d.news.slice(0, 3)) L.push(`- ${n.title}`); }
  if (d.omiYesterday) L.push("", `**Yesterday, per Omi** ${d.omiYesterday.headline}.`);
  return L.join("\n");
}
const RESEARCH_PICKS = [
  { symbol: "GLMR", thesis: "Raised full-year guidance on stronger orders; the stock has room if margins hold.", catalyst: "Guidance raised on the quarterly call", sources: ["https://example.com/demo/glmr"] },
  { symbol: "RUNE", thesis: "A large warehouse contract adds a year of visible revenue.", catalyst: "New automation contract", sources: ["https://example.com/demo/rune"] },
  { symbol: "QUIL", thesis: "Upgrade on cloud growth, but the shares already moved.", catalyst: "Analyst upgrade to buy", sources: ["https://example.com/demo/quil"] },
];
function verdictFor(sym) {
  const r = rng("v" + sym + day()), up = 0.35 + r() * 0.35, buy = up > 0.55;
  const p3 = (a, b) => { const c = Math.max(0.05, 1 - a - b); return { up: +a.toFixed(3), flat: +c.toFixed(3), down: +b.toFixed(3) }; };
  const d5 = p3(up * 0.8, (1 - up) * 0.5), d20 = p3(up, (1 - up) * 0.55);
  const pick = (p) => Object.entries(p).sort((x, y) => y[1] - x[1])[0][0];
  const act = buy ? "buy" : up > 0.45 ? "hold" : "skip", conf = +(0.4 + r() * 0.3).toFixed(2);
  return { action: { choice: act, confidence: conf, probabilities: { buy: buy ? conf : 0.2, hold: act === "hold" ? conf : 0.3, skip: act === "skip" ? conf : 0.2 } },
    direction_5d: { choice: pick(d5), confidence: Math.max(...Object.values(d5)), probabilities: d5 }, direction_20d: { choice: pick(d20), confidence: Math.max(...Object.values(d20)), probabilities: d20 },
    conviction: { choice: up > 0.6 ? "strong" : up > 0.48 ? "fair" : "weak", confidence: 0.5 } };
}
/** Golem: picks a tool from the question, then answers from what it returned. */
function golemStep(messages, tools) {
  const names = new Set((tools || []).map(t => t.function?.name));
  const lastUser = [...messages].reverse().find(m => m.role === "user")?.content || "";
  const afterUser = messages.slice(messages.map(m => m.role).lastIndexOf("user") + 1);
  const results = afterUser.filter(m => m.role === "tool");
  if (!results.length && names.size) {
    const q = String(lastUser).toLowerCase();
    const want = /task|due|to-?do|overdue/.test(q) ? "orb_list_tasks" : /money|spend|budget|bill|finance/.test(q) ? "finance_summary" : /saving|goal|coinpile|cd\b/.test(q) ? "coinpile_summary" : /omi|yesterday/.test(q) ? "omi_daily_summary"
      : /chore/.test(q) ? "orb_list_chores" : /project/.test(q) ? "orb_list_projects" : /log|did i/.test(q) ? "orb_list_logs" : /family|today|calendar/.test(q) ? "allglance_day" : "orb_list_tasks";
    const tool = names.has(want) ? want : names.has("orb_list_tasks") ? "orb_list_tasks" : null;
    if (tool) return { tool, args: tool === "orb_list_tasks" ? { openOnly: true } : {} };
  }
  let out = "Here's what I found.";
  for (const m of results) {
    let v; try { v = JSON.parse(m.content); } catch { continue; }
    const list = Array.isArray(v) ? v : v?.tasks || v?.projects || v?.logs || v?.chores || v?.blocks || null;
    if (list) {
      const rows = list.slice(0, 6).map(x => `- ${x.title || x.name || x.text}${x.due ? ` (due ${x.due})` : x.status ? ` · ${x.status}` : x.start ? ` at ${x.start}` : ""}`);
      out = rows.length ? `I looked it up. The top ${rows.length}:\n\n${rows.join("\n")}\n\nWant me to start one of them or add a note to the log?` : "Nothing there right now.";
    } else if (v?.summary) {
      const s = v.summary; out = `This month so far: **$${Math.round(-s.spent || s.spent)} spent**, $${Math.round(s.earned)} earned, **$${Math.round(s.leftToSpend)} left to spend**. Net worth is $${Math.round(s.netWorth).toLocaleString()}.${(v.budgets || []).filter(b => b.pct >= 90).map(b => ` ${b.name} is at ${b.pct}% of its budget.`).join("")}`;
    } else if (v?.savings) {
      out = `Savings: $${v.savings.total} in all, $${v.savings.free} free. Goals: ${(v.goals || []).map(g => `${g.name} ${Math.round(g.pct * 100)}%`).join(", ")}.`;
    } else if (v?.headline) out = `Yesterday, per Omi: **${v.headline}**. ${v.overview || ""}`;
    else if (v?.error) out = `I couldn't read that: ${v.error}`;
  }
  return { text: out };
}
function completion(body) {
  const msgs = body.messages || [], sys = String(msgs[0]?.content || ""), user = String(msgs.at(-1)?.content || "");
  if (sys.includes("morning brief")) return { text: briefFrom(user) };
  if (sys.includes("markets research analyst")) return { text: "## Today's market news\n\n- The central bank held rates and signalled patience; yields eased.\n- Retail sales beat estimates again.\n- Chip makers led a broad rally.\n\n_(Synthetic demo report.)_" };
  if (sys.includes("stock research analyst")) return { text: "## Stocks in the news\n\n- **GLMR** raised full-year guidance.\n- **RUNE** won a warehouse automation contract.\n- **QUIL** was upgraded to buy.\n- **OWLX** missed on margins.\n\n_(Synthetic demo report.)_" };
  if (sys.includes("choose up to")) return { text: JSON.stringify({ picks: RESEARCH_PICKS }) };
  if (sys.includes("careful decision model")) { const m = /"symbol":"([A-Z.]+)"/.exec(user); return { text: JSON.stringify(verdictFor(m?.[1] || "X")) }; }
  const step = golemStep(msgs, body.tools);
  return step.tool ? { tool: step.tool, args: step.args } : { text: step.text };
}
async function chatRoute(req, res, body) {
  const r = completion(body), id = "call_" + Math.random().toString(36).slice(2, 10);
  if (!body.stream) {
    const message = r.tool ? { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: r.tool, arguments: JSON.stringify(r.args) } }] } : { role: "assistant", content: r.text };
    return json(res, { id: "demo", object: "chat.completion", choices: [{ index: 0, message, finish_reason: r.tool ? "tool_calls" : "stop" }] });
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (delta) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
  if (r.tool) send({ tool_calls: [{ index: 0, id, type: "function", function: { name: r.tool, arguments: JSON.stringify(r.args) } }] });
  else for (const part of r.text.match(/\S+\s*/g) || []) { send({ content: part }); await new Promise(ok => setTimeout(ok, 18)); }
  res.end("data: [DONE]\n\n");
}

// =====================================================================
// ALLGlance gateway: dayGLANCE, lastGLANCE, lifeGLANCE and CalDAV (/dav)
// =====================================================================
const USERS = [{ id: "u-wiz", name: "Wiz" }, { id: "u-sam", name: "Sam" }, { id: "u-pip", name: "Pip" }];
const FAMILY = { 1: [["07:45", 30, "School run", "u-sam"], ["18:00", 60, "Pip: swim class", "u-pip"]], 2: [["19:00", 90, "Board game night", "u-wiz"]], 3: [["07:45", 30, "School run", "u-wiz"], ["17:30", 45, "Groceries", "u-sam"]],
  4: [["18:30", 90, "Family dinner at Gran's", "u-wiz"]], 5: [["07:45", 30, "School run", "u-sam"], ["19:30", 120, "Movie night", "u-pip"]], 6: [["09:00", 120, "Farmers market", "u-sam"], ["14:00", 60, "Pip: birthday party", "u-pip"]], 0: [["10:00", 90, "Hike at Elder Falls", "u-wiz"]] };
const added = [];
const blocksFor = (iso) => [...(FAMILY[weekday(iso)] || []).map(([t, m, title, o], k) => ({ id: `b-${iso}-${k}`, title, start_time: t, duration_minutes: m, owner_id: o })),
  ...added.filter(a => a.date === iso).map(a => ({ id: a.id, title: a.title, start_time: a.time, duration_minutes: a.minutes, owner_id: a.owner }))];
const dayglanceTasks = () => [{ id: "dg1", title: "Sign Pip's field-trip form", due_date: day(1), completed: false, owner_id: "u-wiz", priority: 4 },
  { id: "dg2", title: "Book the vet for Biscuit", due_date: day(3), completed: false, owner_id: "u-sam", priority: 2 }, { id: "dg3", title: "Return library books", due_date: day(0), completed: false, owner_id: "u-pip", priority: 1 }];
const glanceChores = () => [{ id: "lc1", title: "Change the furnace filter", owner_id: "u-wiz", last_completed: day(-85) }, { id: "lc2", title: "Clean the gutters", owner_id: "u-sam", last_completed: day(-200) }];
const milestones = () => [{ id: "m1", title: "Pip turns 9", date: day(19), owner_id: "u-pip" }, { id: "m2", title: "10 years in the house", date: day(44), owner_id: "u-wiz" }];

// CalDAV: task lists (VTODO) and one calendar (VEVENT). In memory; PUT/DELETE work.
const DAV = "/glance/dav/";
const cols = { homelab: { name: "Homelab", comp: "VTODO" }, errands: { name: "Errands", comp: "VTODO" }, inbox: { name: "Inbox", comp: "VTODO" }, chores: { name: "Chores", comp: "VTODO" }, work: { name: "Work", comp: "VEVENT" } };
const items = new Map(); // href -> { ics, etag }
let etagN = 1;
const todo = (uid, summary, { due, prio = 0, status = "NEEDS-ACTION", rrule, start } = {}) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Demo//Fakes//EN", "BEGIN:VTODO", `UID:${uid}`, `DTSTAMP:${stamp()}`, `SUMMARY:${summary}`,
  `STATUS:${status}`, ...(prio ? [`PRIORITY:${prio}`] : []), ...(start ? [`DTSTART;VALUE=DATE:${compact(start)}`] : []), ...(due ? [`DUE;VALUE=DATE:${compact(due)}`] : []), ...(rrule ? [`RRULE:${rrule}`] : []),
  ...(status === "COMPLETED" ? [`COMPLETED:${stamp(new Date(Date.now() - 864e5))}`] : []), "END:VTODO", "END:VCALENDAR", ""].join("\r\n");
function seedDav() {
  const put = (col, uid, ics) => items.set(`${DAV}${col}/${encodeURIComponent(uid)}.ics`, { ics, etag: `"e${etagN++}"` });
  const T = [
    ["homelab", "Renew the domain for orb.example", { due: day(0), prio: 1 }], ["homelab", "Swap the failing disk in the NAS", { due: day(-1), prio: 3 }], ["homelab", "Rotate the backup keys", { due: day(2), prio: 5 }],
    ["homelab", "Upgrade Uptime Kuma", { due: day(6), prio: 6 }], ["homelab", "Write a runbook for the Plex box", { prio: 7 }], ["homelab", "Set up the second Pi-hole", { status: "COMPLETED" }],
    ["errands", "Pick up the parcel at the post office", { due: day(0), prio: 5 }], ["errands", "Buy a UPS for the rack", { due: day(4), prio: 3 }], ["errands", "Get the winter tyres fitted", { due: day(9) }],
    ["inbox", "Read the Argos release notes", { prio: 6 }], ["inbox", "Reply to the HOA email", { due: day(1), prio: 4 }], ["inbox", "Sketch the Orb phone layout", { status: "IN-PROCESS", prio: 5 }],
  ];
  T.forEach(([c, s, o], k) => put(c, `demo-task-${k}@fakes`, todo(`demo-task-${k}@fakes`, s, o)));
  // Two action items Omi wrote (read only in Orb).
  put("inbox", "omi-task-1@omi-local", todo("omi-task-1@omi-local", "Compare UPS models before Friday", { due: day(2), prio: 5 }));
  put("inbox", "omi-task-2@omi-local", todo("omi-task-2@omi-local", "Send Sam the backup schedule", { prio: 6 }));
  const C = [["Water the plants", 3, -5], ["Take out the recycling", 7, -6], ["Clean the coffee machine", 14, -10], ["Check the smoke alarms", 30, -12], ["Vacuum the stairs", 7, -2]];
  C.forEach(([n, every, last], k) => { const due = day(last + every); put("chores", `demo-chore-${k}@fakes`, todo(`demo-chore-${k}@fakes`, n, { due, start: day(last), rrule: `FREQ=DAILY;INTERVAL=${every}` })); });
}
seedDav();
const WORK = { 1: [["09:30", 30, "Standup"], ["14:00", 60, "Design review: Orb phone layout"]], 2: [["09:30", 30, "Standup"], ["11:00", 45, "1:1 with Rowan"]], 3: [["09:30", 30, "Standup"], ["15:00", 60, "Homelab maintenance window"]],
  4: [["09:30", 30, "Standup"], ["13:00", 30, "Dentist"]], 5: [["09:30", 30, "Standup"], ["16:00", 60, "Demo day"]], 6: [], 0: [] };
function eventsBetween(from, to) {
  const out = [];
  for (let t = from.getTime(); t < to.getTime(); t += 864e5) {
    const iso = dayOf(t);
    for (const [hhmm, mins, title] of WORK[weekday(iso)] || []) {
      const s = at(iso, hhmm), e = new Date(s.getTime() + mins * 60000), uid = `work-${iso}-${hhmm}@fakes`;
      if (e < from || s > to) continue;
      out.push({ href: `${DAV}work/${uid}.ics`, ics: ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${stamp()}`, `DTSTART:${stamp(s)}`, `DTEND:${stamp(e)}`, `SUMMARY:${title}`, "LOCATION:Video call", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n") });
    }
  }
  return out;
}
const ms = (inner) => `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${inner}</d:multistatus>`;
const resp = (href, props) => `<d:response><d:href>${xmlEsc(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const parseT = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11) || 0, +s.slice(11, 13) || 0, +s.slice(13, 15) || 0));
function dav(req, res, path, body) {
  const rel = path.slice(DAV.length).split("/").filter(Boolean);
  if (req.method === "PROPFIND") {
    if (!rel.length) return text(res, ms(resp(DAV, "<d:resourcetype><d:collection/></d:resourcetype><d:displayname>Demo</d:displayname>") + Object.entries(cols).map(([id, c]) => resp(`${DAV}${id}/`,
      `<d:displayname>${c.name}</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="${c.comp}"/></c:supported-calendar-component-set>`)).join("")), "application/xml", 207);
    return text(res, ms(""), "application/xml", 207);
  }
  if (req.method === "REPORT" && rel.length === 1 && cols[rel[0]]) {
    if (cols[rel[0]].comp === "VEVENT") {
      const m = /time-range start="(\d{8}T\d{6}Z)" end="(\d{8}T\d{6}Z)"/.exec(body); const from = m ? parseT(m[1]) : new Date(), to = m ? parseT(m[2]) : new Date(Date.now() + 14 * 864e5);
      return text(res, ms(eventsBetween(from, to).map(e => resp(e.href, `<d:getetag>"w"</d:getetag><c:calendar-data>${xmlEsc(e.ics)}</c:calendar-data>`)).join("")), "application/xml", 207);
    }
    const prefix = `${DAV}${rel[0]}/`;
    return text(res, ms([...items].filter(([h]) => h.startsWith(prefix)).map(([h, it]) => resp(h, `<d:getetag>${xmlEsc(it.etag)}</d:getetag><c:calendar-data>${xmlEsc(it.ics)}</c:calendar-data>`)).join("")), "application/xml", 207);
  }
  if (req.method === "PUT") {
    const cur = items.get(path), ifm = req.headers["if-match"];
    if (ifm && (!cur || cur.etag !== ifm)) return text(res, "", "text/plain", 412);
    if (req.headers["if-none-match"] === "*" && cur) return text(res, "", "text/plain", 412);
    const etag = `"e${etagN++}"`; items.set(path, { ics: body, etag }); return text(res, "", "text/plain", cur ? 204 : 201, { etag });
  }
  if (req.method === "DELETE") { items.delete(path); return text(res, "", "text/plain", 204); }
  if (req.method === "GET" && items.has(path)) return text(res, items.get(path).ics, "text/calendar");
  return text(res, "", "text/plain", 404);
}

// =====================================================================
// Uptime Kuma, UpstreamManager, Hermes Studio
// =====================================================================
const MONITORS = [["Core", ["ALLGlance gateway", "Firefly III", "Coinpile", "Hermes Studio", "Argos"]], ["Media", ["Plex", "SABnzbd", "Jellyseerr"]], ["Network", ["Pi-hole", "Router", "LLMWIKI"]]];
function uptimePage() {
  let id = 0; const publicGroupList = MONITORS.map(([name, ms]) => ({ name, monitorList: ms.map(m => ({ id: ++id, name: m })) }));
  const heartbeatList = {}, uptimeList = {};
  for (const g of publicGroupList) for (const m of g.monitorList) {
    const r = rng("up" + m.name), down = m.name === "LLMWIKI", flaky = m.name === "Jellyseerr";
    heartbeatList[m.id] = Array.from({ length: 60 }, (_, k) => ({ status: down && k > 54 ? 0 : flaky && r() < 0.08 ? 0 : 1, ping: Math.round(8 + r() * 40), time: new Date(Date.now() - (60 - k) * 60000).toISOString() }));
    uptimeList[`${m.id}_24`] = down ? 0.962 : flaky ? 0.987 : 0.999 + r() * 0.001;
  }
  return { publicGroupList, heartbeatList, uptimeList };
}
const REPOS = [
  { id: "argos", name: "argos", focus_branch: "main", behind: 0, ahead: 2, upstreams: [{ name: "upstream" }], components: [], dirty: 0 },
  { id: "hermes-studio", name: "hermes-studio", focus_branch: "main", behind: 7, ahead: 0, upstreams: [{ name: "nousresearch" }], components: [{ name: "ui-kit", behind: 2 }, { name: "agents", behind: 0 }], dirty: 0 },
  { id: "pondering-orb", name: "pondering-orb", focus_branch: "main", behind: 0, ahead: 0, upstreams: [], components: [], dirty: 3 },
  { id: "milaclone", name: "milaclone-mcp", focus_branch: "main", behind: 3, ahead: 1, upstreams: [{ name: "upstream" }], components: [], dirty: 0, conflicts: ["src/board.ts"] },
];
const SUBJECTS = ["Fix the tab order on small screens", "Add a retry to the CalDAV push", "Tidy the settings form", "Bump dependencies", "Speed up the wiki tree", "Document the demo stack", "Handle 429 from the quotes API", "Panel re-measure after data loads"];
const commits = (id) => SUBJECTS.map((s, k) => { const sha = (hash(id + s) * 2654435761 >>> 0).toString(16).padStart(8, "0") + (hash(s) >>> 0).toString(16).padStart(8, "0"); return { sha: sha.slice(0, 10), full: sha.padEnd(40, "0"), subject: s, author: "wiz", date: new Date(Date.now() - (k * 9 + 2) * 3600e3).toISOString() }; });
const requests = [
  { id: "r1", type: "merge", repo_id: "hermes-studio", repo_name: "hermes-studio", status: "pending", safe: true, focus_branch: "main", upstreams: [{ name: "nousresearch", behind: 7 }], conflicts: [], created_at: new Date(Date.now() - 5 * 3600e3).toISOString() },
  { id: "r2", type: "components", repo_id: "hermes-studio", repo_name: "hermes-studio", status: "pending", safe: true, focus_branch: "main", components: [{ name: "ui-kit", behind: 2 }, { name: "theme", behind: 1 }], conflicts: [], created_at: new Date(Date.now() - 2 * 3600e3).toISOString() },
  { id: "r3", type: "merge", repo_id: "milaclone", repo_name: "milaclone-mcp", status: "pending", safe: false, focus_branch: "main", upstreams: [{ name: "upstream", behind: 3 }], conflicts: ["src/board.ts"], created_at: new Date(Date.now() - 26 * 3600e3).toISOString() },
  { id: "r0", type: "merge", repo_id: "argos", repo_name: "argos", status: "approved", safe: true, upstreams: [{ name: "upstream", behind: 4 }], created_at: new Date(Date.now() - 50 * 3600e3).toISOString(), decided_at: new Date(Date.now() - 48 * 3600e3).toISOString(), comment: "Looks good" },
];
function upstream(req, res, p, body) {
  if (p === "/api/repos") return json(res, REPOS.map(r => ({ ...r, last_commit: commits(r.id)[0] })));
  if (p === "/api/requests") return json(res, requests);
  if (p === "/api/run-daily") return json(res, { ok: true, results: [{ repo_id: "argos", repo_name: "argos", status: "up_to_date" }, { repo_id: "hermes-studio", repo_name: "hermes-studio", status: "request_raised", reasons: ["7 commits behind nousresearch"] },
    { repo_id: "milaclone", repo_name: "milaclone-mcp", status: "request_raised", reasons: ["conflict in src/board.ts"] }, { repo_id: "pondering-orb", repo_name: "pondering-orb", status: "skipped_dirty" }] });
  let m;
  if ((m = /^\/api\/repo\/([^/]+)\/publish$/.exec(p))) return json(res, { owner: "demo", github_repo: m[1] });
  if ((m = /^\/api\/repo\/([^/]+)\/commits$/.exec(p))) return json(res, { items: commits(m[1]) });
  if ((m = /^\/api\/repo\/([^/]+)\/fetch$/.exec(p))) { const r = REPOS.find(x => x.id === m[1]); return json(res, { ok: true, plan: { upstreams: (r?.upstreams || []).map(u => ({ name: u.name, behind: r.behind, ahead: r.ahead })), conflicts: r?.conflicts || [], safe: !(r?.conflicts || []).length } }); }
  if ((m = /^\/api\/repo\/([^/]+)\/components\/request$/.exec(p))) { const id = "r" + (requests.length + 1); requests.push({ id, type: "components", repo_id: m[1], repo_name: m[1], status: "pending", safe: true, components: (body.names || []).map(n => ({ name: n, behind: 1 })), created_at: new Date().toISOString() }); return json(res, { ok: true, request: { id } }); }
  if ((m = /^\/api\/request\/([^/]+)\/decide$/.exec(p))) { const r = requests.find(x => x.id === m[1]); if (r) Object.assign(r, { status: body.decision === "approve" ? "approved" : "denied", decided_at: new Date().toISOString(), comment: body.comment }); return json(res, { ok: true }); }
  return json(res, { error: "not found" }, 404);
}
const SESSIONS = [
  { id: "s-orb-phone", title: "Orb phone layout", agent: "claude-code", messages: [["user", "Make the Daily page work on a phone."], ["assistant", "I stacked the panels and moved the brief to the top. Tabs now wrap. Want me to open a PR?"]] },
  { id: "s-nas", title: "NAS disk swap plan", agent: "hermes", messages: [["user", "Plan the disk swap."], ["assistant", "1. Scrub the pool. 2. Offline sdb. 3. Swap and resilver. Expect about 6 hours."]] },
  { id: "s-argos", title: "Argos model shortlist", agent: "ekko-agent", messages: [["user", "Which local model for the Golem?"], ["assistant", "A 14B instruct model fits the 3090 with room for a 32k context."]] },
];
const work = [
  { sessionId: "s-orb-phone", agentId: "claude-code", status: "working", title: "Orb phone layout", orb: { task: { title: "Sketch the Orb phone layout", list: "Inbox" }, project: "Pondering Orb" }, updatedAt: Date.now() - 4 * 60000 },
  { sessionId: "s-nas", agentId: "hermes", status: "needs_you", title: "NAS disk swap plan", orb: { task: { title: "Swap the failing disk in the NAS", list: "Homelab" }, project: "Homelab" }, updatedAt: Date.now() - 45 * 60000 },
  { sessionId: "s-argos", agentId: "ekko-agent", status: "done", title: "Argos model shortlist", orb: { project: "Argos" }, updatedAt: Date.now() - 20 * 3600e3 },
];
function hermes(req, res, p, body) {
  if (p === "/api/auth/login") return json(res, { token: "demo-jwt" });
  if (req.headers.authorization !== "Bearer demo-jwt") return json(res, { error: "unauthorized" }, 401);
  if (p === "/api/studio/orb/work" && req.method === "POST") { const id = "s-" + Math.random().toString(36).slice(2, 8); work.unshift({ sessionId: id, agentId: body.agentId, status: "working", title: body.title, orb: body.orb, updatedAt: Date.now() });
    SESSIONS.unshift({ id, title: body.title, agent: body.agentId, messages: [["user", body.prompt], ["assistant", "On it. (Demo agent: nothing actually runs.)"]] }); return json(res, { work: { sessionId: id } }); }
  if (p === "/api/studio/orb/work") return json(res, { work });
  if (p === "/api/coding-agents") return json(res, { tools: [{ id: "claude-code", name: "Claude Code", installed: true }, { id: "codex", name: "Codex", installed: true }, { id: "opencode", name: "OpenCode", installed: false }] });
  const list = () => SESSIONS.map((s, k) => ({ id: s.id, title: s.title, agent: s.agent, model: "local", messageCount: s.messages.length, startedAt: Date.now() - (k + 1) * 7200e3, lastActive: Date.now() - (k + 1) * 1800e3 }));
  if (p === "/api/studio/sessions" || p === "/api/studio/search/sessions") return json(res, { sessions: list(), results: list() });
  if (p === "/api/studio/sessions/hermes") return json(res, { sessions: [] });
  const m = /^\/api\/studio\/sessions\/([^/]+)$/.exec(p);
  if (m) { const s = SESSIONS.find(x => x.id === m[1]); return s ? json(res, { session: { title: s.title, messages: s.messages.map(([role, content]) => ({ role, content })) } }) : json(res, { error: "not found" }, 404); }
  return json(res, { error: "not found" }, 404);
}

// =====================================================================
// LLMWIKI's REST API (reads come from the mounted vault; writes are kept in memory)
// =====================================================================
const wikiWrites = new Map();
async function walk(dir, out = []) { for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) { if (e.name.startsWith(".")) continue; const p = join(dir, e.name); if (e.isDirectory()) await walk(p, out); else if (e.name.endsWith(".md")) out.push(p); } return out; }
async function wiki(req, res, p, body, url) {
  if (req.headers.authorization !== "Bearer demo") return json(res, { message: "bad key" }, 401);
  if (p === "/search/simple/") {
    const q = String(url.searchParams.get("query") || "").toLowerCase(), hits = [];
    for (const f of await walk(VAULT)) { const t = await readFile(f, "utf8"); const i = t.toLowerCase().indexOf(q); if (q && i >= 0) hits.push({ filename: f.slice(VAULT.length + 1), score: 1, matches: [{ context: t.slice(Math.max(0, i - 60), i + 80) }] }); }
    return json(res, hits);
  }
  if (p.startsWith("/vault/")) {
    const rel = normalize(decodeURIComponent(p.slice(7))); if (rel.startsWith("..")) return json(res, {}, 400);
    if (req.method === "GET") { if (wikiWrites.has(rel)) return text(res, wikiWrites.get(rel), "text/markdown"); try { return text(res, await readFile(join(VAULT, rel), "utf8"), "text/markdown"); } catch { return json(res, { message: "not found" }, 404); } }
    if (req.method === "PUT") { wikiWrites.set(rel, body); return text(res, "", "text/plain", 204); }
    return text(res, "", "text/plain", 204); // PATCH, POST: accepted
  }
  return json(res, {}, 404);
}

// =====================================================================
// Firefly III, Coinpile, Omi, Plex, SABnzbd
// =====================================================================
function firefly(res, p, url) {
  const pg = { meta: { pagination: { total_pages: 1 } } }, box = (k, v) => ({ [k]: { key: k, monetary_value: v, currency_code: "USD" } });
  if (p === "/api/v1/summary/basic") return json(res, { ...box("balance-in-USD", "2140.55"), ...box("spent-in-USD", "-1912.37"), ...box("earned-in-USD", "4310.00"), ...box("left-to-spend-in-USD", "418.20"), ...box("net-worth-in-USD", "61384.12"), ...box("bills-paid-in-USD", "-1450.00"), ...box("bills-unpaid-in-USD", "-207.47") });
  const bill = (id, name, amt, d, paid) => ({ id, attributes: { name, amount_avg: String(amt), currency_code: "USD", repeat_freq: "monthly", active: true, pay_dates: [`${d}T00:00:00Z`], paid_dates: paid ? [{ date: `${d}T00:00:00Z` }] : [] } });
  if (p === "/api/v1/bills") return json(res, { ...pg, data: [bill("1", "Rent", 1450, day(-3), true), bill("2", "Streaming bundle", 22.99, day(0)), bill("3", "Internet", 79.99, day(2)), bill("4", "Phone", 45, day(5)), bill("5", "Car insurance", 104.49, day(12))] });
  if (p === "/api/v1/budget-limits") return json(res, { ...pg, data: [["5", 500, 462], ["6", 200, 231], ["7", 250, 88], ["8", 150, 61]].map(([b, a, s]) => ({ attributes: { budget_id: b, amount: String(a), spent: String(-s), currency_code: "USD" } })) });
  if (p === "/api/v1/budgets") return json(res, { ...pg, data: [["5", "Groceries"], ["6", "Eating out"], ["7", "Homelab"], ["8", "Fun money"]].map(([id, name]) => ({ id, attributes: { name } })) });
  if (p === "/api/v1/piggy-banks") return json(res, { ...pg, data: [["New NAS drives", 610, 900], ["Trip to the coast", 950, 3000], ["Rainy day", 5200, 6000]].map(([name, c, t]) => ({ attributes: { name, current_amount: String(c), target_amount: String(t), percentage: Math.round((c / t) * 100), currency_code: "USD" } })) });
  if (p === "/api/v1/accounts") return json(res, { ...pg, data: url.searchParams.get("type") === "asset"
    ? [["Checking", 2140.55], ["Savings", 14200], ["Brokerage", 52843.57]].map(([name, b]) => ({ attributes: { name, type: "asset", current_balance: String(b), currency_code: "USD", include_net_worth: true } }))
    : [{ attributes: { name: "Car loan", type: "liabilities", current_balance: "-7800", currency_code: "USD", include_net_worth: true } }] });
  if (p === "/api/v1/transactions" || p === "/api/v1/search/transactions") {
    const T = [[-1, "Corner market", 64.12, "withdrawal", "Groceries"], [-1, "Noodle bar", 23.5, "withdrawal", "Eating out"], [-2, "Hardware store", 41.07, "withdrawal", "Homelab"], [-3, "Rent", 1450, "withdrawal", "Housing"], [-4, "Paycheck", 2155, "deposit", "Salary"], [-5, "Fuel", 48.3, "withdrawal", "Car"], [-6, "Bookshop", 18.99, "withdrawal", "Fun money"]];
    return json(res, { ...pg, data: T.map(([k, d, a, type, cat]) => ({ attributes: { transactions: [{ date: `${day(k)}T10:00:00Z`, description: d, amount: String(a), type, category_name: cat, budget_name: cat, source_name: type === "deposit" ? "Employer" : "Checking", destination_name: type === "deposit" ? "Checking" : d, currency_code: "USD" }] } })) });
  }
  return json(res, { message: "not found" }, 404);
}
const coinpile = () => ({ goblins: { wiz: { name: "wiz", net_worth: 61384.12, subscriptions_monthly: 74.97,
  bills: { next_7d: 147.98, next_30d: 1752.47, next: { name: "Streaming bundle", date: day(0), amount: 22.99 } }, alerts: { total: 5, critical: 1, warning: 2 },
  bill_list: [{ date: day(0), name: "Streaming bundle", amount: 22.99, category: "Subscriptions" }, { date: day(2), name: "Internet", amount: 79.99, category: "Utilities" }],
  alert_list: [{ severity: "critical", kind: "bank_login", title: "Lantern Credit Union needs you to sign in again", detail: "At the Plaid connector" },
    { severity: "warning", kind: "maturing", title: "12-month CD matures in 4 days", detail: "Worth about 10,512.20", date: day(4) },
    { severity: "warning", kind: "matured_idle", title: "6-month CD matured 9 days ago and is still sitting there", detail: "Roll it over or move it", date: day(-9) },
    { severity: "info", kind: "free_savings", title: "$1,400 of your savings is free", detail: "New NAS drives still needs $290" }, { severity: "info", kind: "due_soon", title: "Streaming bundle due today", date: day(0) }],
  savings: { total: 14200, free: 1400, earmarked: 12800 }, goals: [{ name: "New NAS drives", target: 900, allocated: 610, pct: 0.678 }, { name: "Trip to the coast", target: 3000, allocated: 950, pct: 0.317 }, { name: "Rainy day", target: 6000, allocated: 5200, pct: 0.867 }],
  robinhood_main: { value: 18422.9, as_of: `${day(-1)}T20:00:00` }, robinhood_agent: { value: 512.3, as_of: `${day(-1)}T20:00:00` },
  spending: { so_far: 1912.37, projected: 3880, income_avg: 4310, left_after: 430 } } } });
const omiDays = () => [1, 2, 3].map(k => ({ date: day(-k), day_emoji: ["🛠", "🌲", "📚"][k - 1], headline: ["Planned the NAS disk swap and backup window", "A long walk and a slow Sunday", "Reading about local models for the Golem"][k - 1],
  overview: ["Most of the day went to the NAS: a scrub found a failing disk, and you settled on a Sunday 2am backup window.", "Hiked Elder Falls with Sam and Pip, then batch-cooked for the week.", "Compared three local models for the Golem and sketched a phone layout for the Orb."][k - 1],
  decisions_made: [{ decision: ["Backups move to Sunday 2am", "Batch-cook on Sundays", "Try a 14B model first"][k - 1] }], unresolved_questions: [{ question: ["Which UPS to buy?", "Swim class on Mondays or Thursdays?", "Is 32k context enough?"][k - 1] }],
  highlights: [{ topic: ["NAS", "Family", "Models"][k - 1], emoji: "✨", summary: ["Disk sdb is failing; replacement ordered.", "Pip found a salamander.", "Quantised models fit the 3090."][k - 1] }], knowledge_nuggets: [{ insight: "ZFS scrubs are best run weekly." }] }));
const omiConvs = () => [["NAS planning", "💾", "RAID rebuild, the failing disk and backup timing.", 3], ["Grocery list", "🛒", "Weekly list and a reminder about oat milk.", 20], ["Model shortlist", "🤖", "Which local model to run for the Golem.", 30]]
  .map(([title, emoji, overview, h], k) => ({ id: `c${k}`, started_at: new Date(Date.now() - h * 3600e3).toISOString(), structured: { title, emoji, overview } }));
const plex = () => ({ MediaContainer: { Metadata: [{ type: "episode", grandparentTitle: "The Lantern Keepers", parentIndex: 2, index: 5, title: "Low Tide", User: { title: "Sam" }, Player: { title: "Living room TV", state: "playing" }, duration: 2700000, viewOffset: 1300000 },
  { type: "movie", title: "Over the Elder Hills", User: { title: "Pip" }, Player: { title: "iPad", state: "paused" }, duration: 5400000, viewOffset: 4200000, TranscodeSession: {} }] } });
const sab = () => ({ queue: { speed: "38.2 M", timeleft: "0:12:40", paused: false, sizeleft: "4.1 GB", slots: [{ filename: "Linux.ISO.Collection.2026", percentage: "62", size: "6.2 GB", status: "Downloading" }, { filename: "Public.Domain.Films.Pack", percentage: "0", size: "2.3 GB", status: "Queued" }] } });

// =====================================================================
// Router
// =====================================================================
const strip = (p, pre) => (p === pre ? "/" : p.startsWith(pre + "/") ? p.slice(pre.length) : null);
createServer((req, res) => {
  let body = ""; req.on("data", c => (body += c)); req.on("end", async () => {
    try {
      const url = new URL(req.url, "http://fakes"), p = url.pathname;
      let b = {}; if (/json/.test(req.headers["content-type"] || "") && body) { try { b = JSON.parse(body); } catch { /* not json */ } }
      let s;
      if (p === "/health") return json(res, { ok: true });
      if (p === "/geo") return json(res, { results: [{ name: "Elderglen", admin1: "Westmarch", country_code: "US", latitude: 45.5, longitude: -122.6 }] });
      if (p === "/wx") return json(res, wx());
      if (p.startsWith("/chart/")) return json(res, chart(decodeURIComponent(p.split("/")[2]).toUpperCase()));
      if (p === "/news") return text(res, rss("Demo Wire", url.searchParams.get("q") || ""), "application/rss+xml");
      if ((s = strip(p, "/feed")) !== null) return text(res, rss({ "/world": "Demo World Service", "/markets": "Demo Markets Desk", "/local": "Elderglen Gazette" }[s] || "Demo Wire", ""), "application/rss+xml");
      if (p === "/llm/v1/chat/completions") return chatRoute(req, res, b);
      if (p === "/llm/v1/models") return json(res, { data: [{ id: "demo-golem" }] });
      if (p === "/jev") { const sym = b.state?.symbol || "X"; return json(res, { model: "jev-demo", answers: verdictFor(sym) }); }
      if ((s = strip(p, "/glance")) !== null) {
        if (p.startsWith(DAV.slice(0, -1))) return dav(req, res, p.endsWith("/") || p.includes(".ics") ? p : p + "/", body);
        if (req.headers.authorization !== "Bearer demo") return json(res, { error: "token" }, 401);
        if (s === "/health") return json(res, { ok: true, services: { vikunja: true, dayglance: true, lastglance: true, lifeglance: true } });
        if (s === "/api/allglance/users") return json(res, { users: USERS });
        if (s.startsWith("/api/allglance/days/")) { const d = decodeURIComponent(s.split("/")[4]); return json(res, { date: d, blocks: blocksFor(d) }); }
        if (s === "/api/allglance/tasks" && req.method === "POST") { const [date, time] = String(b.start || "").split(" "); const id = "add-" + added.length; added.push({ id, title: b.title, date: date || b.due_date, time: time || null, minutes: b.duration_minutes || 60, owner: b.owner_id || "u-wiz" }); return json(res, { source: "dayglance", task: { id } }); }
        if (s === "/api/allglance/tasks") return json(res, { dayglance: dayglanceTasks() });
        if (s === "/api/allglance/chores") return json(res, { chores: glanceChores() });
        if (s === "/api/allglance/milestones") return json(res, { milestones: milestones() });
        return json(res, { error: "not found" }, 404);
      }
      if ((s = strip(p, "/uptime")) !== null) { if (s === "/api/status-page/orb") return json(res, { config: { title: "Demo" }, publicGroupList: uptimePage().publicGroupList }); if (s === "/api/status-page/heartbeat/orb") return json(res, uptimePage()); return json(res, {}, 404); }
      if ((s = strip(p, "/um")) !== null) return upstream(req, res, s, b);
      if ((s = strip(p, "/hermes")) !== null) return hermes(req, res, s, b);
      if ((s = strip(p, "/wiki")) !== null) return wiki(req, res, s, body, url);
      const authed = req.headers.authorization === "Bearer demo";
      if ((s = strip(p, "/firefly")) !== null) return authed ? firefly(res, s, url) : json(res, { message: "Unauthenticated." }, 401);
      if ((s = strip(p, "/coinpile")) !== null) return !authed ? json(res, { detail: "invalid token" }, 401) : s === "/api/v1/summary" ? json(res, coinpile()) : json(res, {}, 404);
      if ((s = strip(p, "/omi")) !== null) {
        if (!authed) return json(res, { detail: "invalid key" }, 401);
        if (s === "/v1/dev/user/daily-summaries") { const d = url.searchParams.get("start_date"); return json(res, { summaries: d ? omiDays().filter(x => x.date === d) : omiDays() }); }
        if (s === "/v1/dev/user/conversations") return json(res, omiConvs());
        if (s === "/v1/dev/user/memories/search") { const q = (url.searchParams.get("query") || "").toLowerCase(); const M = ["Prefers backups on Sunday nights", "Is choosing between two UPS models", "Pip's swim class is on Mondays", "Wants the Golem to run on a local model", "Allergic to cats"]; return json(res, { memories: M.filter(m => !q || m.toLowerCase().includes(q.split(" ")[0])).map(content => ({ content, category: "personal", created_at: new Date().toISOString() })) }); }
        return json(res, {}, 404);
      }
      if (p === "/plex/status/sessions") return req.headers["x-plex-token"] === "demo" ? json(res, plex()) : json(res, {}, 401);
      if (p === "/sab/api") return url.searchParams.get("apikey") === "demo" ? json(res, sab()) : json(res, { status: false, error: "API Key Incorrect" });
      return json(res, { error: "not found" }, 404);
    } catch (e) { console.error(e); json(res, { error: String(e?.message || e) }, 500); }
  });
}).listen(PORT, "0.0.0.0", () => console.log(`demo fakes on :${PORT}`));
