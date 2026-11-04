# Pondering Orb backend design

The claude.ai page is the demo. The real Orb runs as a container on the
homelab, where it can reach CalDAV, the LLMWIKI, Argos, Uptime Kuma and the
hosts. This file is the plan for that container.

## What Orb owns, and what it only reads

Orb is a dashboard and a front door for agents. It owns only what no other
app in the stack already keeps.

| Data | Owner | Orb does |
| --- | --- | --- |
| Projects (board, status, next step, favorite) | **Orb** | stores |
| Project log (short entries, 50 characters by default) | **Orb** | stores |
| Upkeep checks, Main layout, settings | **Orb** | stores |
| Tasks (to-do lists) | **CalDAV server** in the GLANCE stack (vikunja) | reads and updates over CalDAV |
| Notes | **LLMWIKI** (Obsidian vault) | reads, edits sections through the Local REST API |
| Ideas boards | **Miladash** (dashboard branch of Milaclone) | lists and opens; see `miladash.md` |
| Monitors | **Uptime Kuma** | reads its status page API |
| Upstream syncs | **UpstreamManager** | reads its API, shows requests |
| Host and container stats | the hosts | reads `/proc` and the Docker API |
| Models | **Argos** (or a frontier API) | Golem chats through it |

Plans and "open tasks" are the same data: CalDAV to-dos (VTODO). The demo's
old Plans list is gone; it became task lists.

## Shape

```
  browser ─▶ orb :8095 ─┬─▶ CalDAV (vikunja)            VTODO lists
  agents  ─▶  /api REST │─▶ LLMWIKI :27123              Obsidian Local REST API
  (MCP)    ─▶ /mcp      │─▶ Argos :8080 or frontier API Golem's brain
              web UI    │─▶ Uptime Kuma :3001           status page JSON
              SQLite    │─▶ UpstreamManager :5000       /api/repos, /api/requests
                        │─▶ Plex, SABnzbd, ...          live panels
                        └─▶ /host/proc, docker proxy    System tab
```

- One Go binary serves the API, the MCP endpoint and the built web UI.
- Go 1.26 server, SQLite, one Docker image.
- **Web UI: React** (Vite + TypeScript). Two reasons: the Main page needs
  draggable, resizable panels, and `react-grid-layout` (MIT) does that well;
  and React has the most widget and chart libraries for dashboards. The demo
  page stays plain JavaScript and is ported screen by screen.
- Config is `orb.yaml`, mounted at `/config/orb.yaml`. Secrets come from
  environment variables named in the YAML (`token_env`, `key_env`), never
  from the YAML itself, and never reach the browser.
- Networks: `edge` for the Cloudflare tunnel, `ai_net` for Argos, LLMWIKI and
  the gateway, plus whatever network the media apps use.

## Data model (SQLite)

```
projects(id, name, status, next, repo, fav, task_list, wiki_note, updated_at)
  status: next | active | blocked | paused | shipped
  task_list: CalDAV collection for this project's tasks (default: its name)
  wiki_note: e.g. "wiki/1-projects/Pondering Orb.md"
logs(id, project_id, text, by, created_at)     -- text <= settings.log_max
upkeep(id, name, every_days, last_done)
layout(user, panels_json)                      -- react-grid-layout positions
settings(key, value)                           -- log_max, golem, main_lists
cache(source, key, body, fetched_at)           -- last good reply per integration
outbox(id, target, request_json, tries, error) -- writes waiting for a service
```

`by` records who wrote a log: `you`, `golem`, or the agent token's name.

## Tasks over CalDAV

Orb is a plain CalDAV client, so it works with vikunja, Radicale, Nextcloud
or anything else that speaks the standard.

- **Discover lists:** `PROPFIND` the calendar home and keep collections whose
  `supported-calendar-component-set` includes `VTODO`. Each one is a task
  list ("task group").
- **Pick lists:** Settings chooses which lists show on Main and which list
  belongs to each project. The To-do tab can show any mix of lists.
- **Read:** `REPORT calendar-query` with a `VTODO` filter, per list.
- **Complete:** `GET` the `.ics`, set `STATUS:COMPLETED`, `COMPLETED:<now>`,
  `PERCENT-COMPLETE:100`, then `PUT` it back with `If-Match: <etag>`. On a 412
  (someone else changed it), re-read and retry once, then report.
- **Create:** `PUT` a new `VTODO` with a fresh UID into the chosen list.
- Credentials: `CALDAV_USER` and `CALDAV_PASSWORD` (or a token) from the
  environment.

This removes the earlier gap in the ALLGlance gateway (no update tool): Orb
talks CalDAV directly to the server the GLANCE apps already sync with.

## LLMWIKI (notes)

