import type { Records } from "./records.js";
import type { Tool } from "./integrations/llm.js";
import { STATUSES } from "./records.js";
import { today } from "./dates.js";
import { isOmiTask } from "./integrations/companions.js";

// Priority is stored as CalDAV PRIORITY and named on vikunja's five levels,
// with vikunja's own mapping (low 9, medium 5, high 3, urgent 2, do now 1).
const LEVELS = ["none", "low", "medium", "high", "urgent", "do_now"];
const prioName = (p: number) => LEVELS[[0, 5, 4, 3, 3, 2, 1, 1, 1, 1][Math.max(0, Math.min(9, Math.round(Number(p) || 0)))]];
const PRIO: Record<string, number> = { none: 0, low: 9, medium: 5, high: 3, urgent: 2, do_now: 1, "do now": 1 };
const byName = (r: Records, name: string) => r.list("projects").find((p: any) => String(p.name).toLowerCase() === String(name || "").toLowerCase()) as any;
const listOf = (t: any) => t.list || t.project || "Inbox";
const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
/** The states of the agent working on a task or project (as Hermes Studio reports them), plus gone (it stopped). */
const AGENT_STATUSES = ["working", "blocked", "done", "idle", "gone"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (s: string) => DAY.test(s) && !Number.isNaN(Date.parse(s + "T12:00:00Z")) && new Date(s + "T12:00:00Z").toISOString().startsWith(s);

/** Said once in every task tool so an agent connected to both servers picks the right one. */
const TASKS_ARE =
  "Tasks here are Orb's copy of the CalDAV task lists (Vikunja, through the ALLGlance gateway), synced every 5 minutes. " +
  "For household tasks with owners, ids that never change, or due-date filters across people, the ALLGlance server's allglance_list_tasks is the better tool when it is connected.";

// Parameter schemas, shared so every tool describes them the same way.
const P = {
  id: { type: "string", description: "The task id from orb_list_tasks. Prefer it over title: it is exact even when titles repeat." },
  title: { type: "string", description: "The task's exact title (case does not matter). Ignored when id is given." },
  list: { type: "string", description: "Task list name, from orb_list_lists. A project's tasks are in the list named after the project. Needed when a title appears in more than one list." },
  priority: { type: "string", enum: LEVELS, description: "none, low, medium, high, urgent or do_now (Vikunja's levels)." },
  project: { type: "string", description: "Project name exactly as orb_list_projects shows it (case does not matter)." },
  day: (what: string) => ({ type: "string", description: `${what} as YYYY-MM-DD.` }),
};

export function orbTools(r: Records, caldavLists: () => string[] = () => []): Tool[] {
  const knownLists = () => {
    const names = new Map<string, string>();
    for (const n of caldavLists()) names.set(n.toLowerCase(), n);
    for (const t of r.list("tasks") as any[]) names.set(listOf(t).toLowerCase(), names.get(listOf(t).toLowerCase()) || listOf(t));
    for (const p of r.list("projects") as any[]) { const n = p.taskList || p.name; if (!names.has(n.toLowerCase())) names.set(n.toLowerCase(), n); }
    return [...names.values()];
  };
  const synced = (name: string) => caldavLists().some(n => same(n, name)) || (r.list("tasks") as any[]).some(t => same(t.caldav?.list, name));
  /** One task by id, or by title (+ list). Throws a message an agent can act on. */
  const findTask = ({ id, title, list }: any, openOnly = true) => {
    if (id) {
      const t: any = r.get("tasks", String(id));
      if (!t) throw new Error(`No task with id ${id}. Get ids from orb_list_tasks.`);
      if (openOnly && t.done) throw new Error(`Task "${t.title}" is already done.`);
      return t;
    }
    if (!title) throw new Error("Give the task's id (from orb_list_tasks) or its title.");
    const m = (r.list("tasks") as any[]).filter(t => (!openOnly || !t.done) && same(t.title, title) && (!list || same(listOf(t), list)));
    if (!m.length) throw new Error(`No ${openOnly ? "open " : ""}task titled "${title}"${list ? ` in ${list}` : ""}. Check orb_list_tasks.`);
    if (m.length > 1) throw new Error(`${m.length} tasks are titled "${title}" (in ${m.map(listOf).join(", ")}). Give the id or the list.`);
    return m[0];
  };
  const notOmi = (t: any, verb: string) => { if (isOmiTask(t.caldav?.uid)) throw new Error(`"${t.title}" comes from Omi; Orb only reads it. ${verb} it in Omi.`); };
  const logFor = (t: any, text: string, by: string) => {
    const p = r.list("projects").find((x: any) => (x.taskList || x.name) === listOf(t)) as any;
    if (p) { try { r.create("logs", { project: p.name, text: text.slice(0, r.logMax()), by }); } catch { /* too long etc */ } }
  };
  const byWho = (who: string) => (who === "you" ? "golem" : who);

  return [
    { name: "orb_list_projects", description: "List the projects on Orb's board: name, status column (next, active, blocked, paused, shipped), next step, archived flag, live agent status and open task count. Start here to find project names for the other tools.",
      parameters: { type: "object", properties: {} },
      run: () => r.list("projects").map((p: any) => ({ name: p.name, status: p.status, next: p.next || "", archived: !!p.archived, agentStatus: p.agent?.status || "",
        openTasks: r.list("tasks").filter((t: any) => !t.done && listOf(t) === (p.taskList || p.name)).length })) },
    { name: "orb_get_project", description: "One project in full: its fields, its 20 newest log entries, and every task in its list (with ids).",
      parameters: { type: "object", properties: { name: P.project }, required: ["name"] },
      run: ({ name }) => { const p = byName(r, name); if (!p) throw new Error(`No project named ${name}. See orb_list_projects.`);
        return { ...p, logs: r.list("logs").filter((l: any) => l.project === p.name).sort((a: any, b: any) => String(b.date).localeCompare(a.date)).slice(0, 20).map((l: any) => ({ date: l.date, text: l.text, by: l.by })),
          tasks: r.list("tasks").filter((t: any) => listOf(t) === (p.taskList || p.name)).map((t: any) => ({ id: t.id, title: t.title, done: !!t.done, due: t.due || "", priority: prioName(t.priority) })) }; } },
    { name: "orb_list_logs", description: "Project log entries (short past-tense notes of what got done), newest first. Use it for \"what did I work on?\" questions.",
      parameters: { type: "object", properties: { project: { ...P.project, description: "Only this project's entries (or General). Omit for all." }, limit: { type: "integer", minimum: 1, maximum: 100, description: "How many entries. Default 20." } } },
      run: ({ project, limit }) => r.list("logs").filter((l: any) => !project || same(l.project, project))
        .sort((a: any, b: any) => String(b.date).localeCompare(a.date) || (b.created || 0) - (a.created || 0)).slice(0, Math.min(Number(limit) || 20, 100)).map((l: any) => ({ date: l.date, project: l.project, text: l.text, by: l.by })) },
    { name: "orb_add_log", write: true, description: `Add a short log entry to a project: a few words in the past tense, e.g. "Fixed MCP tool descriptions". At most the configured length (${r.logMax()} characters); longer text is refused, not cut. Completing a task already logs it, so don't log that twice.`,
      parameters: { type: "object", properties: { project: { ...P.project, description: "An existing project name, or General for work that belongs to no project." }, text: { type: "string", description: `The entry, at most ${r.logMax()} characters.` } }, required: ["project", "text"] },
      run: ({ project, text }, who) => { const p = byName(r, project); return r.create("logs", { project: p ? p.name : "General", text, by: byWho(who) }); } },
    { name: "orb_move_project", write: true, description: `Move a project to another board column: ${STATUSES.join(", ")}. Also updates the project note's project_status in the wiki.`,
      parameters: { type: "object", properties: { name: P.project, status: { type: "string", enum: STATUSES, description: "The column to move it to." } }, required: ["name", "status"] },
      run: ({ name, status }) => { const p = byName(r, name); if (!p) throw new Error(`No project named ${name}. See orb_list_projects.`); return r.patch("projects", p.id, { status }); } },
    { name: "orb_list_lists", description: "The task lists Orb knows: name, whether it syncs to CalDAV/Vikunja (synced false = it only lives in Orb), the project it belongs to, and its open task count. Use it before orb_add_task so the task lands in a real list.",
      parameters: { type: "object", properties: {} },
      run: () => knownLists().map(name => ({ name, synced: synced(name),
        project: ((r.list("projects") as any[]).find(p => same(p.taskList || p.name, name)) || {}).name || "",
        openTasks: (r.list("tasks") as any[]).filter(t => !t.done && same(listOf(t), name)).length })) },
    { name: "orb_list_tasks", description: `List tasks with their ids, soonest due first (undated last). ${TASKS_ARE}`,
      parameters: { type: "object", properties: {
        list: { ...P.list, description: "Only this list (from orb_list_lists). Omit for every list." },
        openOnly: { type: "boolean", description: "Only tasks not done yet. Default true." },
        due_on_or_before: P.day("Only tasks due on or before this day (use yesterday's date for overdue). Undated tasks are left out"),
        due_on_or_after: P.day("Only tasks due on or after this day. Undated tasks are left out"),
        limit: { type: "integer", minimum: 1, maximum: 500, description: "At most this many. Default 100; truncated is true when more matched." } } },
      run: ({ list, openOnly, due_on_or_before: before, due_on_or_after: after, limit }) => {
        if (list && !knownLists().some(n => same(n, list))) throw new Error(`No list named "${list}". Lists: ${knownLists().join(", ") || "none yet"}.`);
        for (const [k, v] of [["due_on_or_before", before], ["due_on_or_after", after]]) if (v && !isDay(v)) throw new Error(`${k} must be YYYY-MM-DD, got "${v}".`);
        const all = (r.list("tasks") as any[]).filter(t => (!list || same(listOf(t), list)) && (openOnly === false || !t.done)
          && (!before || (t.due && t.due <= before)) && (!after || (t.due && t.due >= after)))
          .sort((a, b) => String(a.due || "9999").localeCompare(String(b.due || "9999")));
        const max = Math.min(Number(limit) || 100, 500);
        return { tasks: all.slice(0, max).map(t => ({ id: t.id, title: t.title, list: listOf(t), due: t.due || "", done: !!t.done, inProgress: !t.done && !!t.started, agentStatus: t.agent?.status || "", priority: prioName(t.priority), fromOmi: isOmiTask(t.caldav?.uid) })),
          truncated: all.length > max };
      } },
    { name: "orb_add_task", write: true, description: `Add a task to a list. Returns the new task with its id. A list that isn't a CalDAV list makes a task that only lives in Orb (the result says so); check orb_list_lists first. ${TASKS_ARE}`,
      parameters: { type: "object", properties: { title: { type: "string", description: "Short task title, in the user's own words." }, list: { ...P.list, description: "Which list, from orb_list_lists (a project's list is named after the project)." },
        due: P.day("Optional due date"), priority: { ...P.priority, description: "Optional. none, low, medium, high, urgent or do_now. Default none." } }, required: ["title", "list"] },
      run: ({ title, list, due, priority }) => {
        if (!String(title || "").trim()) throw new Error("title is empty.");
        if (due && !isDay(due)) throw new Error(`due must be YYYY-MM-DD (e.g. ${today()}), got "${due}". Nothing was created.`);
        if (priority && !(priority in PRIO)) throw new Error(`priority must be one of ${LEVELS.join(", ")}. Nothing was created.`);
        const name = knownLists().find(n => same(n, list)) || list;
        const t: any = r.create("tasks", { title, list: name, due: due || "", priority: PRIO[priority] ?? 0, done: false });
        const out: any = { id: t.id, title: t.title, list: name, due: t.due, priority: prioName(t.priority) };
        if (caldavLists().length && !synced(name)) out.note = `"${name}" isn't a CalDAV list, so this task only lives in Orb and won't reach Vikunja.`;
        return out;
      } },
    { name: "orb_set_task_priority", write: true, description: "Change an open task's priority. Find it by id (from orb_list_tasks) or by exact title. Tasks from Omi are read-only here.",
      parameters: { type: "object", properties: { id: P.id, title: P.title, list: P.list, priority: P.priority }, required: ["priority"] },
      run: (args) => {
        if (!(args.priority in PRIO)) throw new Error(`priority must be one of ${LEVELS.join(", ")}.`);
        const t = findTask(args); notOmi(t, "Change");
        r.patch("tasks", t.id, { priority: PRIO[args.priority] }); return { id: t.id, title: t.title, priority: args.priority };
      } },
    { name: "orb_start_task", write: true, description: "Mark an open task in progress: someone or an agent has started on it. Find it by id or exact title. Also writes a \"Started:\" log line on its project. Agents reporting their own live state should use orb_set_agent_status instead.",
      parameters: { type: "object", properties: { id: P.id, title: P.title, list: P.list } },
      run: (args, who) => {
        const t = findTask(args); notOmi(t, "Change");
        if (t.started) return { id: t.id, title: t.title, list: listOf(t), inProgress: true, already: true };
        r.patch("tasks", t.id, { started: true }); logFor(t, `Started: ${t.title}`, byWho(who));
        return { id: t.id, title: t.title, list: listOf(t), inProgress: true };
      } },
    { name: "orb_set_agent_status", write: true, description: "Record the live status of the agent working on a task or a project (Hermes Studio reports these): working, blocked (needs the user), done (finished its turn), idle, or gone (it stopped). The first working marks a task in progress and moves a project to active; gone puts an unfinished task back to open. Give a task or a project.",
      parameters: { type: "object", properties: {
        task: { type: "object", description: "The task, by id or by title (+ list).", properties: { id: P.id, title: P.title, list: P.list } },
        project: { ...P.project, description: "A project instead of a task." },
        status: { type: "string", enum: AGENT_STATUSES, description: "working, blocked, done, idle or gone." },
        agent: { type: "string", description: "The agent's display name, at most 40 characters." } }, required: ["status"] },
      run: ({ task, project, status, agent }, who) => {
        if (!AGENT_STATUSES.includes(status)) throw new Error(`Status must be one of ${AGENT_STATUSES.join(", ")}`);
        const by = byWho(who);
        const live = status === "gone" ? null : { status, name: String(agent || "").slice(0, 40), at: Date.now() };
        if (task?.id || task?.title) {
          // Prefer the open one, but a done task can still take a status.
          let t: any; try { t = findTask(task); } catch (e) { if (task.id) throw e; t = findTask(task, false); }
          notOmi(t, "Change");
          const patch: any = { agent: live };
          if (!t.done && status === "working" && !t.started) { patch.started = true; logFor(t, `Started: ${t.title}`, by); }
          // The agent went away without finishing: the task is open again.
          if (status === "gone" && !t.done) patch.started = false;
          r.patch("tasks", t.id, patch);
          return { id: t.id, title: t.title, list: listOf(t), agentStatus: live?.status || "", inProgress: !t.done && (patch.started ?? !!t.started) };
        }
        if (project) {
          const p = byName(r, project); if (!p) throw new Error(`No project named ${project}. See orb_list_projects.`);
          const patch: any = { agent: live };
          if (status === "working" && !["active", "shipped"].includes(p.status)) patch.status = "active";
          r.patch("projects", p.id, patch);
          return { name: p.name, agentStatus: live?.status || "", status: patch.status || p.status };
        }
        throw new Error("Give a task or a project.");
      } },
    { name: "orb_complete_task", write: true, description: "Mark an open task done where it lives (the CalDAV list too, on the next sync) and write a \"Done:\" log line on its project, credited to the caller. This is how an agent reports finished work. Find it by id or exact title. Tasks from Omi are read-only here.",
      parameters: { type: "object", properties: { id: P.id, title: P.title, list: P.list } },
      run: (args, who) => {
        const t = findTask(args); notOmi(t, "Mark");
        const by = byWho(who);
        r.patch("tasks", t.id, { done: true, doneAt: today(), doneBy: by }); logFor(t, `Done: ${t.title}`, by);
        return { id: t.id, title: t.title, list: listOf(t), done: true };
      } },
    { name: "orb_list_chores", description: "Recurring chores: how often (everyDays), when last done, and days left until due (negative = overdue).",
      parameters: { type: "object", properties: {} },
      run: () => r.list("chores").map((c: any) => { const last = c.lastDone ? Date.parse(c.lastDone + "T12:00:00") : 0; const left = Math.floor((last + c.everyDays * 864e5 - Date.now()) / 864e5); return { name: c.name, everyDays: c.everyDays, lastDone: c.lastDone || "never", daysLeft: left }; }) },
    { name: "orb_chore_done", write: true, description: "Mark a chore done today, by its exact name from orb_list_chores.",
      parameters: { type: "object", properties: { name: { type: "string", description: "The chore's name exactly as orb_list_chores shows it (case does not matter)." } }, required: ["name"] },
      run: ({ name }) => { const c = r.list("chores").find((x: any) => same(x.name, name)); if (!c) throw new Error(`No chore named ${name}. See orb_list_chores.`); return r.patch("chores", c.id, { lastDone: today() }); } },
  ];
}
