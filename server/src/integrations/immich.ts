import { call, trimSlash } from "./http.js";
import { secret } from "../config.js";
import { HttpError } from "../records.js";
import type { WidgetCfg } from "./widgets.js";

/** Immich, the photo library. The widget shows "on this day" (Immich's own
 *  memories, made by its server for that account) and the library's size.
 *  Orb is one person's dashboard, so the key is that person's own Immich
 *  API key (memory.read, asset.view, and server.statistics if they are the
 *  admin). Photos are shown through Orb's server so the key never reaches the
 *  browser, and only photos that account can see come back. */

const ID = /^[0-9a-f-]{36}$/i;

function headers(w: WidgetCfg) {
  const key = secret(w.keyEnv);
  if (!key) throw new HttpError(400, `The Immich widget needs key_env: an API key from Immich (Account settings → API keys)${w.keyEnv ? `, and ${w.keyEnv} is empty` : ""}.`);
  return { "x-api-key": key, Accept: "application/json" };
}

export async function immichWidget(w: WidgetCfg, today = new Date()) {
  const base = trimSlash(w.url); if (!base) throw new HttpError(400, "The Immich widget has no url.");
  const h = headers(w);
  const day = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())).toISOString();
  const [mem, stats] = await Promise.all([
    call(`${base}/api/memories?for=${encodeURIComponent(day)}`, { headers: h }),
    call(`${base}/api/server/statistics`, { headers: h }),
  ]);
  if (mem.status === 401) throw new HttpError(502, `Immich refused the key${w.keyEnv ? ` in ${w.keyEnv}` : ""}. Make a new one in Immich (Account settings → API keys).`);
  if (!mem.ok) throw new HttpError(502, `Immich answered ${mem.status} for memories${mem.body?.message ? `: ${mem.body.message}` : ""}.`);
  const thisYear = today.getFullYear();
  const memories = (Array.isArray(mem.body) ? mem.body : [])
    .map((m: any) => {
      const year = Number(m?.data?.year) || 0;
      const assets = (m?.assets || []).filter((a: any) => ID.test(String(a?.id)));
      return { id: String(m?.id || ""), year, yearsAgo: year ? thisYear - year : null, count: assets.length,
        photos: assets.slice(0, 4).map((a: any) => ({ id: String(a.id), video: a.type === "VIDEO" })) };
    })
    .filter((m: any) => m.count > 0)
    .sort((a: any, b: any) => (b.year || 0) - (a.year || 0));
  // Statistics are for the admin only; anyone else just doesn't get the totals.
  const s = stats.ok ? stats.body : null;
  return {
    type: "immich", link: trimSlash(w.link || w.url),
    memories,
    library: s ? { photos: Number(s.photos) || 0, videos: Number(s.videos) || 0, bytes: Number(s.usage) || 0 } : null,
  };
}

/** One photo's small picture, fetched with the widget's key. */
export async function immichThumb(w: WidgetCfg, id: string): Promise<{ bytes: Buffer; mime: string }> {
  if (!ID.test(id)) throw new HttpError(400, "That isn't a photo id.");
  const base = trimSlash(w.url); if (!base) throw new HttpError(400, "The Immich widget has no url.");
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(`${base}/api/assets/${id}/thumbnail?size=thumbnail`, { headers: { "x-api-key": headers(w)["x-api-key"] }, signal: ctl.signal });
    if (!r.ok) throw new HttpError(r.status === 404 || r.status === 400 ? 404 : 502, r.status === 404 || r.status === 400 ? "That photo isn't there, or this account can't see it." : `Immich answered ${r.status}.`);
    return { bytes: Buffer.from(await r.arrayBuffer()), mime: r.headers.get("content-type") || "image/jpeg" };
  } catch (e: any) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `Couldn't reach Immich (${e?.name === "AbortError" ? "timed out" : e?.cause?.code || e?.message}).`);
  } finally { clearTimeout(t); }
}
