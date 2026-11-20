import { parse } from "yaml";
import type { Tool } from "./integrations/llm.js";
import type { Records } from "./records.js";
import { isDay, today } from "./dates.js";
import { call, trimSlash } from "./integrations/http.js";

/** Golem's tools for the rest of the suite: every main connection (UpstreamManager, Uptime Kuma, CalDAV calendars, LLMWIKI
 *  edits, ALLGlance, the reverse proxy and DNS, Milaclone, the server and its containers, Hermes Studio) and, read only, the
 *  live data of every app in the apps YAML (SABnzbd's queue, Plex's streams, Firefly III, Coinpile, Omi).
 *
 *  They do what Orb's own pages do, through the same code and rules. Anything that changes something is a write tool, so
 *  read-only Golem doesn't get it and, after outside text in a turn, it waits for the user's yes. Text that comes from
 *  elsewhere (commit messages, agent chats, calendar invites, board cards, app data) is marked external. A tool is only
 *  offered when its connection is set up. */
export type SuiteDeps = {
  records: Records;
  cfg: () => any;
  secret: (env?: string) => string;
  appsYaml: () => string;
  upstream: any; hermes: any; glance: any; wiki: any; sync: any;
  events: (from: string, days: number) => Promise<any[]>;
  linkApps: () => Promise<{ apps: any[]; notes: string[] }>;
  linkContext: () => Promise<{ server: string; how: string; routes: any[]; dns: any[]; notes: string[]; found: Record<string, number> }>;
  linkFor: (a: any, ctx: any) => { url: string; via: string };
  uptime: (base: string, slug: string, ignore?: string[]) => Promise<{ monitors: any[] }>;
  system: () => Promise<any>;
  widgetsFrom: (yaml: string) => Record<string, { type: string; url: string; keyEnv?: string }>;
  widgetData: (name: string, w: any) => Promise<unknown>;
  logMax: () => number;
};

const S = (description: string) => ({ type: "string", description });
const cut = (v: unknown, n: number) => String(v ?? "").slice(0, n);

