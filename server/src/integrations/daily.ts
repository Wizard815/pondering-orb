import { call } from "./http.js";
import { HttpError } from "../records.js";

/** Data for the Daily page: weather, news headlines and stock prices. All
 *  three use free sources that need no key. Answers are cached so a page
 *  full of panels (and the morning brief) doesn't hammer anyone. */
export const sources = {
  geocode: "https://geocoding-api.open-meteo.com/v1/search",
  forecast: "https://api.open-meteo.com/v1/forecast",
  yahoo: "https://query1.finance.yahoo.com/v8/finance/chart",
  stooq: "https://stooq.com/q/d/l/",
  tiingo: "https://api.tiingo.com/tiingo/daily",
  googleNews: "https://news.google.com/rss/search",
};
const UA = { "User-Agent": "PonderingOrb/0.1 (self-hosted dashboard)" };

const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ms: number, get: () => Promise<T>): Promise<T> {
  const c = cache.get(key); if (c && Date.now() - c.at < ms) return c.v as T;
  const v = await get(); cache.set(key, { at: Date.now(), v }); return v;
}
export const clearDailyCache = () => cache.clear();

// ---- weather (Open-Meteo) ----
const WMO: Record<number, string> = { 0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Freezing fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  56: "Freezing drizzle", 57: "Freezing drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Showers", 81: "Showers", 82: "Heavy showers", 85: "Snow showers", 86: "Snow showers", 95: "Thunderstorm", 96: "Thunderstorm, hail", 99: "Thunderstorm, hail" };
export type Weather = { place: string; units: "F" | "C"; now: { temp: number; feels: number; wind: number; text: string; code: number };
  days: { date: string; high: number; low: number; rain: number; text: string; code: number }[] };
export async function weather(location: string, units: "F" | "C" = "F"): Promise<Weather> {
  if (!location.trim()) throw new HttpError(400, "Set your location in Settings → Daily page.");
  return cached(`wx:${location}:${units}`, 20 * 60000, async () => {
    // "lat,lon" works as is; anything else is looked up by name.
    let lat: number, lon: number, place = location;
    const ll = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(location);
    if (ll) { lat = +ll[1]; lon = +ll[2]; }
    else {
      const g = await call(`${sources.geocode}?name=${encodeURIComponent(location.split(",")[0].trim())}&count=5&language=en&format=json`, { headers: UA });
      const hits: any[] = g.body?.results || [], want = location.split(",").slice(1).join(",").trim().toLowerCase();
      const hit = hits.find(h => !want || [h.admin1, h.country, h.country_code].some((x: string) => String(x || "").toLowerCase().startsWith(want))) || hits[0];
      if (!hit) throw new HttpError(404, `Couldn't find “${location}”. Try “City, Country” or “lat,lon”.`);
      lat = hit.latitude; lon = hit.longitude; place = [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(", ");
    }
    const u = units === "C" ? "" : "&temperature_unit=fahrenheit&wind_speed_unit=mph";
    const r = await call(`${sources.forecast}?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=7&timezone=auto${u}`, { headers: UA });
    if (!r.ok) throw new HttpError(502, `The weather service answered ${r.status}.`);
    const c = r.body.current, d = r.body.daily;
    return { place, units, now: { temp: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature), wind: Math.round(c.wind_speed_10m), code: c.weather_code, text: WMO[c.weather_code] || "" },
      days: d.time.map((date: string, k: number) => ({ date, high: Math.round(d.temperature_2m_max[k]), low: Math.round(d.temperature_2m_min[k]), rain: d.precipitation_probability_max?.[k] ?? 0, code: d.weather_code[k], text: WMO[d.weather_code[k]] || "" })) };
  });
}

