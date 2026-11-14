import { call, trimSlash } from "./http.js";
import { HttpError } from "../records.js";
import { docker } from "./system.js";

/** The Unraid Management Agent plugin (REST on port 8043, a bearer token):
 *  read only here. Orb lists the server's containers with their state and
 *  port mappings from it. Unraid keeps each container's WebUI address and
 *  icon as Docker labels (net.unraid.docker.webui / .icon), which the agent
 *  doesn't pass on, so those come from the read-only Docker socket proxy when
 *  Orb has one. Either source alone is enough for the Links page. */

export type Port = { private: number; public: number; type: string };
export type AppSource = {
  key: string; name: string; source: "unraid" | "docker"; state: string; image: string;
  ports: Port[]; networkMode: string; ip: string;
  /** Unraid's WebUI template, e.g. "http://[IP]:[PORT:8080]/" (resolved in the browser). */
  webui: string; icon: string; updateAvailable: boolean;
};

async function agent(base: string, token: string, path: string) {
  const b = trimSlash(base); if (!b) throw new HttpError(503, "The Unraid Management Agent isn't set up. Add its address in Settings → Connections.");
  const r = await call(`${b}/api/v1${path}`, { headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  if (r.status === 401 || r.status === 403) throw new HttpError(502, "The Unraid Management Agent refused the token (set its API token, and the same value in Orb's token variable).");
  if (!r.ok) throw new HttpError(502, `The Unraid Management Agent answered ${r.status}.`);
  return r.body;
}
/** The agent wraps some answers ({data: [...]}) and not others. */
const listOf = (b: any): any[] => (Array.isArray(b) ? b : Array.isArray(b?.data) ? b.data : Array.isArray(b?.containers) ? b.containers : []);

export async function unraidSystem(base: string, token: string) {
  const s = await agent(base, token, "/system"), d = s?.data && !Array.isArray(s.data) ? s.data : s;
  return { hostname: String(d?.hostname || ""), version: String(d?.version || ""), agentVersion: String(d?.agent_version || "") };
}
export async function unraidContainers(base: string, token: string): Promise<AppSource[]> {
  return listOf(await agent(base, token, "/docker")).map((c: any) => ({
    key: `ct:${c.name}`, name: String(c.name || ""), source: "unraid" as const, state: String(c.state || ""), image: String(c.image || ""),
    ports: (Array.isArray(c.ports) ? c.ports : []).map((p: any) => ({ private: Number(p.private_port) || 0, public: Number(p.public_port) || 0, type: String(p.type || "tcp") })).filter((p: Port) => p.private),
    networkMode: String(c.network_mode || ""), ip: String(c.ip_address || ""), webui: "", icon: "", updateAvailable: c.update_available === true,
  })).filter((c: AppSource) => c.name);
}
export async function dockerApps(host: string): Promise<AppSource[]> {
  if (!host) return [];
  return ((await docker(host, "/containers/json?all=1")) as any[]).map(c => {
    const l = c.Labels || {}, nets = c.NetworkSettings?.Networks || {};
    return { key: `ct:${(c.Names?.[0] || "").replace(/^\//, "")}`, name: (c.Names?.[0] || "").replace(/^\//, ""), source: "docker" as const, state: String(c.State || ""), image: String(c.Image || ""),
      ports: (c.Ports || []).map((p: any) => ({ private: Number(p.PrivatePort) || 0, public: Number(p.PublicPort) || 0, type: String(p.Type || "tcp") }))
        .filter((p: Port, i: number, a: Port[]) => p.private && a.findIndex(q => q.private === p.private && q.public === p.public && q.type === p.type) === i), // IPv4 and IPv6 bindings repeat
      networkMode: String(c.HostConfig?.NetworkMode || ""), ip: String((Object.values(nets)[0] as any)?.IPAddress || ""),
      webui: String(l["net.unraid.docker.webui"] || ""), icon: /^https?:\/\//.test(String(l["net.unraid.docker.icon"] || "")) ? String(l["net.unraid.docker.icon"]) : "", updateAvailable: false };
  }).filter(c => c.name);
}

/** The server's containers, from the agent and Docker together (labels from Docker, the rest from the agent). */
export async function serverApps(o: { base: string; token: string; dockerHost: string }) {
  const notes: string[] = [];
  const [ag, dk] = await Promise.all([
    o.base ? unraidContainers(o.base, o.token).catch(e => { notes.push(`Unraid agent: ${e.message}`); return null; }) : Promise.resolve(null),
    o.dockerHost ? dockerApps(o.dockerHost).catch(e => { notes.push(`Docker: ${e.message}`); return null; }) : Promise.resolve(null),
  ]);
  const byName = new Map((dk || []).map(c => [c.name, c]));
  const apps = ag ? ag.map(c => { const d = byName.get(c.name); return d ? { ...c, webui: d.webui, icon: d.icon, ports: c.ports.length ? c.ports : d.ports, networkMode: c.networkMode || d.networkMode } : c; }) : dk || [];
  return { apps: apps.sort((a, b) => a.name.localeCompare(b.name)), notes, sources: { unraid: !!ag, docker: !!dk } };
}

/** The address links use: set in Settings, else the agent's host. Empty means "the host this page was opened from". */
export function linkHost(linkHostSetting: string, base: string) {
  if (linkHostSetting) { const v = linkHostSetting.trim(); try { return new URL(/^https?:\/\//i.test(v) ? v : `http://${v}`).hostname; } catch { return ""; } }
  try { return base ? new URL(base).hostname : ""; } catch { return ""; }
}

/** The WebUI template resolved: [IP] is the host, [PORT:n] the host port mapped to n. */
export function resolveWebui(t: string, host: string, ports: Port[]) {
  if (!t || !host) return "";
  return t.replace(/\[IP\]/gi, host).replace(/\[PORT:(\d+)\]/gi, (_, n) => String(ports.find(p => p.private === Number(n) && p.public)?.public || n));
}
/** Where an app answers on the LAN: its WebUI, else its first TCP host port (or, on the host network, its first port). */
export function appUrl(a: AppSource, host: string) {
  const w = resolveWebui(a.webui, host, a.ports); if (/^https?:\/\//i.test(w)) return w; // a label could say javascript:

  if (!host) return "";
  const p = a.ports.find(x => x.type === "tcp" && x.public) || (a.networkMode === "host" ? a.ports.find(x => x.type === "tcp") : undefined);
  return p ? `http://${host}:${p.public || p.private}` : "";
}

/** Orb connections that are empty, matched to containers by name. */
const KNOWN: { conn: string; field: string; label: string; name: RegExp; port?: number; suffix?: string }[] = [
  { conn: "allglance", field: "baseUrl", label: "ALLGlance gateway", name: /allglance|glance[-_]?gateway/i },
  { conn: "upstream", field: "baseUrl", label: "UpstreamManager", name: /upstream[-_]?manager/i },
  { conn: "uptime", field: "baseUrl", label: "Uptime Kuma", name: /uptime[-_]?kuma|^kuma$/i, port: 3001 },
  { conn: "hermes", field: "baseUrl", label: "Hermes Studio", name: /hermes[-_]?studio/i },
  { conn: "wiki", field: "baseUrl", label: "LLMWIKI (Obsidian REST)", name: /obsidian|llmwiki/i, port: 27123 },
  { conn: "golem", field: "baseUrl", label: "Golem's model (Argos)", name: /^argos|llama[-_.]?(server|cpp)|ollama/i, suffix: "/v1" },
];
export function suggestions(apps: AppSource[], host: string, current: (conn: string, field: string) => string) {
  const out: { conn: string; field: string; label: string; container: string; url: string; running: boolean }[] = [];
  for (const k of KNOWN) {
    if (current(k.conn, k.field)) continue;
    const c = apps.filter(a => k.name.test(a.name)).sort((a, b) => Number(b.state === "running") - Number(a.state === "running"))[0]; if (!c) continue;
    const p = k.port ? c.ports.find(x => x.private === k.port) : undefined;
    const url = p && host ? `http://${host}:${p.public || p.private}` : appUrl(c, host);
    if (url) out.push({ conn: k.conn, field: k.field, label: k.label, container: c.name, url: url.replace(/\/$/, "") + (k.suffix || ""), running: c.state === "running" });
  }
  return out;
}