export function suiteTools(d: SuiteDeps): Tool[] {
  const c = d.cfg(), out: Tool[] = [];

  // ---- UpstreamManager ----
  if (c.upstream.baseUrl) out.push(
    { name: "upstream_repos", description: "UpstreamManager's repos: id, name, upstream status (behind, conflicts), last fetch. Use the ids with the other upstream_ tools. Read only.",
      parameters: { type: "object", properties: {} }, run: async () => ((await d.upstream.repos()) || []).slice(0, 100) },
    { name: "upstream_requests", external: true, description: "UpstreamManager's approval requests (merging upstream changes into a repo): id, repo, what it would change, its parts (components), status. Read only; the text comes from other projects' commits.",
      parameters: { type: "object", properties: {} }, run: async () => ((await d.upstream.requests()) || []).slice(0, 50) },
    { name: "upstream_commits", external: true, description: "A repo's recent commits (its own and upstream's), newest first. Read only.",
      parameters: { type: "object", properties: { repo: S("The repo id from upstream_repos."), limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 20." } }, required: ["repo"] },
      run: async ({ repo, limit }: any) => d.upstream.commits(String(repo), Math.min(Number(limit) || 20, 100)) },
    { name: "upstream_decide", write: true, description: "Approve or deny an UpstreamManager request, as the Upkeep page does. To approve only some parts, give their names in only. Only when the user asked for this decision.",
      parameters: { type: "object", properties: { request: S("The request id from upstream_requests."), decision: { type: "string", enum: ["approve", "deny"] },
        comment: S("Optional note for UpstreamManager."), only: { type: "array", items: { type: "string" }, description: "Approve just these parts (component names)." } }, required: ["request", "decision"] },
      run: async ({ request, decision, comment, only }: any) => {
        if (decision !== "approve" && decision !== "deny") throw new Error("decision must be approve or deny.");
        if (decision === "approve" && Array.isArray(only) && only.length) {
          const r = ((await d.upstream.requests()) || []).find((x: any) => String(x.id) === String(request)); if (!r) throw new Error(`No request ${request}. See upstream_requests.`);
          const all = (r.components || r.upstreams || []).map((x: any) => x.name), bad = only.filter((n: string) => !all.includes(n));
          if (bad.length) throw new Error(`No part named ${bad.join(", ")}. Parts: ${all.join(", ")}.`);
          if (only.length < all.length) return d.upstream.approvePart(r, only, comment);
        }
        return d.upstream.decide(String(request), decision, comment ? cut(comment, 500) : undefined);
      } },
    { name: "upstream_fetch", write: true, description: "Fetch one repo's upstream now (UpstreamManager checks for new upstream commits).",
      parameters: { type: "object", properties: { repo: S("The repo id from upstream_repos.") }, required: ["repo"] }, run: ({ repo }: any) => d.upstream.fetchRepo(String(repo)) },
    { name: "upstream_run_daily", write: true, description: "Run UpstreamManager's daily check now (every repo is fetched and new requests are made).",
      parameters: { type: "object", properties: {} }, run: () => d.upstream.runDaily() },
  );

  // ---- Uptime Kuma ----
  if (c.uptime.baseUrl) out.push({ name: "uptime_status", description: "Uptime Kuma: every monitor on Orb's status page with up / down / pending, 24-hour uptime % and ping; ignored ones are marked. Read only.",
    parameters: { type: "object", properties: { only_problems: { type: "boolean", description: "Only monitors that are down or pending (not ignored)." } } },
    run: async ({ only_problems }: any) => { const r = await d.uptime(c.uptime.baseUrl, c.uptime.statusPage, c.uptime.ignore);
      const ms = r.monitors.map(m => ({ name: m.name, group: m.group, status: m.status, uptime24: m.uptime24, ping: m.ping, ignored: m.ignored }));
      return { down: ms.filter(m => m.status === "down" && !m.ignored).map(m => m.name), monitors: only_problems ? ms.filter(m => m.status !== "up" && !m.ignored) : ms }; } });

  // ---- CalDAV and the family calendar ----
  if (c.caldav.url || c.allglance.baseUrl) out.push({ name: "calendar_events", external: true, description: "Calendar events from every CalDAV calendar and the family calendar (dayGLANCE): title, start, end, all-day, calendar. Read only.",
    parameters: { type: "object", properties: { from: S("First day, YYYY-MM-DD (default today)."), days: { type: "integer", minimum: 1, maximum: 31, description: "How many days. Default 1." } } },
    run: async ({ from, days }: any) => (await d.events(isDay(from) ? from : today(), Math.min(Math.max(Number(days) || 1, 1), 31)))
      .map(e => ({ title: e.title, day: e.day, start: e.start, end: e.end, allDay: !!e.allDay, calendar: e.calendar || "", location: e.location || "" })).slice(0, 200) });
  if (c.caldav.url) out.push({ name: "caldav_sync", write: true, description: "Sync tasks and chores with the CalDAV server now (Orb also does it on its own every few minutes): sends changes waiting here, reads changes made elsewhere.",
    parameters: { type: "object", properties: {} }, run: async () => { await d.sync.pull(); return { lists: d.sync.lists.map((l: any) => l.name), lastSync: d.sync.lastSync, lastError: d.sync.lastError || "" }; } });

  // ---- LLMWIKI edits (the same two sections and daily log Orb itself writes) ----
  if (c.wiki.baseUrl) out.push(
    { name: "wiki_edit_section", write: true, description: "Replace the Current state or Next steps section of a wiki note (the only sections Orb edits; it also logs the edit). Read the note first with wiki_read and keep what should stay.",
      parameters: { type: "object", properties: { path: S("Note path from wiki_search, e.g. wiki/1-projects/Argos.md."), heading: { type: "string", enum: ["Current state", "Next steps"] }, text: S("The section's new Markdown body.") }, required: ["path", "heading", "text"] },
      run: async ({ path, heading, text }: any) => {
        if (!["Current state", "Next steps"].includes(heading)) throw new Error("Orb edits only Current state and Next steps.");
        const { notePath } = await import("./integrations/wiki.js");
        const n = notePath(String(path), true), title = n.split("/").pop()!.replace(/\.md$/, "");
        await d.wiki.replaceSection(n, heading, cut(text, 8000), `[[${title}]]: edited ${heading}`); return { path: n, heading, saved: true };
      } },
    { name: "wiki_daily_log", write: true, description: "Add one line under \"Worked on\" in today's daily note in the wiki (marked pondering-orb). For work the user wants in the wiki's day, not Orb's project log.",
      parameters: { type: "object", properties: { line: S("One short line.") }, required: ["line"] },
      run: async ({ line }: any) => { const l = String(line || "").trim(); if (!l) throw new Error("line is empty."); await d.wiki.log(cut(l, 300)); return { added: l.slice(0, 300), day: today() }; } },
  );

  // ---- ALLGlance gateway ----
  if (c.allglance.baseUrl) out.push(
    { name: "allglance_chores", description: "lastGLANCE chores: title, who, when last done. Read only.", parameters: { type: "object", properties: {} }, run: () => d.glance.chores() },
    { name: "allglance_milestones", description: "lifeGLANCE milestones: title, date, who. Read only.", parameters: { type: "object", properties: {} }, run: () => d.glance.milestones() },
    { name: "allglance_add_event", write: true, description: "Add an event to the family calendar (a dayGLANCE block) through the gateway.",
      parameters: { type: "object", properties: { title: S("The event."), date: S("YYYY-MM-DD."), time: S("Start HH:MM (24 h); omit for no time."), minutes: { type: "integer", minimum: 5, maximum: 1440, description: "Length in minutes." } }, required: ["title", "date"] },
      run: ({ title, date, time, minutes }: any) => {
        const t = String(title || "").trim(); if (!t) throw new Error("An event needs a title.");
        if (!isDay(String(date || ""))) throw new Error(`date must be YYYY-MM-DD, got "${date}". Nothing was added.`);
        if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time))) throw new Error(`time must be HH:MM (24 h), got "${time}". Nothing was added.`);
        return d.glance.addEvent({ title: t.slice(0, 200), date, time: time || undefined, minutes: minutes ? Math.max(5, Math.min(1440, Math.round(Number(minutes)))) : undefined });
      } },
  );

  // ---- reverse proxy and DNS (Nginx Proxy Manager, nginx/SWAG files, Technitium) ----
  if (c.npm.baseUrl || c.nginx.confDir || c.technitium.baseUrl) out.push({ name: "proxy_sites", description: "The sites the reverse proxy serves (Nginx Proxy Manager or the nginx/SWAG files): names, https, where each forwards; plus Technitium DNS names and the server's LAN address. Read only.",
    parameters: { type: "object", properties: { find: S("Only names containing this.") } },
    run: async ({ find }: any) => { const x = await d.linkContext(), f = String(find || "").toLowerCase(), hit = (n: string) => !f || n.toLowerCase().includes(f);
      return { server: x.server, serverFrom: x.how, found: x.found, notes: x.notes,
        sites: x.routes.filter((r: any) => r.names.some(hit)).slice(0, 200).map((r: any) => ({ names: r.names, https: r.https, forwardsTo: `${r.host}:${r.port}`, from: r.via })),
        dns: x.dns.filter((n: any) => hit(n.name)).slice(0, 200) }; } });

  // ---- the server: Unraid agent / Docker containers, and host stats ----
  if (c.unraid.baseUrl || c.system.docker) out.push({ name: "server_containers", description: "The server's containers (Unraid Management Agent and/or Docker): name, state, image, update available, and the link that opens it. Read only.",
    parameters: { type: "object", properties: { find: S("Only names containing this."), only_stopped: { type: "boolean" } } },
    run: async ({ find, only_stopped }: any) => { const [a, x] = await Promise.all([d.linkApps(), d.linkContext().catch(() => null)]), f = String(find || "").toLowerCase();
      return { notes: a.notes, containers: a.apps.filter((p: any) => (!f || p.name.toLowerCase().includes(f)) && (!only_stopped || p.state !== "running")).slice(0, 200)
        .map((p: any) => ({ name: p.name, state: p.state, image: p.image, updateAvailable: !!p.updateAvailable, link: x ? d.linkFor(p, x).url : "" })) }; } });
  out.push({ name: "system_status", description: "The host Orb runs on (the System tab): CPU load, memory, disks, uptime, and its containers' CPU and memory. Read only.",
    parameters: { type: "object", properties: {} }, run: () => d.system() });

  // ---- Milaclone (Miladash) ----
  const mila = trimSlash(c.milaclone.apiUrl || c.milaclone.url || "");
  if (/^https?:\/\//.test(mila)) {
    const get = async (p: string) => { const k = d.secret(c.milaclone.keyEnv); const r = await call(mila + p, { headers: k ? { Authorization: `Bearer ${k}` } : {} });
      if (r.status === 401) throw new Error(`Milaclone wants its API key: set ${c.milaclone.keyEnv || "MILACLONE_API_KEY"} to its API_KEY.`); if (!r.ok) throw new Error(`Milaclone answered ${r.status}.`); return r.body; };
    out.push(
      { name: "milaclone_search", external: true, description: "Search Milaclone's boards (ideas, notes, links, to-dos): matching cards with their board, and matching boards. Read only.",
        parameters: { type: "object", properties: { query: S("Words to look for.") }, required: ["query"] },
        run: async ({ query }: any) => { const r = await get(`/api/search?q=${encodeURIComponent(cut(query, 200))}&limit=25`);
          return { boards: (r.boards || []).map((b: any) => ({ title: b.title, path: (b.breadcrumb || []).map((x: any) => x.title).join(" / ") })),
            cards: (r.items || []).map((i: any) => ({ type: i.type, board: i.canvasTitle, text: cut(i.data?.title || i.data?.text || i.data?.html?.replace(/<[^>]+>/g, " ") || i.data?.url || "", 400), stage: i.stage || "" })) }; } },
      { name: "milaclone_todos", external: true, description: "Every to-do list on Milaclone's boards with its tasks (done or not, due dates, tags). Read only.",
        parameters: { type: "object", properties: {} },
        run: async () => ((await get("/api/todos")).lists || []).map((l: any) => ({ title: l.title, board: l.canvasTitle, tasks: (l.tasks || []).filter((t: any) => t.text).map((t: any) => ({ text: t.text, done: !!t.done, due: t.due || "" })) })) },
      { name: "milaclone_pipeline", external: true, description: "Milaclone's idea pipeline: ideas by stage (thought, design, code) with their board. Read only.",
        parameters: { type: "object", properties: {} },
        run: async () => { const r = await get("/api/pipeline"); return { stages: r.stages, items: (r.items || []).map((i: any) => ({ title: i._title, board: i._canvasTitle, stage: i.stage })) }; } },
    );
  }

  // ---- Hermes Studio ----
  if (c.hermes.baseUrl) out.push(
    { name: "hermes_agents", description: "Hermes Studio: the agents Orb can send work to (id and name), for hermes_launch. Read only.",
      parameters: { type: "object", properties: {} }, run: () => d.hermes.agentKinds() },
    { name: "hermes_work", external: true, description: "Hermes Studio: the work Orb sent to agents, running or done (title, agent, status, linked task or project). Read only.",
      parameters: { type: "object", properties: {} }, run: async () => (await d.hermes.agents()).agents },
    { name: "hermes_search_chats", external: true, description: "Search Hermes Studio's chats by words; returns chat ids and titles (project_chats reads a project's linked chats). Read only.",
      parameters: { type: "object", properties: { query: S("Words to look for.") }, required: ["query"] },
      run: async ({ query }: any) => ((await d.hermes.sessions(cut(query, 200))) || []).slice(0, 25) },
    { name: "hermes_launch", write: true, description: "Send work to an agent in Hermes Studio: starts a new chat with your plan as its first message (like Orb's Send to agent). Link it to an Orb task or project so its progress shows here. Only when the user asked to hand this work to an agent.",
      parameters: { type: "object", properties: { agent: S("Agent id from hermes_agents (e.g. hermes, claude-code)."), title: S("Short title, at most 80 characters."),
        plan: S("What the agent should do: the full instructions."), project: S("Optional Orb project to link it to."),
        task: { type: "object", description: "Optional Orb task to link it to.", properties: { title: S("Task title."), list: S("Its list.") } } }, required: ["agent", "title", "plan"] },
      run: async ({ agent, title, plan, project, task }: any) => {
        const kinds = await d.hermes.agentKinds(); if (!kinds.some((k: any) => k.id === agent)) throw new Error(`No agent ${agent}. Agents: ${kinds.map((k: any) => k.id).join(", ")}.`);
        if (!String(title || "").trim() || !String(plan || "").trim()) throw new Error("title and plan are required.");
        const orb = task?.title ? { task: { title: String(task.title), list: String(task.list || "") } } : project ? { project: String(project) } : undefined;
        const r = await d.hermes.launch({ agentId: agent, title: cut(title, 80), prompt: cut(plan, 20000), orb });
        if (project && d.records.list("projects").some((p: any) => String(p.name).toLowerCase() === String(project).toLowerCase()))
          try { d.records.create("logs", { project: String(project), text: `Sent to ${agent} in Hermes Studio`.slice(0, d.logMax()), by: "golem" }); } catch { /* sent anyway */ }
        return { sent: true, agent, chatId: r.chatId };
      } },
  );

  // ---- every app in the apps YAML, read only ----
  const widgets = d.widgetsFrom(d.appsYaml());
  out.push({ name: "apps_list", description: "The apps on the dashboard (apps YAML): name, group, address, and whether Orb reads live data from it (app_live). Read only.",
    parameters: { type: "object", properties: {} },
    run: () => { let y: any = {}; try { y = parse(d.appsYaml() || "") || {}; } catch { /* no apps */ }
      return (Array.isArray(y.groups) ? y.groups : []).flatMap((g: any) => (Array.isArray(g?.apps) ? g.apps : []).filter((a: any) => a?.name)
        .map((a: any) => ({ name: String(a.name), group: String(g.name || ""), url: String(a.url || a.widget?.url || ""), live: widgets[String(a.name)] ? widgets[String(a.name)].type : "" }))); } });
  if (Object.keys(widgets).length) out.push({ name: "app_live", external: true,
    description: `What an app in the apps YAML shows right now, as its panel does (e.g. SABnzbd's queue: speed, time left, size left and each download; Plex's streams). Read only. Apps with live data: ${Object.entries(widgets).map(([n, w]) => `${n} (${w.type})`).join(", ").slice(0, 600)}.`,
    parameters: { type: "object", properties: { app: S("The app's name exactly as apps_list shows it.") }, required: ["app"] },
    run: async ({ app }: any) => { const name = Object.keys(widgets).find(n => n.toLowerCase() === String(app || "").toLowerCase());
      if (!name) throw new Error(`No app with live data called ${app}. Apps with live data: ${Object.keys(widgets).join(", ")}.`);
      return { app: name, type: widgets[name].type, data: await d.widgetData(name, widgets[name]) }; } });

  return out;
}