The vault lives in the `LLMWIKI` container on `ai_net`. Orb only uses the
Obsidian Local REST API and never touches vault files (direct writes leave
files owned by root, which breaks the API for other agents).

- Base URL `http://LLMWIKI:27123`, `Authorization: Bearer` key from
  `WIKI_API_KEY`. Never logged, never written to a note.
- **Read** a project note: `GET /vault/<path>` with
  `Accept: application/vnd.olrapi.note+json` for parsed front-matter.
- **Edit** only the sections Orb shows, "Current state" and "Next steps":
  `PATCH /vault/<path>` with `Operation: replace`, `Target-Type: heading`,
  `Target: <heading>`. Never rewrite a whole note.
- **Front-matter:** set `updated` to today on every change. `status` (note
  quality) is never changed by Orb; `project_status` follows the board:

  | Orb board | wiki `project_status` |
  | --- | --- |
  | next, active, blocked | active |
  | paused | paused |
  | shipped | done, and the note moves to `wiki/4-archive/` |

  Moving a note means `PUT` at the new path, then `DELETE` the old one, then
  update `projects.wiki_note`.
- **Log every write** with `POST /vault/wiki/logs/Log - YYYY-MM-DD.md`
  (append; the API creates the file if it is missing).
- Only approved tags, never anything under `raw/`.
- **Wiki down:** reads come from `cache` with a "stale since" note; writes go
  to `outbox` and show as pending on the note until they succeed. Nothing is
  dropped silently.
- **Golem** also gets the vault's MCP endpoint (`POST /mcp/`, session
  handshake) with `query_wiki`, `get_wiki`, `wiki_card` and `search_*`, read
  only.

## Main page panels

Every Main panel is a module: built-in ones (Golem, favorite projects, open
tasks, upkeep, uptime, log, calendar) and one per app or app group from
`orb.yaml`. Panels can be added, moved and resized; positions are saved per
user.

**Live app panels** come from small adapters in the Go server. Each adapter
polls its app, keeps the last result in `cache`, and serves the browser a
small JSON shape. The browser never sees an app's key.

| `widget.type` | Calls | Shows |
| --- | --- | --- |
| `plex` | `GET /status/sessions` with `X-Plex-Token` | who is watching what, progress |
| `sabnzbd` | `GET /api?mode=queue&output=json&apikey=` | speed, time left, queue |
| `upstreammanager` | `GET /api/repos`, `GET /api/requests` | repos behind upstream, requests waiting |
| `uptimekuma` | status page API (below) | monitors up or down |

New types are one Go file each; Homepage's widget list is a good backlog
(Sonarr, Radarr, qBittorrent, Proxmox, Home Assistant).

## UpstreamManager

UpstreamManager is its own app with its own page; Orb's Upkeep tab is a
separate, simpler list of recurring chores. They connect through
UpstreamManager's JSON API on port 5000:

- `GET /api/repos` and `GET /api/requests` feed the UpstreamManager panel;
- `POST /api/request/<id>/decide` lets Orb approve or reject a request;
- `POST /api/run-daily` can be the action behind an "Upstream sync" upkeep
  check, which Orb then stamps as done.

The API has no login of its own, so Orb reaches it on the internal network
only and never exposes it through the tunnel.

## Uptime

Run Uptime Kuma as its own container and read it; don't copy its code into
Orb. It is MIT, so copying is allowed, but it is a full Node app with its own
database and Socket.io API, and a fork would have to be kept up to date by
hand. As a separate container it keeps getting upstream fixes (and
UpstreamManager can track it).

- Publish one status page in Uptime Kuma (for example slug `orb`).
- Orb reads `GET /api/status-page/orb` (monitor list and groups) and
  `GET /api/status-page/heartbeat/orb` (recent beats and uptime), both public
  once the page is published.
- Optional: `/metrics` with an API key for response times.
- The Uptime tab shows groups, heartbeat bars and 24-hour uptime; a compact
  version is a Main panel.

## System (btop style)

btop is a terminal app (C++, Apache-2.0), so its code can't run in a web
page. Two options, and Orb can offer both:

1. **Native page (default).** Orb reads the host's `/proc` (mount
   `/proc:/host/proc:ro`) for per-core CPU, memory, load and network, and
   mounted paths for disks. Containers come from the Docker API. The page
   copies btop's layout: boxed panels, per-core meters, process and container
   table.
2. **Real btop.** A sidecar running `ttyd` with btop (`pid: host`) serves a
   web terminal that the System tab embeds. Exactly btop, but read-only
   viewing only.

Don't mount `/var/run/docker.sock` into Orb directly: it gives root on the
host. Put `docker-socket-proxy` in between with read-only access
(`CONTAINERS=1`, `INFO=1`, everything else off) and point Orb at the proxy.

