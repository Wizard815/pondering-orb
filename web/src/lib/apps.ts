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
`;
