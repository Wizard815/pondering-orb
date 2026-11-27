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
  # Live panels: give an app a widget (plex, sabnzbd, sonarr, radarr, tautulli, seerr, firefly, coinpile, omi
  # or immich) and the name of the
  # environment variable that holds its key on the Orb server.
  # - name: Media
  #   apps:
  #     - name: Plex
  #       url: http://plex:32400/web
  #       widget: { type: plex, url: http://plex:32400, key_env: PLEX_TOKEN }
  #     - name: SABnzbd
  #       url: http://sabnzbd:8085
  #       widget: { type: sabnzbd, url: http://sabnzbd:8085, key_env: SABNZBD_API_KEY }
  # Sonarr and Radarr: the next 7 days and the queue. Tautulli: who's watching, recent plays.
  # Seerr (Jellyseerr or Overseerr): requests waiting and the last five. Keys: each app's
  # Settings → General → API Key (Tautulli: Settings → Web Interface → API Key).
  #     - name: Sonarr
  #       url: http://192.168.20.5:8200
  #       widget: { type: sonarr, url: http://sonarr:8989, key_env: SONARR_API_KEY }
  #     - name: Radarr
  #       url: http://192.168.20.5:8201
  #       widget: { type: radarr, url: http://radarr:7878, key_env: RADARR_API_KEY }
  #     - name: Tautulli
  #       url: http://192.168.20.5:8210
  #       widget: { type: tautulli, url: http://tautulli:8181, key_env: TAUTULLI_API_KEY }
  #     - name: Seerr
  #       url: http://192.168.20.5:5055
  #       widget: { type: seerr, url: http://seerr:5055, key_env: SEERR_API_KEY }
  # Photos: "on this day" from Immich, with your own Immich API key (memory.read, asset.view;
  # server.statistics too if you're Immich's admin, for the library size):
  # - name: Photos
  #   apps:
  #     - name: Immich
  #       url: http://192.168.20.5:8407
  #       widget: { type: immich, url: http://immich:2283, key_env: IMMICH_API_KEY }
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