// ---- news (RSS / Atom) ----
export type NewsItem = { title: string; link: string; source: string; published: number; summary: string };
const ent = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as any)[e.toLowerCase()]);
const strip = (s: string) => ent(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const pick = (x: string, t: string) => { const m = new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)</${t}>`, "i").exec(x); return m ? m[1] : ""; };
/** Items from one RSS 2.0 or Atom feed, newest first. */
export function parseFeed(xml: string, fallbackSource = ""): NewsItem[] {
  const feedTitle = strip(pick(xml.replace(/<(item|entry)\b[\s\S]*$/i, ""), "title")) || fallbackSource;
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map(m => m[0]);
  return blocks.map(b => {
    const link = strip(pick(b, "link")) || (/<link\b[^>]*href="([^"]+)"/i.exec(b)?.[1] ?? "");
    const date = pick(b, "pubDate") || pick(b, "published") || pick(b, "updated") || pick(b, "dc:date");
    return { title: strip(pick(b, "title")), link: ent(link), source: strip(pick(b, "source")) || feedTitle, published: Date.parse(strip(date)) || 0,
      summary: strip(pick(b, "description") || pick(b, "summary") || pick(b, "content")).slice(0, 280) };
  }).filter(i => i.title && /^https?:\/\//.test(i.link)).sort((a, b) => b.published - a.published);
}
export async function news(feeds: string[], limit = 20): Promise<NewsItem[]> {
  const ok = feeds.map(f => f.trim()).filter(f => /^https?:\/\//i.test(f)).slice(0, 15);
  if (!ok.length) throw new HttpError(400, "Add news feeds in Settings → Daily page.");
  return cached(`news:${ok.join("|")}`, 15 * 60000, async () => {
    const all = await Promise.all(ok.map(f => call(f, { headers: { ...UA, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" } })
      .then(r => (r.ok ? parseFeed(String(r.body), new URL(f).host) : []), () => [] as NewsItem[])));
    // Drop the same story from two feeds (same title).
    const seen = new Set<string>();
    return all.flat().sort((a, b) => b.published - a.published).filter(i => { const k = i.title.toLowerCase().slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, limit);
  });
}
/** Headlines about a topic or ticker (Google News search feed). */
export async function newsSearch(q: string, limit = 10): Promise<NewsItem[]> {
  return cached(`gn:${q}`, 30 * 60000, async () => {
    const r = await call(`${sources.googleNews}?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`, { headers: UA });
    return r.ok ? parseFeed(String(r.body), "Google News").slice(0, limit) : [];
  });
}

// ---- stock prices: Tiingo when TIINGO_API_KEY is set, else Yahoo's chart API, else Stooq ----
export type Bar = { date: string; close: number };
export type Quote = { symbol: string; name: string; price: number; prev: number; change: number; changePct: number; currency: string; at: number; history: Bar[] };
export const cleanSymbol = (s: string) => { const x = String(s || "").trim().toUpperCase(); return /^[A-Z^][A-Z0-9.^=-]{0,14}$/.test(x) ? x : ""; };
const ymd = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
async function yahoo(sym: string, range: string): Promise<Quote> {
  const r = await call(`${sources.yahoo}/${encodeURIComponent(sym)}?range=${range}&interval=1d`, { headers: UA });
  const res = r.body?.chart?.result?.[0]; if (!r.ok || !res) throw new HttpError(502, `No prices for ${sym} (${r.body?.chart?.error?.description || r.status}).`);
  const m = res.meta, closes: (number | null)[] = res.indicators?.quote?.[0]?.close || [];
  const history = (res.timestamp || []).map((t: number, k: number) => ({ date: ymd(t), close: closes[k] })).filter((b: any) => typeof b.close === "number") as Bar[];
  const price = m.regularMarketPrice ?? history.at(-1)?.close ?? 0, prev = m.chartPreviousClose ?? m.previousClose ?? history.at(-2)?.close ?? price;
  return { symbol: sym, name: m.shortName || m.longName || sym, price, prev, change: price - prev, changePct: prev ? ((price - prev) / prev) * 100 : 0, currency: m.currency || "USD", at: (m.regularMarketTime || 0) * 1000, history };
}
/** Tiingo: free with a key (TIINGO_API_KEY), daily closes for US stocks and ETFs. */
async function tiingo(sym: string, key: string): Promise<Quote> {
  const start = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  const r = await call(`${sources.tiingo}/${encodeURIComponent(sym.toLowerCase())}/prices?startDate=${start}&token=${encodeURIComponent(key)}`, { headers: { ...UA, Accept: "application/json" } });
  if (!r.ok || !Array.isArray(r.body) || !r.body.length) throw new HttpError(502, `Tiingo has no prices for ${sym} (${r.status}).`);
  const history = r.body.map((b: any) => ({ date: String(b.date).slice(0, 10), close: Number(b.adjClose ?? b.close) })).filter((b: Bar) => Number.isFinite(b.close));
  const price = history.at(-1)!.close, prev = history.at(-2)?.close ?? price;
  return { symbol: sym, name: sym, price, prev, change: price - prev, changePct: prev ? ((price - prev) / prev) * 100 : 0, currency: "USD", at: Date.parse(history.at(-1)!.date) || 0, history };
}
async function stooq(sym: string): Promise<Quote> {
  const s = sym.startsWith("^") ? sym.toLowerCase() : sym.includes(".") ? sym.toLowerCase() : sym.toLowerCase() + ".us";
  const r = await call(`${sources.stooq}?s=${encodeURIComponent(s)}&i=d`, { headers: UA });
  const rows = String(r.body || "").trim().split(/\r?\n/).slice(1).map(l => l.split(",")).filter(c => c.length >= 5 && !isNaN(+c[4]));
  if (!rows.length) throw new HttpError(502, `No prices for ${sym}.`);
  const history = rows.slice(-400).map(c => ({ date: c[0], close: +c[4] })), price = history.at(-1)!.close, prev = history.at(-2)?.close ?? price;
  return { symbol: sym, name: sym, price, prev, change: price - prev, changePct: prev ? ((price - prev) / prev) * 100 : 0, currency: "USD", at: Date.parse(history.at(-1)!.date) || 0, history };
}
/** A quote with up to a year of daily closes. */
export async function quote(symbol: string, range = "1y"): Promise<Quote> {
  const sym = cleanSymbol(symbol); if (!sym) throw new HttpError(400, `“${symbol}” isn't a ticker.`);
  const key = process.env.TIINGO_API_KEY || "";
  return cached(`q:${sym}:${range}`, 10 * 60000, () => (key && !sym.startsWith("^") ? tiingo(sym, key) : Promise.reject(new Error("no key")))
    .catch(() => yahoo(sym, range)).catch(() => stooq(sym)));
}
export async function quotes(symbols: string[]) {
  const list = [...new Set(symbols.map(cleanSymbol).filter(Boolean))].slice(0, 40);
  return Promise.all(list.map(s => quote(s).then(q => ({ ...q, history: q.history.slice(-30) }), (e: any) => ({ symbol: s, error: e.message as string }))));
}
/** The closing price on a day, or the first trading day after it. */
export const closeOn = (h: Bar[], day: string) => h.find(b => b.date >= day)?.close;
