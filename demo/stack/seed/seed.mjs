// Fills a fresh demo Orb with synthetic records through its own API, then
// asks it to sync, research and write today's brief. Runs once: a second run
// sees the marker in settings and only refreshes the day's brief and picks.
const ORB = (process.env.ORB_URL || "http://orb:8095").replace(/\/$/, "");
const FAKES = (process.env.FAKES_URL || "http://fakes:8300").replace(/\/$/, "");
const PASSWORD = process.env.ORB_PASSWORD || "demo";

const fmt = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
const day = (n = 0) => fmt.format(new Date(Date.now() + n * 864e5));
const sleep = (ms) => new Promise(ok => setTimeout(ok, ms));

let cookie = "";
async function api(method, path, body) {
  const r = await fetch(ORB + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${typeof j === "string" ? j : j?.error || ""}`);
  return j;
}

// ---- wait for Orb, sign in ----
for (let k = 0; ; k++) { try { if ((await fetch(ORB + "/api/health")).ok) break; } catch { /* not up */ } if (k > 120) throw new Error("Orb didn't start"); await sleep(1000); }
{ const r = await fetch(ORB + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
  if (!r.ok) throw new Error(`sign-in failed: ${r.status}`); cookie = (r.headers.get("set-cookie") || "").split(";")[0]; }

const settings = await api("GET", "/api/c/settings/app").catch(() => ({}));
const fresh = !settings?.demoSeeded;

if (fresh) {
  console.log("Seeding the demo Orb…");
  // ---- apps (with live panels and full pages) ----
  await api("PUT", "/api/c/settings/apps", { yaml: `groups:
  - name: Household
    apps:
      - name: Firefly III
        url: ${FAKES}/firefly
        description: Finances (synthetic)
        widget: { type: firefly, key_env: FIREFLY_TOKEN, page: true }
      - name: Coinpile
        url: ${FAKES}/coinpile
        description: Savings, goals and alerts (synthetic)
        widget: { type: coinpile, key_env: COINPILE_TOKEN, page: true }
      - name: Omi
        url: ${FAKES}/omi
        description: Day recaps (synthetic)
        widget: { type: omi, key_env: OMI_DEV_KEY, page: true }
  - name: Media
    apps:
      - name: Plex
        url: ${FAKES}/plex
        widget: { type: plex, key_env: PLEX_TOKEN }
      - name: SABnzbd
        url: ${FAKES}/sab
        widget: { type: sabnzbd, key_env: SABNZBD_API_KEY }
  - name: Lab
    apps:
      - name: Hermes Studio
        url: https://example.com/hermes-studio
        description: Agent chats
      - name: Uptime Kuma
        url: https://example.com/uptime
        description: Monitors
` });

  // ---- settings: Daily page, stock picks (self-hosted decision model) ----
  const { id: _i, version: _v, ...cur } = settings || {};
  await api("PUT", "/api/c/settings/app", { ...cur, demoSeeded: true,
    daily: { location: "Elderglen", units: "F", watchlist: ["SPY", "QQQ", "GLMR", "RUNE", "EMBR"], briefOn: true, briefHour: 6, feeds: [`${FAKES}/feed/world`, `${FAKES}/feed/markets`, `${FAKES}/feed/local`] },
    market: { on: true, hour: 6, weekdaysOnly: false, maxPicks: 3, notional: 100, index: "SPY", decider: { kind: "jev", baseUrl: `${FAKES}/jev`, model: "jev-demo", keyEnv: "" } },
    robinhood: { tradingOn: false, maxOrder: 100, maxDay: 300 } });

  // ---- projects ----
  const P = [
    { name: "Pondering Orb", status: "active", fav: true, area: "homelab", repo: "https://example.com/wizard/pondering-orb", wikiNote: "wiki/1-projects/Pondering Orb.md", upstreamRepo: "pondering-orb", chats: ["s-orb-phone"], next: "Phone layout for Daily" },
    { name: "Argos", status: "next", fav: true, area: "ai", wikiNote: "wiki/1-projects/Argos.md", upstreamRepo: "argos", logCommits: true, chats: ["s-argos"], next: "Try a 14B model" },
    { name: "Homelab", status: "blocked", fav: true, area: "homelab", wikiNote: "wiki/1-projects/Homelab.md", chats: ["s-nas"], next: "Waiting on the replacement disk" },
    { name: "Milaclone", status: "paused", fav: false, area: "tools", wikiNote: "wiki/1-projects/Milaclone.md", upstreamRepo: "milaclone", next: "Resolve the board.ts conflict" },
    { name: "Hermes Studio fork", status: "active", fav: true, area: "ai", upstreamRepo: "hermes-studio", logCommits: true, next: "Merge 7 upstream commits" },
    { name: "Garden irrigation", status: "shipped", fav: false, area: "home", next: "" },
  ];
  for (const p of P) await api("POST", "/api/c/projects", p);

  // ---- log ----
  const L = [[0, "Pondering Orb", "Hid pages for apps that aren't set up"], [0, "Homelab", "Scrub found checksum errors on sdb"], [-1, "Argos", "Benchmarked two 14B models"], [-1, "Pondering Orb", "Added the Coinpile page"],
    [-2, "Homelab", "Ordered a replacement disk"], [-2, "Hermes Studio fork", "Raised a merge request for upstream"], [-3, "Garden irrigation", "Shipped the drip timer"], [-4, "Milaclone", "Paused until the board rewrite lands"],
    [-5, "Argos", "Moved models to the fast SSD"], [-6, "Pondering Orb", "Daily page: weather, news and markets"], [-8, "Homelab", "Pi-hole number two is live"], [-9, "General", "Cleaned out the cable drawer"]];
  for (const [d, project, text] of L) await api("POST", "/api/c/logs", { date: day(d), project, text, created: Date.now() + d * 864e5 - Math.random() * 3600e3 });

  // ---- Orb's own calendar events ----
  for (const [d, title, time] of [[2, "Pick up the replacement disk", "12:00"], [5, "Orb demo for Sam", "19:00"], [11, "Renew passport", ""]]) await api("POST", "/api/c/events", { title, date: day(d), ...(time ? { time } : {}) });

  // ---- the Ideas board ----
  const card = (c) => api("POST", "/api/c/canvas", { board: "root", color: "", updated: day(0), ...c });
  const col = await card({ type: "column", title: "Orb ideas", x: 40, y: 40, w: 250 });
  const a = await card({ type: "idea", title: "Phone layout", text: "Stack panels; brief first.", stage: "design", x: 340, y: 40, w: 240, color: "gold" });
  const b = await card({ type: "idea", title: "Voice to the Golem", text: "Push-to-talk through Omi?", stage: "thought", x: 340, y: 220, w: 240, color: "arcane" });
  await card({ type: "todo", title: "Before the demo", items: [{ t: "Seed data", done: true }, { t: "Screenshots", done: false }, { t: "README", done: false }], x: 640, y: 40, w: 230 });
  await card({ type: "note", title: "Rule of the tower", text: "Read only unless it's ours to write.", x: 640, y: 260, w: 220, color: "muted" });
  await card({ type: "tasks", title: "Homelab list", list: "Homelab", x: 40, y: 300, w: 250 });
  await api("POST", "/api/c/edges", { board: "root", from: a.id, to: b.id, kind: "relates", label: "" });
  void col;

  // ---- past stock picks, so Picks has history and a scorecard ----
  const closes = async (sym) => { const r = await (await fetch(`${FAKES}/chart/${sym}`)).json(); const res = r.chart.result[0]; return res.timestamp.map((t, k) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: res.indicators.quote[0].close[k] })); };
  const verdict = async (symbol) => (await (await fetch(`${FAKES}/jev`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: { symbol: symbol + "-past" } }) })).json()).answers;
  const PAST = [[-95, "EMBR", "yes", 150], [-88, "TWRH", "no", 0], [-81, "GLMR", "yes", 100], [-74, "MOSS", "no", 0], [-66, "QUIL", "yes", 120], [-59, "OWLX", "no", 0],
    [-45, "BRZN", "yes", 80], [-38, "RUNE", "no", 0], [-30, "EMBR", "yes", 100], [-21, "TWRH", "no", 0], [-12, "GLMR", "yes", 100], [-6, "MOSS", "no", 0]];
  const THESIS = { EMBR: "Bakery deal widens its regional footprint.", TWRH: "Buyback announced; balance sheet is clean.", GLMR: "Orders are running ahead of guidance.", MOSS: "Turbine plant delay is priced in.",
    QUIL: "Cloud revenue growing faster than expected.", OWLX: "Fuel costs hurt, but volumes held up.", BRZN: "New clinic network opening ahead of plan.", RUNE: "Contract wins keep coming." };
  for (const [d, sym, decision, amount] of PAST) {
    const h = await closes(sym), date = day(d), k = h.findIndex(b => b.date >= date); if (k < 21) continue;
    const price = h[k].close, ret20 = +(((price / h[k - 20].close) - 1) * 100).toFixed(2), answers = await verdict(sym + d);
    await api("PUT", `/api/c/picks/${h[k].date}-${sym}`, { date: h[k].date, symbol: sym, name: sym, thesis: THESIS[sym], catalyst: "Synthetic demo catalyst", sources: [], priceAtPick: price, pickedAt: Date.parse(`${h[k].date}T13:00:00Z`),
      state: { as_of: h[k - 1].date, symbol: sym, price, indicators: { ret_20d_pct: ret20 } }, verdict: { answers, source: "jev", model: "jev-demo" }, promptVersion: "picks-v1",
      decision, amount, decidedAt: Date.parse(`${h[k].date}T14:00:00Z`), note: "", outcomes: {} });
  }
}

// ---- every run: sync tasks, log commits, score picks, research, brief ----
const step = async (label, f) => { try { await f(); console.log("✓", label); } catch (e) { console.log("✗", label, e.message); } };
await step("CalDAV sync", () => api("POST", "/api/caldav/sync", {}));
await step("UpstreamManager commits", () => api("POST", "/api/upstream/poll", {}));
await step("pick outcomes", () => api("POST", "/api/market/outcomes", {}));
const research = await api("GET", `/api/c/research/${day(0)}`).catch(() => null);
if (!research || research.status === "failed") {
  await step("stock research", async () => { await api("POST", "/api/market/run", {}); for (let k = 0; k < 60; k++) { await sleep(1000); const r = await api("GET", `/api/c/research/${day(0)}`).catch(() => null); if (r && ["done", "failed"].includes(r.status)) { if (r.status === "failed") throw new Error(r.error); return; } } });
}
await step("morning brief", () => api("POST", "/api/daily/brief", {}));
console.log(`Demo ready: open ${process.env.ORB_PUBLIC || "http://localhost:8095"} and sign in with "${PASSWORD}".`);
