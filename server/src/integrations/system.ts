import { readFile, statfs } from "node:fs/promises";
import { request } from "node:http";

/** Host stats from /proc (mount the host's /proc read-only, see the compose
 *  file) and containers from the Docker API through a read-only proxy. */
async function cpuTimes(proc: string) {
  const lines = (await readFile(`${proc}/stat`, "utf8")).split("\n").filter(l => /^cpu\d+ /.test(l));
  return lines.map(l => { const n = l.trim().split(/\s+/).slice(1).map(Number); const idle = n[3] + (n[4] || 0); return { idle, total: n.reduce((a, b) => a + b, 0) }; });
}
let last: { idle: number; total: number }[] | null = null;
const history: number[] = [];

export async function hostStats(proc: string, disks: string[]) {
  const now = await cpuTimes(proc);
  const prev = last || now.map(c => ({ idle: 0, total: 0 }));
  last = now;
  const cores = now.map((c, i) => { const dt = c.total - prev[i].total, di = c.idle - prev[i].idle; return dt > 0 ? Math.round((1 - di / dt) * 100) : 0; });
  const cpu = cores.length ? Math.round(cores.reduce((a, b) => a + b, 0) / cores.length) : 0;
  history.push(cpu); if (history.length > 60) history.shift();
  const mi = Object.fromEntries((await readFile(`${proc}/meminfo`, "utf8")).split("\n").filter(Boolean).map(l => { const [k, v] = l.split(":"); return [k, parseInt(v) || 0]; }));
  const mem = mi.MemTotal ? Math.round((1 - (mi.MemAvailable ?? mi.MemFree) / mi.MemTotal) * 100) : 0;
  const up = Number((await readFile(`${proc}/uptime`, "utf8")).split(" ")[0]) || 0;
  const diskInfo = [];
  for (const m of disks) { try { const s = await statfs(m); diskInfo.push({ mount: m, pct: Math.round((1 - s.bavail / s.blocks) * 100) }); } catch { /* not mounted */ } }
  return { cpu, cores, cpuHistory: [...history], mem, memTotalGiB: Math.round(mi.MemTotal / 1048576), disks: diskInfo, uptimeDays: Math.floor(up / 86400) };
}

/** GET a Docker API path over tcp://host:port (the socket proxy) or a
 *  unix:// socket. */
export function docker(host: string, path: string): Promise<any> {
  const where = host.startsWith("unix://") ? { socketPath: host.slice(7) } : (() => { const u = new URL(host.replace(/^tcp:/, "http:")); return { host: u.hostname, port: u.port || 2375 }; })();
  return new Promise((resolve, reject) => {
    const r = request({ ...where, path, timeout: 5000 }, res => {
      let b = ""; res.on("data", d => (b += d)); res.on("error", reject); res.on("aborted", () => reject(new Error("Docker closed the connection")));
      res.on("end", () => {
        if ((res.statusCode || 0) >= 300) return reject(new Error(`Docker answered ${res.statusCode}${res.statusCode === 403 ? " (the socket proxy doesn't allow this)" : ""}`));
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    });
    r.on("error", reject); r.on("timeout", () => r.destroy(new Error("timeout"))); r.end();
  });
}
export async function containers(host: string) {
  if (!host) return [];
  const list = (await docker(host, "/containers/json?all=1")) as any[];
  // One stats snapshot per running container (one-shot, no streaming), 8 at a time.
  const out = list.map(c => ({ id: c.Id as string, name: (c.Names?.[0] || "").replace(/^\//, ""), state: c.State, status: c.Status, image: c.Image, cpu: null as number | null, memMiB: null as number | null, memPct: null as number | null }));
  const running = out.filter(c => c.state === "running");
  for (let i = 0; i < running.length; i += 8) {
    await Promise.all(running.slice(i, i + 8).map(async c => {
      try { Object.assign(c, statsOf(await docker(host, `/containers/${c.id}/stats?stream=false&one-shot=false`))); } catch { /* stats not allowed or container gone */ }
    }));
  }
  return out.map(({ id: _id, ...c }) => c).sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1));
}
/** docker stats arithmetic: CPU % of the whole host, memory without page cache. */
export function statsOf(s: any) {
  const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
  const cpus = s.cpu_stats?.online_cpus || s.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  const cpu = sysDelta > 0 && cpuDelta >= 0 ? Math.round((cpuDelta / sysDelta) * cpus * 1000) / 10 : 0;
  const m = s.memory_stats || {}, cache = m.stats?.inactive_file ?? m.stats?.total_inactive_file ?? m.stats?.cache ?? 0;
  const used = Math.max(0, (m.usage ?? 0) - cache);
  return { cpu, memMiB: Math.round(used / 1048576), memPct: m.limit ? Math.round((used / m.limit) * 1000) / 10 : null };
}
