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

/** Tabs, in order. */
export const PAGES: PageDef[] = [MainPage, ProjectsPage, IdeasPage, TodoPage, WikiPage, CalendarPage, UpkeepPage, UptimePage, SystemPage, SettingsPage];
export const pageById = (id: string) => PAGES.find(p => p.id === id);
