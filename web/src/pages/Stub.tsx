import type { PageDef } from "./types";
export const stub = (id: string, label: string, title: string, flavor: string): PageDef => ({
  id, label, title, flavor,
  usePanels: () => ({ panels: [{ key: "soon", title, w: 12, h: 4, node: <div className="empty">This page is still being ported from the demo.</div> }] }),
});
