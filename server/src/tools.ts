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

/** The tools Golem uses and the MCP endpoint serves. Same rules either way:
 *  writes go through Records, so log length and the rest are enforced. */
export function orbTools(r: Records): Tool[] {
  return [
    { name: "orb_list_projects", description: "List projects: name, status (next, active, blocked, paused, shipped), next step, archived, open task count.",
      parameters: { type: "object", properties: {} },
      run: () => r.list("projects").map((p: any) => ({ name: p.name, status: p.status, next: p.next || "", archived: !!p.archived,
        openTasks: r.list("tasks").filter((t: any) => !t.done && listOf(t) === (p.taskList || p.name)).length })) },
    { name: "orb_get_project", description: "One project with its 20 newest log entries and its tasks.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: ({ name }) => { const p = byName(r, name); if (!p) throw new Error(`No project named ${name}`);
        return { ...p, logs: r.list("logs").filter((l: any) => l.project === p.name).sort((a: any, b: any) => String(b.date).localeCompare(a.date)).slice(0, 20).map((l: any) => ({ date: l.date, text: l.text, by: l.by })),
          tasks: r.list("tasks").filter((t: any) => listOf(t) === (p.taskList || p.name)).map((t: any) => ({ title: t.title, done: !!t.done, due: t.due || "", priority: prioName(t.priority) })) }; } },
    { name: "orb_list_logs", description: "Log entries newest first. Optional project filter; limit defaults to 20.",
      parameters: { type: "object", properties: { project: { type: "string" }, limit: { type: "number" } } },
      run: ({ project, limit }) => r.list("logs").filter((l: any) => !project || String(l.project).toLowerCase() === String(project).toLowerCase())
        .sort((a: any, b: any) => String(b.date).localeCompare(a.date) || (b.created || 0) - (a.created || 0)).slice(0, Math.min(Number(limit) || 20, 100)).map((l: any) => ({ date: l.date, project: l.project, text: l.text, by: l.by })) },
    { name: "orb_add_log", write: true, description: "Add a short log entry (a few words, past tense; at most the configured length, 50 characters by default). project must be an existing project name or General.",
      parameters: { type: "object", properties: { project: { type: "string" }, text: { type: "string" } }, required: ["project", "text"] },
      run: ({ project, text }, who) => { const p = byName(r, project); return r.create("logs", { project: p ? p.name : "General", text, by: who === "you" ? "golem" : who }); } },
    { name: "orb_move_project", write: true, description: `Move a project to a board column: ${STATUSES.join(", ")}.`,
      parameters: { type: "object", properties: { name: { type: "string" }, status: { type: "string", enum: STATUSES } }, required: ["name", "status"] },
      run: ({ name, status }) => { const p = byName(r, name); if (!p) throw new Error(`No project named ${name}`); return r.patch("projects", p.id, { status }); } },
    { name: "orb_list_tasks", description: "Tasks, optionally from one list (projects use their own name). openOnly defaults to true.",
      parameters: { type: "object", properties: { list: { type: "string" }, openOnly: { type: "boolean" } } },
      run: ({ list, openOnly }) => r.list("tasks").filter((t: any) => (!list || listOf(t).toLowerCase() === String(list).toLowerCase()) && (openOnly === false || !t.done))
        .map((t: any) => ({ title: t.title, list: listOf(t), due: t.due || "", done: !!t.done, inProgress: !t.done && !!t.started, priority: prioName(t.priority) })) },
    { name: "orb_add_task", write: true, description: "Add a task to a list. due is optional (YYYY-MM-DD); priority is none, low, medium, high, urgent or do_now.",
      parameters: { type: "object", properties: { title: { type: "string" }, list: { type: "string" }, due: { type: "string" }, priority: { type: "string", enum: LEVELS } }, required: ["title", "list"] },
      run: ({ title, list, due, priority }) => r.create("tasks", { title, list, due: /^\d{4}-\d{2}-\d{2}$/.test(due || "") ? due : "", priority: PRIO[priority] ?? 0, done: false }) },
    { name: "orb_set_task_priority", write: true, description: "Set an open task's priority by its exact title: none, low, medium, high, urgent or do_now.",
      parameters: { type: "object", properties: { title: { type: "string" }, list: { type: "string" }, priority: { type: "string", enum: LEVELS } }, required: ["title", "priority"] },
      run: ({ title, list, priority }) => {
        if (!(priority in PRIO)) throw new Error(`Priority must be one of ${LEVELS.join(", ")}`);
        const m = r.list("tasks").filter((t: any) => !t.done && String(t.title).toLowerCase() === String(title).toLowerCase() && (!list || listOf(t).toLowerCase() === String(list).toLowerCase()));
        if (!m.length) throw new Error(`No open task titled ${title}`); if (m.length > 1) throw new Error("Several tasks match; give the list too");
        if (isOmiTask((m[0] as any).caldav?.uid)) throw new Error("That task comes from Omi; Orb only reads it. Change it in Omi.");
        r.patch("tasks", (m[0] as any).id, { priority: PRIO[priority] }); return { title: (m[0] as any).title, priority };
      } },
    { name: "orb_start_task", write: true, description: "Mark an open task in progress by its exact title (give the list when titles repeat): someone or an agent has started on it. Also writes a log line for its project.",
      parameters: { type: "object", properties: { title: { type: "string" }, list: { type: "string" } }, required: ["title"] },
      run: ({ title, list }, who) => {
        const m = r.list("tasks").filter((t: any) => !t.done && String(t.title).toLowerCase() === String(title).toLowerCase() && (!list || listOf(t).toLowerCase() === String(list).toLowerCase()));
        if (!m.length) throw new Error(`No open task titled ${title}`); if (m.length > 1) throw new Error("Several tasks match; give the list too");
        const t: any = m[0]; const by = who === "you" ? "golem" : who;
        if (isOmiTask(t.caldav?.uid)) throw new Error("That task comes from Omi; Orb only reads it. Change it in Omi.");
        if (t.started) return { title: t.title, list: listOf(t), inProgress: true, already: true };
        r.patch("tasks", t.id, { started: true });
        const p = r.list("projects").find((x: any) => (x.taskList || x.name) === listOf(t)) as any;
        if (p) { try { r.create("logs", { project: p.name, text: `Started: ${t.title}`.slice(0, r.logMax()), by }); } catch { /* too long etc */ } }
        return { title: t.title, list: listOf(t), inProgress: true };
      } },
    { name: "orb_complete_task", write: true, description: "Mark an open task done by its exact title (give the list when titles repeat). Also writes a log line for its project.",
      parameters: { type: "object", properties: { title: { type: "string" }, list: { type: "string" } }, required: ["title"] },
      run: ({ title, list }, who) => {
        const m = r.list("tasks").filter((t: any) => !t.done && String(t.title).toLowerCase() === String(title).toLowerCase() && (!list || listOf(t).toLowerCase() === String(list).toLowerCase()));
        if (!m.length) throw new Error(`No open task titled ${title}`); if (m.length > 1) throw new Error("Several tasks match; give the list too");
        const t: any = m[0]; const by = who === "you" ? "golem" : who;
        if (isOmiTask(t.caldav?.uid)) throw new Error("That task comes from Omi; Orb only reads it. Mark it done in Omi.");
        r.patch("tasks", t.id, { done: true, doneAt: today(), doneBy: by });
        const p = r.list("projects").find((x: any) => (x.taskList || x.name) === listOf(t)) as any;
        if (p) { try { r.create("logs", { project: p.name, text: `Done: ${t.title}`.slice(0, r.logMax()), by }); } catch { /* too long etc */ } }
        return { title: t.title, list: listOf(t), done: true };
      } },
    { name: "orb_list_chores", description: "Recurring chores with days left until due (negative means overdue).",
      parameters: { type: "object", properties: {} },
      run: () => r.list("chores").map((c: any) => { const last = c.lastDone ? Date.parse(c.lastDone + "T12:00:00") : 0; const left = Math.floor((last + c.everyDays * 864e5 - Date.now()) / 864e5); return { name: c.name, everyDays: c.everyDays, lastDone: c.lastDone || "never", daysLeft: left }; }) },
    { name: "orb_chore_done", write: true, description: "Mark a chore done today by its exact name.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: ({ name }) => { const c = r.list("chores").find((x: any) => String(x.name).toLowerCase() === String(name).toLowerCase()); if (!c) throw new Error(`No chore named ${name}`); return r.patch("chores", c.id, { lastDone: today() }); } },
  ];
}
