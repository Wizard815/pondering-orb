import type { ReactNode } from "react";
import type { PanelDef } from "../components/PanelGrid";

/** A page is a set of panels plus an optional header area. usePanels runs as
 *  a hook inside the page component, so it may use store hooks. */
export type PageDef = {
  id: string; label: string; title: string; flavor: string;
  usePanels: () => { panels: PanelDef[]; defaults?: string[]; extra?: ReactNode; head?: ReactNode };
};
