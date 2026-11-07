import { useMemo } from "react";
import type { PageDef } from "./types";
import { useColl } from "../lib/store";
import { parseApps, DEFAULT_APPS } from "../lib/apps";
import { moneyPage, omiPage } from "./Companions";
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

/** Full pages for apps whose widget says `page: true` (or a tab name):
 *  Goblin-Bank and Omi. They sit after Picks. */
let current: PageDef[] = PAGES;
export function usePages(): PageDef[] {
  const yaml = useColl("settings").find(d => d.id === "apps")?.yaml as string | undefined;
  return useMemo(() => {
    const extra: PageDef[] = [], used = new Set<string>();
    for (const a of parseApps(yaml ?? DEFAULT_APPS).groups.flatMap(g => g.apps)) {
      const w: any = a.widget, label = w?.page === true ? "" : typeof w?.page === "string" ? w.page.trim().slice(0, 24) : null;
      if (label === null || !w) continue;
      const def = w.type === "goblinbank" ? moneyPage(a, label || "Money") : w.type === "omi" ? omiPage(a, label || "Omi") : null;
      if (def && !used.has(def.id)) { used.add(def.id); extra.push(def); }
    }
    const at = PAGES.indexOf(PicksPage) + 1;
    current = [...PAGES.slice(0, at), ...extra, ...PAGES.slice(at)];
    return current;
  }, [yaml]);
}
export const pageById = (id: string) => current.find(p => p.id === id);
