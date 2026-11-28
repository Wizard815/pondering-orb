/** Draws a glance (the summary Orb's /api/glance returns) as cards. Shared by the
 *  offline page and the mini view. Text only goes in through textContent. */
export type Glance = any;
const el = (tag: string, props: Record<string, any> = {}, ...kids: (Node | string)[]) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

export function drawGlance(root: HTMLElement, g: Glance | undefined, onTick?: (id: string, title: string) => void) {
  root.replaceChildren();
  if (!g) { root.append(el("p", { className: "hint", textContent: "Nothing yet. Orb's summary shows here after the first check." })); return; }
  const card = (title: string, ...kids: Node[]) => root.append(el("section", { className: "card" }, el("h2", { textContent: title }), ...kids));
  if (g.uptime) {
    const down: string[] = g.uptime.down;
    card("Services", down.length
      ? el("ul", { className: "list" }, ...down.map(d => el("li", {}, el("span", { className: "pill bad", textContent: "down" }), el("span", { className: "grow", textContent: d }))))
      : el("div", {}, el("span", { className: "pill ok", textContent: "all up" }), ` ${g.uptime.total} monitors`));
  }
  if (g.brief) card("Morning brief", el("div", { textContent: g.brief.headline }));
  if (g.events.length) card("Today", el("ul", { className: "list" }, ...g.events.map((e: any) => el("li", {}, el("b", { textContent: e.time || "all day" }), el("span", { className: "grow", textContent: e.title })))));
  if (g.tasks.length) card("Tasks", el("ul", { className: "list" }, ...g.tasks.map((t: any) => {
    const kids: Node[] = [el("span", { className: "grow" + (t.overdue ? " overdue" : ""), textContent: t.title + (t.due ? ` (${t.due})` : "") })];
    if (onTick) { const b = el("button", { className: "tick", type: "button", textContent: "✓", title: "Tick off" }) as HTMLButtonElement; b.setAttribute("aria-label", `Tick off: ${t.title}`); b.onclick = () => { b.disabled = true; onTick(t.id, t.title); }; kids.unshift(b); }
    return el("li", {}, ...kids);
  })));
  if (g.chores.length) card("Chores due", el("ul", { className: "list" }, ...g.chores.map((c: any) => el("li", { textContent: c.name }))));
  if (g.media.length) card("Media", el("ul", { className: "list" }, ...g.media.map((m: any) => el("li", {}, el("b", { textContent: m.name }), el("span", { className: "grow", textContent: m.line })))));
}
export const ago = (at: number) => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(at).toLocaleString(); };
