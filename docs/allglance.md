# ALLGlance and Pondering Orb

ALLGlance is the family stack: vikunja (the server-side task hub, with
CalDAV), dayGLANCE (day planner), lastGLANCE ("when did I last..."),
lifeGLANCE (life milestones), GLANCEvault (encrypted sync), and the
**gateway**: one MCP + REST front door over all of them.

## Who owns what

| Data | Owner | How Orb gets it |
| --- | --- | --- |
| Task lists (vikunja projects) | vikunja | **CalDAV through the gateway** (`<gateway>/dav/`), read and write (Orb's To-do, chores, project tasks) |
| Family calendar (time blocks) | dayGLANCE | gateway `GET /api/allglance/days/:date` (read); `POST /api/allglance/tasks` with `source: "dayglance"` to add an event |
| dayGLANCE tasks (inbox and every scheduled day) | dayGLANCE | gateway `GET /api/allglance/tasks` → `dayglance` (read) |
| Household members | dayGLANCE | gateway `GET /api/allglance/users` (read) |
| "Last done" chores | lastGLANCE | gateway `GET /api/allglance/chores` (read, from its synced snapshot) |
| Milestones | lifeGLANCE | gateway `GET /api/allglance/milestones` (read, from its synced snapshot) |
| Projects, logs, ideas board | Orb | Orb's own records |

## One address: CalDAV through the gateway

The gateway serves vikunja's CalDAV at `/dav` (same paths, so hrefs stay on
one server). Leave Orb's CalDAV URL empty and it uses `<gateway>/dav/`
automatically; log in with your **vikunja** user and password (or a CalDAV
token) in `CALDAV_USER` / `CALDAV_PASSWORD`. The gateway's own token doesn't
apply to `/dav`.

vikunja tasks reach Orb over CalDAV only, never also through the gateway, so
nothing shows twice. Orb writes vikunja tasks over CalDAV; the gateway's
`PATCH /api/allglance/tasks/vikunja/:id` is there for agents and other
clients.

vikunja has task lists only, no events calendar. In this stack **the family
calendar is dayGLANCE**: Orb reads its blocks through the gateway and shows
them as "Family" events.

## Omi in the ALLGlance stack

Omi syncs its action items with vikunja (through the gateway's `/dav`, both
ways) and can also create them through the gateway's task integration. Either
way they are ordinary vikunja tasks by the time Orb reads them, so they show
once. Ones Omi pushed over CalDAV keep Omi's `omi-task-…@omi-local` UID and
stay read only in Orb (change them in Omi); ones Omi created through the
gateway carry vikunja's own ids, and vikunja and Omi keep them in step, so
ticking one in Orb completes it in Omi too. Omi's day summaries don't reach
vikunja over CalDAV (no events calendar); Orb reads them from Omi directly
(docs/companions.md).

Where it shows in Orb:

- **Main:** "Today in dayGLANCE" (today's blocks) and "Top priority" (High,
  Urgent and Do-now tasks across every list).
- **Daily:** family-calendar blocks in Today and This week (with the member's
  name), and in the morning brief.
- **To-do:** "dayGLANCE tasks" (the inbox and the next 7 days) with their
  priorities, read only.
- **Calendar:** family-calendar blocks in the month and the next 14 days (in
  green), "dayGLANCE day" for any date, and "Milestones (lifeGLANCE)". **Add an
  event** can put it on the family calendar instead of Orb: with a time it's a
  block (pick how long), without one an all-day task, and you can assign it
  to a household member. Change or remove it in dayGLANCE.
- **Upkeep:** "lastGLANCE chores" next to Orb's own (CalDAV) chores.
- **Golem and MCP:** `allglance_day` and `allglance_dayglance_tasks` (read only).

Set it up in Settings → Connections → ALLGlance gateway (base URL, and the
name of the variable holding the token), or `allglance:` in `orb.yaml`, or
`ALLGLANCE_URL` / `ALLGLANCE_TOKEN` in the environment.

## Priority

One scale everywhere, vikunja's five levels:

| Level | Orb / vikunja | CalDAV PRIORITY (stored by Orb) | dayGLANCE |
| --- | --- | --- | --- |
| None | 0 | 0 | 0 |
| Low | 1 | 9 | 1 |
| Medium | 2 | 5 | 2 |
| High | 3 | 3 | 3 |
| Urgent | 4 | 2 | — |
| Do now | 5 | 1 | — |

The CalDAV column is vikunja's own mapping (`pkg/caldav/priority.go` in
vikunja), so a level set in Orb comes back as the same level in vikunja and
in the gateway. Reading CalDAV values other apps wrote: 1 → Do now, 2 →
Urgent, 3–4 → High, 5 → Medium, 6–9 → Low. dayGLANCE uses 0–3 (none, low,
medium, high), which means the same as vikunja's 0–3; only its inbox tasks
carry a priority (scheduled blocks drop it by design).

In Orb: click a task's priority chip to pick a level; add-task forms have a
priority select; To-do can show only "Medium and up", "High and up" and so
on; every list sorts by priority, then due date. Agents set it with
`orb_add_task` / `orb_set_task_priority` (`none`, `low`, `medium`, `high`,
`urgent`, `do_now`).

Before this change Orb wrote CalDAV 1 for "High", which vikunja shows as
**Do now**. Tasks set to High in an older build read as Do now; set them again.

## Changes made in ALLGlance (now on its `main`)

- `priority` (0–5) and `priority_label` on every task in the canonical model,
  plus CalDAV conversion helpers matching vikunja's.
- vikunja task updates: `vikunja_update_task` and `allglance_update_task`
  tools, `PATCH /api/allglance/vikunja/tasks/:id` and
  `PATCH /api/allglance/tasks/:source/:id` (done, priority, title, due date),
  using vikunja v2's PATCH with a GET + PUT fallback.
- Fix: adapter routes were mounted at `/vikunja/...` instead of the
  documented `/api/allglance/vikunja/...`.
- Fix: dayGLANCE blocks read through its MCP had no owner (the MCP reports
  `assignee_id`, the adapter read `assignedUserSyncIds` only), so per-person
  views came back empty.
- `GATEWAY_TOKEN`: when set, `/api/allglance/*` and `/mcp` need a bearer
  token. Without it the gateway is open to anyone who can reach port 8090,
  and it now warns about that on start.

## Still worth doing

- **Set `GATEWAY_TOKEN`** and give Orb the same value (`ALLGLANCE_TOKEN`).
- **lastGLANCE vs Orb chores:** both track "when was this last done". Pick
  one home: household chores in lastGLANCE and homelab chores in Orb's CalDAV
  chores list, or all in the CalDAV list.
- **Ticking dayGLANCE tasks from Orb:** Orb adds family-calendar events; the
  gateway's `PATCH /api/allglance/tasks/dayglance/:id` would let Orb also tick
  and move them.
- **vikunja's native MCP** (`/api/v2/mcp`) could replace the hand-written
  vikunja tools once ownership scoping is handled there.
