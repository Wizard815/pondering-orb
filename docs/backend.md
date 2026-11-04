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
  agents  ─▶  /api REST │─▶ llmwiki :27123              Obsidian Local REST API
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
- Networks: `edge` for the Cloudflare tunnel, `ai_net` for Argos, llmwiki and
  the gateway, plus whatever network the media apps use.

## Data model (SQLite)

```
projects(id, name, status, next, repo, fav, archived, task_list, wiki_note, updated_at)
  status: next | active | blocked | paused | shipped
  task_list: CalDAV collection for this project's tasks (default: its name)
  wiki_note: e.g. "wiki/1-projects/Pondering Orb.md"
logs(id, project_id, text, by, created_at)     -- text <= settings.log_max
upkeep(id, name, every_days, last_done)
layouts(user, page, items_json)                -- per page: [{panel, w, h, hidden}]
settings(key, value)                           -- log_max, golem, main_lists, links, theme, connections
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

The vault lives in the `llmwiki` container. Orb is on `ai_net`, so it uses
`http://llmwiki:27123` (agents on Codebox, such as Hermes, use the LAN URL
`http://192.168.20.5:27123` instead). Orb only uses the Obsidian Local REST
API and never touches vault files: direct writes leave files owned by root,
which breaks the API for other agents. Orb never commits; the Obsidian Git
plugin commits every 10 minutes.

- **Auth:** `Authorization: Bearer` key from `WIKI_API_KEY`. Never logged,
  never written to a note.
- **Read** a note: `GET /vault/<path>` (URL-encode spaces) with
  `Accept: application/vnd.olrapi.note+json` for parsed front-matter. The
  parser must accept quoted and unquoted `title` values.
- **Edit** only "Current state" and "Next steps": `PATCH /vault/<path>` with
  `Operation: replace`, `Target-Type: heading` and a full heading path such
  as `Pondering Orb::Current state`. Template-built notes have the H1 equal to
  the title, but Orb reads the note's headings first and uses the real path,
  because hand-written notes can differ.
- **Front-matter on every change:** `updated` = today. `status` (note
  quality) is never touched by Orb.
- **`project_status` follows the board:** next, active and blocked map to
  `active`; paused maps to `paused`; shipped maps to `done`. Orb only sets
  `done`. It does not move the note: the vault's maintain workflow moves done
  projects to `4-archive/`. Note names are unique, so `[[links]]` survive.
- **Tags:** one type tag matching `type` (project, area, resource, log,
  source), `wiki` on everything under `wiki/`, and an optional domain tag from
  raidlab, ai, ttrpg, homelab. Nothing else; other domains use `area:` only.
- **`source`:** `manual` for notes the user asked Orb to create;
  `live-check YYYY-MM-DD` for facts Orb checked against a running system.
  Never a new value (lint checks it).
- **New projects:** adding a project with an area creates
  `wiki/1-projects/<Name>.md` from the PROJECT template (`type: project`,
  `project_status`, `status: draft`, `source: manual`, `related: []`) and adds
  `- [[Name]]` under `## Projects` in that area's hub note. Orb asks for the
  area (homelab, ai, automation, hardware, ttrpg, gaming, travel, personal,
  knowledge); it never guesses. Hub names come from `wiki.area_hubs`.
- **Linking existing notes:** an exact name match links automatically and
  shows the result; close matches (shared words) are only suggestions; a
  picker allows a manual choice. Today's project notes are outcome-named
  (for example "Plex Media Conversion Pipeline"), so most Orb projects will
  need the picker once.
- **`related`:** Orb may add `[[links]]` to other project notes that exist;
  it never removes entries and skips links that don't resolve.
