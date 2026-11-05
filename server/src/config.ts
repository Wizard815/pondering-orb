import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";

/** Settings that come from orb.yaml. Secrets never live here: the YAML names
 *  environment variables (`*_env`) and the server reads them at call time. */
export interface OrbConfig {
  port: number;
  logMax: number;
  golem: { baseUrl: string; model: string; keyEnv: string; canWrite: boolean };
  upstream: { baseUrl: string; headerEnv?: string };
  uptime: { baseUrl: string; statusPage: string };
  system: { proc: string; docker: string; disks: string[] };
  caldav: { url: string; userEnv: string; passwordEnv: string; choresList: string };
  wiki: { baseUrl: string; tokenEnv: string; vault: string };
  hermes: { baseUrl: string; userEnv: string; passwordEnv: string };
  allglance: { baseUrl: string; tokenEnv: string };
  pollMinutes: number;
}

const DEFAULTS: OrbConfig = {
  port: 8095,
  logMax: 50,
  golem: { baseUrl: "http://argos:8080/v1", model: "", keyEnv: "", canWrite: true },
  upstream: { baseUrl: "" },
  uptime: { baseUrl: "", statusPage: "orb" },
  system: { proc: "/proc", docker: "", disks: ["/"] },
  caldav: { url: "", userEnv: "CALDAV_USER", passwordEnv: "CALDAV_PASSWORD", choresList: "Chores" },
  wiki: { baseUrl: "http://llmwiki:27123", tokenEnv: "WIKI_API_KEY", vault: "/vault" },
  hermes: { baseUrl: "", userEnv: "HERMES_USER", passwordEnv: "HERMES_PASSWORD" },
  allglance: { baseUrl: "", tokenEnv: "ALLGLANCE_TOKEN" },
  pollMinutes: 15,
};

type Raw = Record<string, any>;
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
function camelize(v: any): any {
  if (Array.isArray(v)) return v.map(camelize);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [camel(k), camelize(x)]));
  return v;
}

/** golem: either flat (base_url, model, key_env, can_write) or
 *  provider: local|frontier with a block for each; can_write applies to both. */
function golemFrom(g: any): OrbConfig["golem"] {
  if (!g || typeof g !== "object") return { ...DEFAULTS.golem };
  const { provider, local, frontier, ...flat } = g;
  const pick = provider === "frontier" ? frontier : local;
  return { ...DEFAULTS.golem, ...flat, ...(pick && typeof pick === "object" ? pick : {}), ...(g.canWrite !== undefined ? { canWrite: g.canWrite !== false } : {}) };
}

export function loadConfig(path = process.env.ORB_CONFIG || "/config/orb.yaml", env = process.env): OrbConfig {
  let raw: Raw = {};
  if (existsSync(path)) raw = camelize(parse(readFileSync(path, "utf8")) || {});
  const c: OrbConfig = {
    ...DEFAULTS, ...raw,
    golem: golemFrom(raw.golem),
    upstream: { ...DEFAULTS.upstream, ...(raw.upstream ?? {}) },
    uptime: { ...DEFAULTS.uptime, ...(raw.uptime ?? {}) },
    system: { ...DEFAULTS.system, ...(raw.system ?? {}) },
    caldav: { ...DEFAULTS.caldav, ...(raw.caldav ?? {}) },
    wiki: { ...DEFAULTS.wiki, ...(raw.wiki ?? {}) },
    hermes: { ...DEFAULTS.hermes, ...(raw.hermes ?? {}) },
    allglance: { ...DEFAULTS.allglance, ...(raw.allglance ?? {}) },
  };
  // Addresses can also come from the environment (docker-compose.example.yml).
  // orb.yaml wins when it sets the same thing, so editing the YAML always works.
  const has = (sec: string, key: string) => raw[sec] && raw[sec][key] !== undefined;
  if (env.PORT && raw.port === undefined) c.port = Number(env.PORT);
  if (env.UPSTREAM_URL && !has("upstream", "baseUrl")) c.upstream.baseUrl = env.UPSTREAM_URL;
  if (env.UPTIME_URL && !has("uptime", "baseUrl")) c.uptime.baseUrl = env.UPTIME_URL;
  if (env.ARGOS_URL && !raw.golem?.baseUrl && !raw.golem?.local?.baseUrl && raw.golem?.provider !== "frontier") c.golem.baseUrl = env.ARGOS_URL.replace(/\/$/, "") + "/v1";
  if (env.WIKI_URL && !has("wiki", "baseUrl")) c.wiki.baseUrl = env.WIKI_URL;
  if (env.HERMES_URL && !has("hermes", "baseUrl")) c.hermes.baseUrl = env.HERMES_URL;
  if (env.ALLGLANCE_URL && !has("allglance", "baseUrl")) c.allglance.baseUrl = env.ALLGLANCE_URL;
  if (env.DOCKER_HOST && !has("system", "docker")) c.system.docker = env.DOCKER_HOST;
  if (env.ORB_PROC && !has("system", "proc")) c.system.proc = env.ORB_PROC;
  return c;
}

/** Env var names a setting may point a key at: plain upper-case names, and
 *  never Orb's own (ORB_PASSWORD, ORB_API_TOKENS ...). */
export const okEnvName = (n: unknown) => typeof n === "string" && /^[A-Z_][A-Z0-9_]{0,63}$/.test(n) && !n.startsWith("ORB_");
export const secret = (name?: string) => (okEnvName(name) ? process.env[name!] || "" : "");
/** Settings from the web app with any unsafe *Env name dropped. */
export function envSafe(o: unknown): Record<string, any> {
  if (!o || typeof o !== "object") return {};
  return Object.fromEntries(Object.entries(o as Record<string, any>).filter(([k, v]) => !/Env$/.test(k) || okEnvName(v))); // an empty name keeps the default
}