## Golem

Settings picks the brain:

- **Local, OpenAI-compatible:** a base URL (Argos `http://argos:8080/v1`,
  llama-server, Ollama) and a model name.
- **Frontier:** OpenRouter (OpenAI-compatible, `https://openrouter.ai/api/v1`)
  or the Claude API (`https://api.anthropic.com/v1`, Messages API), with a
  model name and the env var that holds the key.

The Go server runs the tool loop with the same tools as the MCP list below,
plus the LLMWIKI MCP tools (read only) and Argos's `/api/mcp` status tools.

## REST API

All routes need `Authorization: Bearer <token>`. Tokens are named, so the log
shows which agent wrote what.

```
GET    /api/projects                 list, with open task counts
GET    /api/projects/:id             project, recent logs, tasks, wiki sections
PATCH  /api/projects/:id             status, next, fav, task_list, wiki_note
GET    /api/logs?project=&limit=     newest first
POST   /api/logs                     {project, text}  -> 422 if text > log_max
GET    /api/task-lists               CalDAV lists that hold VTODOs
GET    /api/tasks?list=&open=        tasks from one or more lists
POST   /api/tasks                    {list, title, due}
PATCH  /api/tasks/:list/:uid         {done: true}  -> CalDAV PUT with If-Match
GET    /api/wiki/:path               note sections (cached when the wiki is down)
PATCH  /api/wiki/:path/:heading      replace one section
GET    /api/widgets/:app             live panel data
GET    /api/uptime   GET /api/system
POST   /api/golem                    {messages} -> streamed reply (SSE)
```

## MCP tools (POST /mcp)

| Tool | Does |
| --- | --- |
| `orb_list_projects` / `orb_get_project` | projects; one project with logs, tasks, wiki sections |
| `orb_add_log` / `orb_list_logs` | short log entries (rejects over `log_max`) |
| `orb_move_project` | change board column (and wiki `project_status`) |
| `orb_list_task_lists` / `orb_list_tasks` | CalDAV lists and their tasks |
| `orb_add_task` / `orb_complete_task` | create or close a task over CalDAV; closing also logs it |
| `orb_update_wiki_section` | replace "Current state" or "Next steps" |
| `orb_list_upkeep` / `orb_upkeep_done` | upkeep checks |
| `orb_status` | one call: overdue upkeep, blocked projects, down monitors, hot hosts |

`orb_complete_task` is how an agent marks work done: one call closes the
VTODO where it lives and writes a log line like `Done: test prompt cache`,
with `by` set to the agent.

## orb.yaml

```yaml
log_max: 50
golem:
  provider: local                       # local | frontier
  local:    { base_url: http://argos:8080/v1, model: "" }
  frontier: { service: openrouter, base_url: https://openrouter.ai/api/v1, model: "", key_env: OPENROUTER_API_KEY }
  can_write: true
caldav:
  url: http://vikunja:3456/dav/
  user_env: CALDAV_USER
  password_env: CALDAV_PASSWORD
  main_lists: [Homelab, Pondering Orb]
wiki:
  base_url: http://LLMWIKI:27123
  token_env: WIKI_API_KEY
uptime:
  base_url: http://uptime-kuma:3001
  status_page: orb
system:
  proc: /host/proc
  docker: tcp://docker-proxy:2375
projects:
  - { name: Pondering Orb, task_list: Pondering Orb, wiki_note: "wiki/1-projects/Pondering Orb.md" }
groups:
  - name: Media
    apps:
      - name: Plex
        url: http://plex:32400/web
        widget: { type: plex, url: http://plex:32400, key_env: PLEX_TOKEN }
      - name: SABnzbd
        url: http://sabnzbd:8085
        widget: { type: sabnzbd, url: http://sabnzbd:8085, key_env: SABNZBD_API_KEY }
```

Check the CalDAV URL against your vikunja version; the path differs between
servers.

## Build order

1. Go server, SQLite, projects, logs and upkeep; React UI with the Main grid;
   Docker image and compose file.
2. CalDAV tasks: lists, read, complete, create.
3. LLMWIKI: project note sections, status mapping, log lines, outbox.
4. MCP endpoint and named tokens.
5. Golem with both provider types.
6. Live panels: UpstreamManager, Plex, SABnzbd; Uptime Kuma tab.
7. System tab from `/proc` and the Docker proxy; optional btop sidecar.
8. Miladash and the Ideas tab (see `miladash.md`).

## Open questions

- Single user, or per-person like ALLGlance's roster?
- Which CalDAV server and path holds the task lists today?
- Which tags are on the vault's approved list for project notes?
- Should Main layouts be per device (phone vs desktop) or one layout?
