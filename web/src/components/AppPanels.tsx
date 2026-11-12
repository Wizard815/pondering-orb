import type { PanelDef } from "./PanelGrid";
import { useColl } from "../lib/store";
import { parseApps, DEFAULT_APPS, App } from "../lib/apps";
import { isUrl } from "../lib/util";
import { LiveWidget } from "./LiveWidget";

export const AppTiles = ({ apps }: { apps: App[] }) => <div className="apps">{apps.map(a => { const inner = <><span className="rune">{a.rune}</span><span className="grow"><div className="an">{a.name}</div><div className="ad">{a.description}</div></span></>;
  return isUrl(a.url) ? <a key={a.name} className="app" href={a.url} target="_blank" rel="noopener">{inner}</a> : <div key={a.name} className="app">{inner}</div>; })}</div>;

/** One panel per app group and per app from the apps YAML, so any page can
 *  add them in Edit layout. Apps with a live widget (Plex, SABnzbd,
 *  Firefly III, Coinpile, Omi) show it under their link. */
export function useAppPanels(): { panels: PanelDef[]; groups: ReturnType<typeof parseApps>["groups"]; widgetKeys: (type?: string) => string[] } {
  const apps = useColl("settings").find(d => d.id === "apps");
  const { groups } = parseApps(apps?.yaml ?? DEFAULT_APPS);
  const all = groups.flatMap(g => g.apps);
  const big = (t?: string) => t === "omi" || t === "firefly" || t === "coinpile";
  const panels: PanelDef[] = [
    ...groups.map(g => ({ key: "group:" + g.name, title: g.name, node: <AppTiles apps={g.apps} />, w: 6, h: 5 })),
    ...all.map(a => ({ key: "app:" + a.name, title: a.name, node: a.widget ? <><AppTiles apps={[a]} /><LiveWidget name={a.name} /></> : <AppTiles apps={[a]} />,
      w: a.widget ? (big(a.widget.type) ? 6 : 4) : 3, h: a.widget ? (big(a.widget.type) ? 10 : 6) : 3 })),
  ];
  const widgetKeys = (type?: string) => all.filter(a => a.widget && (!type || a.widget.type === type)).map(a => "app:" + a.name);
  return { panels, groups, widgetKeys };
}
