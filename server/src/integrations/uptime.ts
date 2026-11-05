import { call, trimSlash } from "./http.js";
import { HttpError } from "../records.js";

export type Monitor = { id: number; name: string; group: string; status: "up" | "down" | "pending"; uptime24: number | null; ping: number | null; beats: number[] };

/** Uptime Kuma's public status-page API (the page must be published). */
export async function uptime(base: string, slug: string): Promise<{ monitors: Monitor[] }> {
  const b = trimSlash(base);
  if (!b) throw new HttpError(503, "Uptime Kuma isn't set up. Add its address in Settings → Connections.");
  const [page, hb] = await Promise.all([call(`${b}/api/status-page/${encodeURIComponent(slug)}`), call(`${b}/api/status-page/heartbeat/${encodeURIComponent(slug)}`)]);
  if (!page.ok) throw new HttpError(502, `Uptime Kuma has no published status page "${slug}" (answered ${page.status}).`);
  const beats = hb.body?.heartbeatList || {}, up = hb.body?.uptimeList || {};
  const monitors: Monitor[] = [];
  for (const g of page.body?.publicGroupList || []) for (const m of g.monitorList || []) {
    const list: any[] = beats[m.id] || [], last = list[list.length - 1];
    monitors.push({
      id: m.id, name: m.name, group: g.name || "Services",
      status: !last ? "pending" : last.status === 1 ? "up" : last.status === 0 ? "down" : "pending",
      uptime24: up[`${m.id}_24`] != null ? Math.round(up[`${m.id}_24`] * 1000) / 10 : null,
      ping: last?.ping ?? null, beats: list.slice(-40).map(x => (x.status === 1 ? 1 : 0)),
    });
  }
  return { monitors };
}
