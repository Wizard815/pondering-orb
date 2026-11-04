# Pondering Orb backend design

The claude.ai page is the demo. The real Orb runs as a container on the
homelab, where it can reach CalDAV, Argos, Milaclone and the hosts. This file
is the plan for that container.

## What Orb owns, and what it only reads

Orb is a dashboard and a front door for agents. It owns only what no other
app in the stack already keeps.

| Data | Owner | Orb does |
| --- | --- | --- |
| Projects (board, status, next step, favorite) | **Orb** | stores |
| Project log (short entries, 50 characters by default) | **Orb** | stores |
| Notes, plans, upkeep checks, Main layout | **Orb** | stores |
| Tasks and calendar | **ALLGlance** (vikunja over CalDAV, dayGLANCE) | reads and updates |
| Ideas boards | **Miladash** (dashboard branch of Milaclone) | lists and links |
| Models, GPU status | **Argos** | Golem chats through it, reads status |
| Agents, mail, notes of record | **Odysseus** | links; optional MCP |
| Host stats | the hosts (Glances or node_exporter) | polls |

Orb never syncs CalDAV itself. ALLGlance is the one CalDAV owner; Orb talks
to its gateway.

## Shape

```
  browser ──▶ orb :8095 ──────────────▶ ALLGlance gateway :8090  (MCP /mcp, REST /api/allglance)
  agents  ──▶   ├─ /api   REST          Argos :8080               (/v1 chat, /api/mcp status)
  (MCP)         ├─ /mcp   MCP           Miladash :4321            (/api/root, /api/canvas, /api/item)
                ├─ web UI (Svelte)      hosts :61208              (Glances API)
                └─ SQLite /data/orb.db
```

- One Go binary serves the API, the MCP endpoint and the built Svelte UI.
- Go 1.26, Svelte 5 + Vite + TypeScript in `ui/`, SQLite, one Docker image.
- Config is `orb.yaml` (apps, integrations, Main layout defaults), mounted at
  `/config/orb.yaml`. Secrets come from the environment, never from the YAML.
- Same container conventions as Milaclone: joins the `edge` network for the
  Cloudflare tunnel and the `ai` network to reach Argos and the gateway.

## Data model (SQLite)

```
projects(id, name, status, next, repo, fav, tasks_ref, updated_at)
  status: next | active | blocked | paused | shipped
  tasks_ref: which ALLGlance/vikunja project holds this project's tasks
logs(id, project_id, text, by, created_at)        -- text <= settings.log_max
notes(id, title, body, updated_at)
plans(id, text, horizon, done)                    -- next | later | someday
upkeep(id, name, every_days, last_done)
events(id, title, date, time)                     -- local only; real ones come from ALLGlance
settings(key, value)                              -- log_max, golem_brain, golem_writes, main_layout
```

`by` records who wrote a log: `you`, `golem`, or the agent token's name.

## REST API

All routes need `Authorization: Bearer <token>`. Tokens are named, so the log
shows which agent wrote what.

```
GET    /api/projects                 list, with open task counts
GET    /api/projects/:id             project, recent logs, tasks
PATCH  /api/projects/:id             status, next, fav
GET    /api/logs?project=&limit=     newest first
POST   /api/logs                     {project, text}   -> 422 if text > log_max
GET    /api/tasks?project=&open=     proxied from ALLGlance
PATCH  /api/tasks/:source/:id        {done: true}      -> passed through to ALLGlance
GET    /api/upkeep  POST /api/upkeep/:id/done
GET    /api/stats                    latest host stats
GET    /api/ideas                    Miladash boards with stage
POST   /api/golem                    {messages} -> streamed reply (SSE)
```

## MCP tools (POST /mcp)

The same actions as the REST API, so any agent (Claude, Odysseus, Argos's
assistant, Home Assistant) can keep the log and close tasks.

