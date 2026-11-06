import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HttpError } from "../records.js";
import type { Bar } from "./daily.js";

/** Price indicators for a verdict, from daily closes up to as_of (the same
 *  set jev_stock feeds Jev: returns, distance from moving averages,
 *  volatility, RSI, and performance against an index). */
export function indicators(h: Bar[], index?: Bar[]) {
  const c = h.map(b => b.close), n = c.length, last = c[n - 1];
  if (n < 2) return null;
  const ret = (k: number) => (n > k ? +(((last / c[n - 1 - k]) - 1) * 100).toFixed(2) : null);
  const ma = (k: number) => (n >= k ? c.slice(-k).reduce((a, b) => a + b, 0) / k : null);
  const dist = (k: number) => { const m = ma(k); return m ? +(((last / m) - 1) * 100).toFixed(2) : null; };
  const daily = c.slice(1).map((x, i) => x / c[i] - 1), r20 = daily.slice(-20);
  const mean = r20.reduce((a, b) => a + b, 0) / (r20.length || 1);
  const vol20 = r20.length > 1 ? +(Math.sqrt(r20.reduce((a, b) => a + (b - mean) ** 2, 0) / (r20.length - 1)) * 100).toFixed(2) : null;
  const g = daily.slice(-14), up = g.filter(x => x > 0).reduce((a, b) => a + b, 0), dn = -g.filter(x => x < 0).reduce((a, b) => a + b, 0);
  const rsi14 = g.length >= 14 ? +(dn === 0 ? 100 : 100 - 100 / (1 + up / dn)).toFixed(1) : null;
  const year = c.slice(-252), hi = Math.max(...year), lo = Math.min(...year);
  let rel20: number | null = null;
  if (index && index.length > 20) { const ic = index.map(b => b.close), ir = (ic.at(-1)! / ic[ic.length - 21] - 1) * 100, r = ret(20); if (r !== null) rel20 = +(r - ir).toFixed(2); }
  return { as_of: h[n - 1].date, close: +last.toFixed(2), ret_1d_pct: ret(1), ret_5d_pct: ret(5), ret_20d_pct: ret(20), ret_60d_pct: ret(60),
    vs_ma20_pct: dist(20), vs_ma50_pct: dist(50), vs_ma200_pct: dist(200), daily_vol_20d_pct: vol20, rsi14,
    from_52w_high_pct: +(((last / hi) - 1) * 100).toFixed(2), from_52w_low_pct: +(((last / lo) - 1) * 100).toFixed(2), rel_to_index_20d_pct: rel20,
    last_10_closes: c.slice(-10).map(x => +x.toFixed(2)) };
}

/** Is this address on the public internet? Refuses loopback, private,
 *  link-local, CGNAT and other reserved ranges (IPv4 and IPv6). */
export function publicIp(ip: string) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224);
  }
  const x = ip.toLowerCase();
  if (x.startsWith("::ffff:")) return publicIp(x.slice(7));
  return !(x === "::" || x === "::1" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb") || x.startsWith("ff"));
}

/** The readable text of a public web page, for the research passes. Only
 *  http(s) on public addresses (never your LAN), no redirects to elsewhere,
 *  at most ~1 MB read and 8,000 characters returned. */
export async function readPage(url: string, maxChars = 8000) {
  let u = new URL(String(url));
  for (let hop = 0; hop < 4; hop++) {
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new HttpError(400, "Only plain http(s) pages can be read.");
    const addrs = isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true }).catch(() => []);
    if (!addrs.length || !addrs.every(a => publicIp(a.address))) throw new HttpError(403, `${u.hostname} isn't a public address.`);
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(u, { redirect: "manual", signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 (PonderingOrb research)", Accept: "text/html,text/plain;q=0.9" } });
      if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { u = new URL(r.headers.get("location")!, u); continue; }
      if (!r.ok) throw new HttpError(502, `${u.hostname} answered ${r.status}.`);
      const reader = r.body!.getReader(); let html = "", bytes = 0; const dec = new TextDecoder();
      for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; html += dec.decode(value, { stream: true }); if (bytes > 1_000_000) { ctl.abort(); break; } }
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() || "";
      const text = html.replace(/<(script|style|noscript|svg|nav|footer|header|form)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
      return { url: u.toString(), title, text: text.slice(0, maxChars) };
    } catch (e: any) { if (e instanceof HttpError) throw e; throw new HttpError(502, `Couldn't read ${u.hostname} (${e?.name === "AbortError" ? "timed out" : e?.message}).`); }
    finally { clearTimeout(t); }
  }
  throw new HttpError(502, "Too many redirects.");
}
