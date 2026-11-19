import { io, type Socket } from "socket.io-client";
import { trimSlash } from "./http.js";

/** Writes to Uptime Kuma through its Socket.IO API, the one its own web page
 *  uses (Kuma 1.23 has no REST API for monitors). Needs an admin login. */

export const ORB_MARK = "Added by Pondering Orb (Settings → Scripts).";
export type Site = { name: string; url: string };
export type KumaSyncResult = { added: string[]; paused: string[]; resumed: string[]; kept: number; onPage: number };

const norm = (u: string) => u.trim().toLowerCase().replace(/\/+$/, "");

/** One address per proxied name: https when the proxy serves it over TLS. Skips names that match `skip`. */
export function sitesFrom(routes: { names: string[]; https: boolean }[], skip: string[] = []): Site[] {
  const out = new Map<string, Site>(), bad = skip.map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const r of routes) for (const n of r.names) {
    const host = n.toLowerCase();
    if (host.startsWith("*") || bad.some(b => host === b || host.includes(b))) continue;
    const url = `${r.https ? "https" : "http"}://${host}/`;
    if (!out.has(norm(url))) out.set(norm(url), { name: host, url });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** What a sync would do, without Kuma: which sites need a monitor, which Orb-made monitors are gone or back. */
export function plan(sites: Site[], monitors: { id: number; name?: string; url?: string; description?: string | null; active: boolean | number }[]) {
  const want = new Set(sites.map(s => norm(s.url))), have = new Set(monitors.map(m => norm(m.url || "")));
  const ours = monitors.filter(m => m.description === ORB_MARK);
  return {
    add: sites.filter(s => !have.has(norm(s.url))),
    pause: ours.filter(m => !!m.active && !want.has(norm(m.url || ""))),
    resume: ours.filter(m => !m.active && want.has(norm(m.url || ""))),
    kept: monitors.filter(m => want.has(norm(m.url || ""))).length,
  };
}

function connect(base: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(trimSlash(base), { transports: ["websocket"], reconnection: false, timeout: 10000 });
    s.once("connect", () => resolve(s));
    s.once("connect_error", e => { s.close(); reject(new Error(`Couldn't reach Uptime Kuma (${e.message}).`)); });
  });
}
const ask = (s: Socket, ev: string, ...args: unknown[]): Promise<any> => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`Uptime Kuma didn't answer ${ev}.`)), 20000);
  s.emit(ev, ...args, (r: any) => { clearTimeout(t); resolve(r); });
});

export async function syncKuma(o: { base: string; user: string; password: string; slug: string; sites: Site[]; interval?: number }): Promise<KumaSyncResult> {
  if (!o.base) throw new Error("Uptime Kuma isn't set up. Add its address in Settings → Connections.");
  if (!o.user || !o.password) throw new Error("Set UPTIME_KUMA_USER and UPTIME_KUMA_PASSWORD (an Uptime Kuma admin login) in .env.");
  const s = await connect(o.base);
  try {
    // Kuma sends the monitor list right after a successful login.
    const list = new Promise<Record<string, any>>((resolve, reject) => { const t = setTimeout(() => reject(new Error("Uptime Kuma sent no monitor list.")), 20000); s.once("monitorList", (m: any) => { clearTimeout(t); resolve(m || {}); }); });
    const login = await ask(s, "login", { username: o.user, password: o.password, token: "" });
    if (!login?.ok) throw new Error(login?.msg === "authIncorrectCreds" || /incorrect/i.test(login?.msg || "") ? "Uptime Kuma refused the login in UPTIME_KUMA_USER / UPTIME_KUMA_PASSWORD." : `Uptime Kuma login failed: ${login?.msg || "no answer"}.`);
    const monitors = Object.values(await list).map((m: any) => ({ ...m, id: Number(m.id) }));
    const p = plan(o.sites, monitors), added: { id: number; name: string }[] = [];
    for (const site of p.add) {
      const r = await ask(s, "add", {
        type: "http", name: site.name, url: site.url, method: "GET", description: ORB_MARK,
        interval: o.interval || 60, retryInterval: o.interval || 60, resendInterval: 0, maxretries: 2, timeout: 48,
        accepted_statuscodes: ["200-299", "300-399", "401", "403"], maxredirects: 10, ignoreTls: false, upsideDown: false, expiryNotification: false,
        notificationIDList: {}, kafkaProducerBrokers: [], kafkaProducerSaslOptions: { mechanism: "None" }, httpBodyEncoding: "json", active: true,
      });
      if (!r?.ok) throw new Error(`Uptime Kuma wouldn't add ${site.name}: ${r?.msg || "no answer"}.`);
      added.push({ id: Number(r.monitorID), name: site.name });
    }
    for (const m of p.pause) await ask(s, "pauseMonitor", m.id);
    for (const m of p.resume) await ask(s, "resumeMonitor", m.id);
    // Put new monitors on Orb's status page (made if missing), keeping its other groups and settings.
    let onPage = 0;
    let page = await ask(s, "getStatusPage", o.slug);
    if (!page?.ok) { const r = await ask(s, "addStatusPage", "Orb", o.slug); if (!r?.ok) throw new Error(`Couldn't make status page "${o.slug}": ${r?.msg}`); page = await ask(s, "getStatusPage", o.slug); }
    const pub = await fetch(`${trimSlash(o.base)}/api/status-page/${encodeURIComponent(o.slug)}`, { signal: AbortSignal.timeout(15000) }).then(r => (r.ok ? r.json() : null)).catch(() => null) as any;
    const groups: any[] = (pub?.publicGroupList || []).map((g: any) => ({ ...g, monitorList: (g.monitorList || []).map((m: any) => ({ id: m.id })) }));
    const shown = new Set(groups.flatMap(g => g.monitorList.map((m: any) => Number(m.id))));
    const missing = [...added.map(a => a.id), ...monitors.filter(m => m.description === ORB_MARK).map(m => m.id)].filter(id => !shown.has(id));
    if (missing.length) {
      if (!groups.length) groups.push({ name: "Sites", monitorList: [] });
      groups[0].monitorList.push(...missing.map(id => ({ id })));
      const cfg = { domainNameList: [], ...page.config, slug: o.slug };
      const r = await ask(s, "saveStatusPage", o.slug, cfg, cfg.icon || "/icon.svg", groups);
      if (!r?.ok) throw new Error(`Couldn't update status page "${o.slug}": ${r?.msg}`);
      onPage = missing.length;
    }
    return { added: added.map(a => a.name), paused: p.pause.map(m => m.name || m.url || `#${m.id}`), resumed: p.resume.map(m => m.name || m.url || `#${m.id}`), kept: p.kept, onPage };
  } finally { s.close(); }
}