| Tool | Does |
| --- | --- |
| `orb_list_projects` | projects with status, next step, open task count |
| `orb_get_project` | one project: recent logs and tasks |
| `orb_add_log` | short log entry for a project (rejects over `log_max`) |
| `orb_list_logs` | logs, filtered by project |
| `orb_move_project` | change board column |
| `orb_list_tasks` | tasks for a project, from ALLGlance |
| `orb_complete_task` | mark a task done in ALLGlance, and log it |
| `orb_list_upkeep` / `orb_upkeep_done` | wards |
| `orb_status` | one-call summary: overdue upkeep, blocked projects, hot hosts |

`orb_complete_task` is the method for "an agent marks the task done": one call
updates the task where it lives (CalDAV through ALLGlance) and writes a log
line such as `Done: test prompt cache` with `by` set to the agent.

## Integrations

### ALLGlance (tasks and calendar)

- Read: `allglance_list_tasks`, `vikunja_list_tasks`, `allglance_list_days`
  (REST mirrors under `/api/allglance/`).
- Map an Orb project to a vikunja project with `tasks_ref`, set on the project
  page or in `orb.yaml`.
- **Gap to close in ALLGlance:** the gateway can create vikunja tasks but not
  update them. Add `vikunja_update_task` (done, due, title) and an
  `allglance_complete_task` that picks vikunja or dayGLANCE
  (`dayglance_set_task_completion`) by source. Orb calls that.

### Argos (Golem)

- Golem's brain: `POST /v1/chat/completions` on Argos with a model from
  `orb.yaml`, using OpenAI-style tool calls. The Go server runs the tool loop,
  using the same tools as the MCP list above.
- Golem's eyes on Argos: `/api/mcp` tools `pool_status`, `requests_in_flight`,
  `recent_requests`, shown on the System tab and given to Golem.
- Fallback brain: none by default. If Argos is down, Golem says so.

### Miladash (ideas)

A branch of Milaclone, cut down for the dashboard:

- one root board, "Ideas", with three columns: Thought, Design, Code;
- each idea is a card that can open its own board for sketching;
- the stage is the column the card sits in, read through `/api/canvas/:id`;
- a "Promote" action on the card calls Orb (`POST /api/projects`) and tags
  the card as promoted;
- styled to match the orb (tokens shared with Orb's UI), with the extra
  Milaclone views (graph, mind map, calendar) switched off.

Orb's Ideas tab lists the cards by stage and opens Miladash for editing; it
does not reimplement the canvas.

### Hosts

Poll Glances (`/api/4/quicklook`, `/api/4/fs`, `/api/4/sensors`) on each host
listed in `orb.yaml` every 30 seconds; keep 24 hours of history for the
sparklines.

### Mail

Out of scope for the first build. Later, read an IMAP folder or Odysseus's
email accounts for messages about the stack.

## orb.yaml

```yaml
log_max: 50
golem:
  brain: argos
  model: qwen3-32b            # any model name Argos serves
  can_write: true
integrations:
  allglance: { url: http://allglance-gateway:8090, token_env: ALLGLANCE_TOKEN }
  argos:     { url: http://argos:8080, token_env: ARGOS_TOKEN }
  miladash:  { url: http://miladash-app:4321, key_env: MILADASH_API_KEY, board: Ideas }
hosts:
  - { name: gpu-box, glances: http://192.168.1.20:61208 }
  - { name: nas,     glances: http://192.168.1.10:61208 }
projects:                     # optional: link projects to their task lists
  - { name: Argos, tasks_ref: vikunja:12 }
groups:
  - name: The Tower
    apps:
      - { name: Odysseus, rune: Od, url: http://homelab.local:7011 }
      - { name: Argos,    rune: Ar, url: http://homelab.local:8080 }
```

## Build order

1. Go server, SQLite, REST API for projects, logs, notes, plans, upkeep;
   port the demo UI to Svelte 5. Docker image and compose file.
2. MCP endpoint with the `orb_*` tools and named tokens.
3. ALLGlance tasks: read, then complete (after the gateway gains
   `vikunja_update_task`).
4. Golem on Argos with the tool loop; Argos status on the System tab.
5. Miladash branch and the Ideas tab.
6. Host stats from Glances.

## Open questions

- Single user, or per-person like ALLGlance's roster?
- Should project logs also be written to the git repo (for example a
  `LOG.md`), or stay in Orb?
- Which Argos model is Golem's default?
