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

export function loadConfig(path = process.env.ORB_CONFIG || "/config/orb.yaml", env = process.env): OrbConfig {
  let raw: Raw = {};
  if (existsSync(path)) raw = camelize(parse(readFileSync(path, "utf8")) || {});
  const c: OrbConfig = {
    ...DEFAULTS, ...raw,
    golem: { ...DEFAULTS.golem, ...(raw.golem?.local ?? raw.golem ?? {}) },
    upstream: { ...DEFAULTS.upstream, ...(raw.upstream ?? {}) },
    uptime: { ...DEFAULTS.uptime, ...(raw.uptime ?? {}) },
    system: { ...DEFAULTS.system, ...(raw.system ?? {}) },
    caldav: { ...DEFAULTS.caldav, ...(raw.caldav ?? {}) },
    wiki: { ...DEFAULTS.wiki, ...(raw.wiki ?? {}) },
    hermes: { ...DEFAULTS.hermes, ...(raw.hermes ?? {}) },
    allglance: { ...DEFAULTS.allglance, ...(raw.allglance ?? {}) },
  };
  // Addresses can also come from the environment (docker-compose.example.yml).
  if (env.PORT) c.port = Number(env.PORT);
  if (env.UPSTREAM_URL) c.upstream.baseUrl = env.UPSTREAM_URL;
  if (env.UPTIME_URL) c.uptime.baseUrl = env.UPTIME_URL;
  if (env.ARGOS_URL && !raw.golem) c.golem.baseUrl = env.ARGOS_URL.replace(/\/$/, "") + "/v1";
  if (env.WIKI_URL) c.wiki.baseUrl = env.WIKI_URL;
  if (env.HERMES_URL) c.hermes.baseUrl = env.HERMES_URL;
  if (env.ALLGLANCE_URL) c.allglance.baseUrl = env.ALLGLANCE_URL;
  if (env.DOCKER_HOST) c.system.docker = env.DOCKER_HOST;
  if (env.ORB_PROC) c.system.proc = env.ORB_PROC;
  return c;
}

export const secret = (name?: string) => (name ? process.env[name] || "" : "");
