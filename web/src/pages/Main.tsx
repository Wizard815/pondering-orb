import type { PageDef } from "./types";
import type { PanelDef } from "../components/PanelGrid";
import { useColl, useSettings } from "../lib/store";
import { useFetch } from "../lib/useFetch";
import { Golem } from "../components/Golem";
import { DayPlan } from "../components/Glance";
import { useAppPanels } from "../components/AppPanels";
import { ChoreRows, LogList, OpenTasks, QuickLog, Star, TaskRows, projHref } from "../components/Common";
import { parseApps, DEFAULT_APPS, App } from "../lib/apps";
import { fmtDate, isUrl, listOf, logSorted, prioOf, sortTasks, STATUS_LABEL, todayISO } from "../lib/util";

function Favorites() {
  const projects = useColl("projects"), logs = useColl("logs"), tasks = useColl("tasks");
  const favs = projects.filter(p => p.fav && !p.archived).sort((a, b) => a.name.localeCompare(b.name));
  if (!favs.length) return <div className="empty">Star a project on the Projects board to keep it here.</div>;
  return <ul className="list">{favs.map(p => { const last = logSorted(logs).find(l => l.project === p.name), n = tasks.filter(t => !t.done && listOf(t) === (p.taskList || p.name)).length;
    return <li key={p.id}><div className="grow"><a href={projHref(p)}><b>{p.name}</b></a> <span className={"small st-" + p.status}>{STATUS_LABEL[p.status] || p.status}</span>
      <div className="small muted">{last ? `${fmtDate(last.date)} · ${last.text}` : "No log yet"}{n ? ` · ${n} open task${n > 1 ? "s" : ""}` : ""}</div></div><Star p={p} /></li>; })}</ul>;
}
/** High, Urgent and Do-now tasks across every list, most pressing first. */
function TopPriority() {
  const tasks = useColl("tasks");
  const list = sortTasks(tasks.filter(t => !t.done && prioOf(t) >= 3)).slice(0, 10);
  return list.length ? <TaskRows tasks={list} showList /> : <div className="empty">Nothing marked High or above.</div>;
}
function UptimeMini() {
  const { data, error } = useFetch<{ monitors: any[] }>("/api/uptime", 60000);
  if (error) return <div className="empty">{error}</div>;
  const ms = data?.monitors || [], down = ms.filter(m => m.status === "down");
  return <><div className="row"><span className="pill ok"><i />{ms.filter(m => m.status === "up").length} up</span>{down.length > 0 && <span className="pill bad"><i />{down.length} down</span>}</div>
    <div className="mons">{[...down, ...ms.filter(m => m.status !== "down")].slice(0, 6).map(m => <div key={m.id} className={"mon " + m.status}><span className="dot" /><span className="grow">{m.name}</span><span className="mono small">{m.uptime24 != null ? m.uptime24 + "%" : ""}</span></div>)}</div></>;
}
function UpstreamMini() {
  const { data, error } = useFetch<any[]>("/api/upstream/requests", 120000);
  if (error) return <div className="empty">{error}</div>;
  const pend = (data || []).filter(r => r.status === "pending");
  return <><div className="row"><span className={"pill " + (pend.length ? "warn" : "ok")}><i />{pend.length} request{pend.length === 1 ? "" : "s"} waiting</span></div>
    <ul className="list">{pend.slice(0, 5).map(r => <li key={r.id}><div className="grow"><b>{r.repo_name}</b> <span className="hint">{r.focus_branch}</span></div></li>)}</ul>
    <a className="btn" href="#upkeep">Open Upkeep</a></>;
}
function SystemMini() {
  const { data, error } = useFetch<any>("/api/system", 10000);
  if (error) return <div className="empty">{error}</div>;
  const h = data?.hosts?.[0]; if (!h) return <div className="empty">Reading…</div>;
  const m = (l: string, v: number) => <div className="meter"><div className="lab"><span>{l}</span><b>{v}%</b></div><div className="bar"><span className={v >= 90 ? "crit" : v >= 75 ? "hot" : ""} style={{ width: v + "%" }} /></div></div>;
  return <div className="host"><div className="hn"><span>{h.name}</span><span className="small muted mono">{h.cores.length} cores · up {h.uptimeDays}d</span></div>
    <div className="meters">{m("CPU", h.cpu)}{m("Memory", h.mem)}{h.disks.map((d: any) => <div key={d.mount}>{m(d.mount, d.pct)}</div>)}</div></div>;
}

export const MainPage: PageDef = {
  id: "main", label: "Main", title: "Scrying Table", flavor: "Everything you chose to keep in view.",
  usePanels: () => {
    const s = useSettings(), { panels: appPanels, groups, widgetKeys } = useAppPanels();
    const panels: PanelDef[] = [
      { key: "golem", title: "Golem", node: <Golem />, w: 12, h: 10, minH: 6 },
      { key: "favorites", title: "Favorite projects", node: <Favorites />, w: 4, h: 7 },
      { key: "tasks", title: "Open tasks", node: <OpenTasks />, w: 4, h: 7 },
      { key: "priority", title: "Top priority", node: <TopPriority />, w: 4, h: 7 },
      { key: "today", title: "Today in dayGLANCE", node: <DayPlan date={todayISO()} />, w: 4, h: 7 },
      { key: "log", title: "Recent log", node: <><QuickLog /><LogList limit={6} withFilter /></>, w: 4, h: 9 },
      { key: "chores", title: "Chores", node: <><ChoreRows limit={6} /><div className="row"><a className="btn" href="#upkeep">All chores</a></div></>, w: 4, h: 6 },
      { key: "uptime", title: "Uptime", node: <UptimeMini />, w: 4, h: 6 },
      { key: "upstream", title: "UpstreamManager", node: <UpstreamMini />, w: 4, h: 6 },
      { key: "system", title: "System", node: <SystemMini />, w: 4, h: 6 },
      ...appPanels,
    ];
    void s;
    return { panels, defaults: ["golem", "favorites", "tasks", "priority", "today", "log", "chores", "uptime", "upstream", ...groups.slice(0, 1).map(g => "group:" + g.name), ...widgetKeys()] };
  },
};
