import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { lookup } from "node:dns/promises";
import { call, trimSlash } from "./http.js";

/** Where an app on the server is reachable by name, so links don't use an
 *  address that only works for Orb (orb.example.com:8989 fails behind a
 *  reverse proxy). Read only, from:
 *   - Nginx Proxy Manager's API (its proxy hosts),
 *   - nginx or SWAG config files mounted read only (server_name + proxy_pass,
 *     or SWAG's $upstream_app / $upstream_port),
 *   - Technitium DNS (records named after an app that point at the server).
 *  Anything not found there gets the Unraid server's LAN address and port. */

export type Route = { names: string[]; https: boolean; host: string; port: number; via: "npm" | "nginx" };
export type DnsName = { name: string; ip: string };

// ---------------- Nginx Proxy Manager ----------------
let npmToken: { key: string; token: string; until: number } | null = null;
export async function npmRoutes(base: string, email: string, password: string): Promise<Route[]> {
  const b = trimSlash(base); if (!b || !email || !password) return [];
  const key = `${b}|${email}`;
  if (!npmToken || npmToken.key !== key || npmToken.until < Date.now()) {
    const r = await call(`${b}/api/tokens`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identity: email, secret: password }) });
    if (!r.ok || !r.body?.token) throw new Error(`Nginx Proxy Manager refused the sign-in (${r.status}).`);
    npmToken = { key, token: r.body.token, until: Date.now() + 50 * 60000 };
  }
  const r = await call(`${b}/api/nginx/proxy-hosts`, { headers: { Authorization: `Bearer ${npmToken.token}` } });
  if (r.status === 401) { npmToken = null; throw new Error("Nginx Proxy Manager's sign-in expired; it will sign in again next time."); }
  if (!r.ok || !Array.isArray(r.body)) throw new Error(`Nginx Proxy Manager answered ${r.status}.`);
  return r.body.filter((h: any) => h && h.enabled !== false && h.enabled !== 0).map((h: any) => ({
    names: (h.domain_names || []).map(String).filter((n: string) => /^[a-z0-9.-]+$/i.test(n) && !n.startsWith("*")),
    https: !!(h.certificate_id && h.certificate_id !== "0") || !!h.ssl_forced, host: String(h.forward_host || "").toLowerCase(), port: Number(h.forward_port) || 0, via: "npm" as const,
  })).filter((x: Route) => x.names.length && x.host && x.port);
}

// ---------------- nginx / SWAG config files ----------------
/** server blocks from nginx config text. `domain` fills SWAG's "server_name app.*;". */
export function parseNginx(text: string, domain = ""): Route[] {
  const out: Route[] = [];
  const src = text.replace(/#[^\n]*/g, "");
  for (const m of src.matchAll(/\bserver\s*\{/g)) {
    // the block: count braces from here
    let depth = 0, i = m.index! + m[0].length - 1, end = src.length;
    for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) { end = i; break; } }
    const block = src.slice(m.index!, end);
    const names = (/\bserver_name\s+([^;]+);/.exec(block)?.[1] || "").split(/\s+/).map(n => n.trim().toLowerCase())
      .map(n => (n.endsWith(".*") && domain ? n.slice(0, -1) + domain.replace(/^\./, "") : n)).filter(n => /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(n));
    if (!names.length) continue;
    const https = /\blisten\s+[^;]*\b443\b[^;]*;/.test(block) || /\blisten\s+[^;]*\bssl\b/.test(block);
    const set = (k: string) => (new RegExp(`\\bset\\s+\\$${k}\\s+([^;\\s]+)\\s*;`).exec(block)?.[1] || "").replace(/^["']|["']$/g, "");
    let host = "", port = 0;
    const pp = /\bproxy_pass\s+([^;]+);/.exec(block)?.[1]?.trim() || "";
    const direct = /^https?:\/\/([^/:$]+):(\d+)/.exec(pp);
    if (direct) { host = direct[1]; port = Number(direct[2]); }
    else if (set("upstream_app")) { host = set("upstream_app"); port = Number(set("upstream_port")) || 0; }
    // Nginx Proxy Manager: set $server "app"; set $port 1234; (proxy_pass sits in an include)
    else if (set("server")) { host = set("server"); port = Number(set("port")) || 0; }
    if (host && port) out.push({ names, https, host: host.toLowerCase(), port, via: "nginx" });
  }
  return out;
}
export async function nginxRoutes(dir: string, domain = ""): Promise<Route[]> {
  if (!dir) return [];
  try { if (!(await stat(dir)).isDirectory()) return []; } catch { return []; }
  const out: Route[] = []; let files = 0;
  const walk = async (d: string, depth: number) => {
    if (depth > 4 || files > 400) return;
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (/\.conf$/.test(e.name) && !/\.sample$/.test(e.name)) { files++; out.push(...parseNginx(await readFile(p, "utf8").catch(() => ""), domain)); }
    }
  };
  await walk(dir, 0);
  return out;
}

// ---------------- Technitium DNS ----------------
export async function technitiumNames(base: string, token: string): Promise<DnsName[]> {
  const b = trimSlash(base); if (!b || !token) return [];
  const q = (p: string) => call(`${b}${p}${p.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`);
  const z = await q("/api/zones/list");
  if (!z.ok || z.body?.status !== "ok") throw new Error(`Technitium DNS answered ${z.status}${z.body?.errorMessage ? `: ${z.body.errorMessage}` : ""}.`);
  const zones = (z.body.response?.zones || []).filter((x: any) => !x.disabled && x.type === "Primary" && !/\.(in-addr|ip6)\.arpa$/i.test(x.name)).slice(0, 30);
  const out: DnsName[] = [];
  for (const zone of zones) {
    const r = await q(`/api/zones/records/get?domain=${encodeURIComponent(zone.name)}&zone=${encodeURIComponent(zone.name)}&listZone=true`).catch(() => null);
    for (const rec of r?.body?.response?.records || []) if (!rec.disabled && rec.type === "A" && rec.rData?.ipAddress) out.push({ name: String(rec.name).toLowerCase(), ip: String(rec.rData.ipAddress) });
  }
  return out;
}

// ---------------- the server's own address ----------------
const isIp = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
/** The Unraid server's LAN address: the setting, else the Unraid agent's host (looked up if it is a name), else the agent's network answer. */
export async function serverAddress(setting: string, agentBase: string, agentNetwork?: () => Promise<string>): Promise<{ host: string; how: string }> {
  if (setting.trim()) { const v = setting.trim(); try { return { host: new URL(/^https?:\/\//i.test(v) ? v : `http://${v}`).hostname, how: "setting" }; } catch { return { host: "", how: "" }; } }
  let h = ""; try { h = agentBase ? new URL(agentBase).hostname : ""; } catch { /* no agent */ }
  if (h && isIp(h)) return { host: h, how: "the Unraid agent's address" };
  if (h) { try { const a = await lookup(h, { family: 4 }); if (a.address) return { host: a.address, how: `${h} looked up` }; } catch { /* not resolvable here */ } }
  if (agentNetwork) { const ip = await agentNetwork().catch(() => ""); if (isIp(ip)) return { host: ip, how: "the Unraid agent's network" }; }
  return { host: h, how: h ? "the Unraid agent's name" : "" };
}
