import { useEffect, useState } from "react";
import { get } from "../../lib/api";
import { useSettings } from "../../lib/store";
import { isUrl } from "../../lib/util";

/** The server's effective connection settings (GET /api/config), re-read when
 *  Settings → Connections changes. Used for "Open UpstreamManager / Uptime Kuma". */
export function useOrbConfig() {
  const s = useSettings(), [cfg, setCfg] = useState<any>(null);
  useEffect(() => { get("/api/config").then(setCfg).catch(() => setCfg(null)); }, [JSON.stringify(s.connections || null)]);
  return cfg;
}
/** A base URL without its trailing slash, or "" when it isn't an http(s) URL. */
export const baseOf = (u?: string) => (isUrl(u) ? String(u).replace(/\/+$/, "") : "");
