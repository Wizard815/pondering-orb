import type { PageDef } from "./types";
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

/** Tabs, in order. */
export const PAGES: PageDef[] = [MainPage, DailyPage, ProjectsPage, IdeasPage, TodoPage, WikiPage, CalendarPage, PicksPage, UpkeepPage, UptimePage, SystemPage, SettingsPage];
export const pageById = (id: string) => PAGES.find(p => p.id === id);
