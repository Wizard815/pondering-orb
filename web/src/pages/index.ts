import { useMemo } from "react";
import type { PageDef } from "./types";
import { useColl, useSettings } from "../lib/store";
import { useOrbConfig } from "./upkeep/config";
import { parseApps, DEFAULT_APPS } from "../lib/apps";
import { omiPage } from "./Companions";
import { fireflyPage } from "./Finances";
import { coinpilePage } from "./Coinpile";
import { MainPage } from "./Main";
import { ProjectsPage } from "./Projects";
import { IdeasPage } from "./Ideas";
import { TodoPage } from "./Todo";
import { WikiPage } from "./Wiki";
import { CalendarPage } from "./Calendar";
import { UpkeepPage } from "./Upkeep";
import { UptimePage } from "./Uptime";
import { SystemPage } from "./System";
import { SettingsPage } from "./Settings";
import { DailyPage } from "./Daily";
import { PicksPage } from "./Picks";
import { AgentsPage } from "./Agents";

/** Tabs, in order. */
export const PAGES: PageDef[] = [MainPage, DailyPage, ProjectsPage, AgentsPage, IdeasPage, TodoPage, WikiPage, CalendarPage, PicksPage, UpkeepPage, UptimePage, SystemPage, SettingsPage];

/** Pages that only make sense with an app behind them. A page whose app
 *  isn't set up stays out of the tabs unless Settings → Pages says "Show". */
export type PageMode = "auto" | "show" | "hide";
const ALWAYS = new Set(["main", "config"]); // can't be hidden: Settings is how you show them again
/** Whether each page has what it needs: true, false, or undefined while unknown. */
export function usePageSetup(): Record<string, boolean | undefined> {
  const cfg = useOrbConfig(), s = useSettings(), chores = useColl("chores"), picks = useColl("picks"), research = useColl("research");
  const known = (v: boolean) => (cfg ? v : undefined);
  return {
    agents: known(!!cfg?.hermes?.baseUrl),
    wiki: known(!!cfg?.wiki?.mount || (!!cfg?.wiki?.baseUrl && !!cfg?.wiki?.keySet)),
    upkeep: cfg?.upstream?.baseUrl || chores.length ? true : known(false),
    uptime: known(!!cfg?.uptime?.baseUrl),
    picks: s.market?.on || picks.length || research.length ? true : known(false),
  };
}
export const pageMode = (s: Record<string, any>, id: string): PageMode => (ALWAYS.has(id) ? "show" : (["show", "hide"].includes(s.pages?.[id]) ? s.pages[id] : "auto"));

/** Full pages for apps whose widget says `page: true` (or a tab name):
 *  Firefly III, Coinpile and Omi. They sit after Picks. */
let current: PageDef[] = PAGES;
/** Every page, shown or not (Settings → Pages lists these). */
export function useAllPages(): PageDef[] {
  const yaml = useColl("settings").find(d => d.id === "apps")?.yaml as string | undefined;
  return useMemo(() => {
    const extra: PageDef[] = [], used = new Set<string>();
    for (const a of parseApps(yaml ?? DEFAULT_APPS).groups.flatMap(g => g.apps)) {
      const w: any = a.widget, label = w?.page === true ? "" : typeof w?.page === "string" ? w.page.trim().slice(0, 24) : null;
      if (label === null || !w) continue;
      const def = w.type === "firefly" ? fireflyPage(a, label || "Money") : w.type === "coinpile" ? coinpilePage(a, label || "Coinpile") : w.type === "omi" ? omiPage(a, label || "Omi") : null;
      if (def && !used.has(def.id)) { used.add(def.id); extra.push(def); }
    }
    const at = PAGES.indexOf(PicksPage) + 1;
    return [...PAGES.slice(0, at), ...extra, ...PAGES.slice(at)];
  }, [yaml]);
}
/** The tabs: every page that is set up (or that Settings → Pages shows). */
export function usePages(): PageDef[] {
  const all = useAllPages(), setup = usePageSetup(), s = useSettings();
  return useMemo(() => {
    current = all.filter(p => { const m = pageMode(s, p.id); return m === "show" || (m === "auto" && setup[p.id] !== false && !(p.id in setup && setup[p.id] === undefined)); });
    return current;
  }, [all, JSON.stringify(setup), JSON.stringify(s.pages || {})]);
}
export const pageById = (id: string) => current.find(p => p.id === id);
