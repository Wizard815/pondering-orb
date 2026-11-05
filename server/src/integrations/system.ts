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

/** GET a Docker API path over tcp://host:port (the socket proxy). */
function docker(host: string, path: string): Promise<any> {
  const u = new URL(host.replace(/^tcp:/, "http:"));
  return new Promise((resolve, reject) => {
    const r = request({ host: u.hostname, port: u.port || 2375, path, timeout: 5000 }, res => {
      let b = ""; res.on("data", d => (b += d)); res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    r.on("error", reject); r.on("timeout", () => r.destroy(new Error("timeout"))); r.end();
  });
}
export async function containers(host: string) {
  if (!host) return [];
  const list = await docker(host, "/containers/json?all=1");
  return (list as any[]).map(c => ({ name: (c.Names?.[0] || "").replace(/^\//, ""), state: c.State, status: c.Status, image: c.Image }));
}