- **Log:** every write appends a bullet to `wiki/logs/Log - YYYY-MM-DD.md`
  under `## Pondering Orb`, such as `- [[Argos]]: edited Next steps`. If the
  file is missing, Orb creates it from the LOG template (`type: log`,
  `tags: [wiki, log]`, `source: ""`). Orb's own short project logs are not
  mirrored; an optional daily digest bullet ("Orb: 4 log entries on
  [[Pondering Orb]]") can be turned on in Settings.
- **Never** anything under `raw/`, and never secrets in a note.
- **Reading the whole vault:** mount the vault folder into Orb **read only**
  (for example `/mnt/user/appdata/llmwiki/vault:/vault:ro`). Orb indexes every
  `.md` file there, including `raw/`, `schema/` and `logs/`, for the Wiki tab:
  folder tree, full-text search, tags, backlinks and front-matter. Obsidian's
  own data (`.obsidian/`) is skipped. The mount is only for reading; every
  write still goes through the REST API, so file ownership and the vault rules
  stay intact. A file watcher refreshes the index when other agents change
  notes.
- **Wiki down:** reads come from `cache` with a "stale since" note; writes go
  to `outbox` and show as pending until they succeed. Nothing is dropped
  silently.
- **Golem** gets the vault's MCP endpoint (`POST /mcp`, session handshake),
  limited to read tools: `query_wiki`, `get_wiki`, `wiki_card`,
  `search_simple` and the read-side `vault_*` tools. All writes go through
  Orb so the rules above hold.

## Pages and panels

Every page is a set of panels on a 12-column grid, and every page has an
**Edit layout** mode: add and remove panels, hide and show them, move them by
dragging, and resize them from the corner (width in columns, height snapped to
40 px or automatic). Each page keeps its own layout, so System can put a
44-core CPU panel full width at the bottom while Main stays compact. On a
phone every panel is full width.

Main's panels are built-in modules (Golem, favorite projects, open tasks,
upkeep, uptime, log, calendar) plus one per app and one per app group from
`orb.yaml`. System has three panels per host: CPU (per-core meters), memory
and disks, and containers.

How editing works:

- **Move:** drag a panel by its title.
- **Resize:** drag the corner.
- **Right-click a panel** (long-press on touch): hide or show, fit height to
  content, full or half width, remove.
- **Right-click empty space:** add any panel that isn't on the page, or reset
  the page.
- **Linked pages:** drag one tab onto another to show both side by side under
  one tab ("Projects / To-do"). The link is saved; right-click the joined tab
  to unlink or swap sides. Each half keeps its own panel layout. On narrow
  screens the halves stack.

In the React build this is `react-grid-layout`; the demo has its own small
version with the same behaviour.

## Projects

- **New project** opens a small form: name, next step, column, and "Create a
  note in the wiki" with a required area.
- **Quick log:** type an entry and press Log it; a popup asks which project
  (most recent first), with "+ New project" to create one on the spot. The
  dropdown above the log is only a filter.
- **Archive** hides a project from the board, Main and pickers; "Show
  archived" brings it back into view. The wiki note is not touched.
- **Delete** removes the project from Orb after a confirm. Its log entries
  and wiki note stay; Orb never deletes wiki notes.

## Appearance

Themes are token sets: Follow device (Night tower in dark mode, Parchment in
light), Night tower, Parchment, Arcane library, Ember forge and Frost spire.
"Customize colours" edits nine tokens on top of any preset. Saved in
`settings.theme`.

## Connections

Settings has one form per service (Uptime Kuma, LLMWIKI, CalDAV,
UpstreamManager) with its address, the names of the environment variables
that hold its secrets, and a **Test** button. Test runs from the server:

| Service | Test |
| --- | --- |
| Uptime Kuma | `GET /api/status-page/<slug>` and `/heartbeat/<slug>`, lists monitors |
| LLMWIKI | `GET /` with the key, and checks the vault mount has `.md` files |
| CalDAV | `PROPFIND`, lists collections that hold VTODOs |
| UpstreamManager | `GET /api/repos` and `/api/requests` |

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
  base_url: http://llmwiki:27123
  token_env: WIKI_API_KEY
  daily_digest: false
  area_hubs: { homelab: Homelab, ai: Local AI }   # area -> hub note title
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
- Hub note titles for the other areas (automation, hardware, ttrpg, ...).
- Should Main layouts be per device (phone vs desktop) or one layout?
