import { parse } from "yaml";
/** The apps list (Settings → Apps), stored as YAML text in settings/apps. */
export type App = { name: string; url: string; description: string; rune: string; links: { label: string; url: string }[]; widget?: { type: string } | null };
export type Group = { name: string; apps: App[] };
export function parseApps(text: string): { groups: Group[]; error: string } {
  try {
    const c: any = parse(text || "") || {};
    const groups: Group[] = (Array.isArray(c.groups) ? c.groups : []).map((g: any) => ({ name: String(g?.name || "Apps"),
      apps: (Array.isArray(g?.apps) ? g.apps : []).filter((a: any) => a && a.name).map((a: any) => ({ name: String(a.name), url: String(a.url || ""), description: String(a.description || ""),
        rune: String(a.rune || a.name[0] || "?").slice(0, 2), links: Array.isArray(a.links) ? a.links : [], widget: a.widget && typeof a.widget === "object" ? a.widget : null })) }));
    return { groups, error: "" };
  } catch (e: any) { return { groups: [], error: e.message }; }
}
export const DEFAULT_APPS = `# Pondering Orb apps. Every app and every group can be its own panel on Main.
groups:
  - name: The Tower
    apps:
      - name: Argos
        rune: Ar
        url: http://argos:8080
        description: Local models on /v1, GPU scheduler
      - name: UpstreamManager
        rune: Up
        url: http://upstream-manager:5000
        description: Upstreams, branches, approval requests
  # Live panels: give an app a widget (plex, sabnzbd, firefly, coinpile or omi) and the name of the
  # environment variable that holds its key on the Orb server.
  # - name: Media
  #   apps:
  #     - name: Plex
  #       url: http://plex:32400/web
  #       widget: { type: plex, url: http://plex:32400, key_env: PLEX_TOKEN }
  #     - name: SABnzbd
  #       url: http://sabnzbd:8085
  #       widget: { type: sabnzbd, url: http://sabnzbd:8085, key_env: SABNZBD_API_KEY }
  # Your own apps, read only (add page: true for a full tab):
  # - name: Household
  #   apps:
  #     - name: Firefly III
  #       url: http://firefly:8080
  #       widget: { type: firefly, key_env: FIREFLY_TOKEN, page: true }   # a Personal Access Token
  #     - name: Coinpile
  #       url: http://coinpile:8000
  #       widget: { type: coinpile, key_env: COINPILE_TOKEN }               # a token with the "orb" scope
  #     - name: Omi
  #       url: http://192.168.20.5:8000
  #       widget: { type: omi, key_env: OMI_DEV_KEY }             # an omi_dev_ key with read scopes
`;
