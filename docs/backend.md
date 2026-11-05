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

- One Node.js process (`server/`, TypeScript, Fastify) serves the API, the
  MCP endpoint and the built web UI (`web/`). Node 22's built-in SQLite holds
  Orb's data; there are no native modules. One Docker image.
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

Orb's own records are JSON documents grouped by collection, the same shapes
the demo page used, so the web app ported screen by screen:

```
docs(coll, id, data JSON, version, updated_at)
  projects  name, status (next|active|blocked|paused|shipped), next, repo, fav,
            archived, area, taskList, wikiNote, upstreamRepo, logCommits,
            lastLoggedSha, chats[]
  logs      date, project, text (<= logMax), by, sha, created
  tasks     title, list, due, done, doneAt, doneBy, priority (0-9), caldav{}
  chores    name, everyDays, lastDone, due, caldav{}
  canvas    the Ideas board's cards;  edges  its arrows
  events    calendar events kept in Orb
  layouts   one per page: react-grid-layout positions per screen size,
            hidden and removed panels
  settings  "app" (logMax, golem, connections, theme, links, splitRatio,
            mainLists, pageWidth, golemFont) and "apps" (the apps YAML)
sessions(token, created_at)                     -- web sign-in sessions
```

`tasks.caldav` / `chores.caldav` hold the href, etag, UID and the VTODO text,
so a write keeps every property Orb doesn't manage. Writes go through one
place (`server/src/records.ts`), which checks them and sends each change to
open browsers over `/api/stream`.

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
  (someone else changed it), Orb pulls the list and queues the write in the
  outbox, which retries it with the new etag. Only the master VTODO is
  edited (recurrence exceptions are left alone), a DUE with a time keeps its
  time, and an edit that changes none of these fields writes nothing.
- **Move:** changing a task's list creates it in the new list and deletes the
  old copy.
- **Create:** `PUT` a new `VTODO` with a fresh UID into the chosen list.
- **Priority:** the standard `PRIORITY` property (RFC 5545), shown as vikunja's
  five levels with vikunja's own mapping (Low 9, Medium 5, High 3, Urgent 2,
  Do now 1). See `allglance.md`.
- Credentials: `CALDAV_USER` and `CALDAV_PASSWORD` (or a token) from the
  environment.

This removes the earlier gap in the ALLGlance gateway (no update tool): Orb
talks CalDAV directly to the server the GLANCE apps already sync with.

### Chores

Chores are recurring to-dos in one CalDAV list (`caldav.chores_list`,
default "Chores"), so the GLANCE apps and phones see them too.

- Each chore is a `VTODO` with `RRULE` (for example `FREQ=DAILY;INTERVAL=7`)
  and a `DUE` date. "Every N days" in Orb maps to that rule.
- **Done** rolls the chore forward: Orb moves `DUE` to one interval after
  today and `DTSTART` to today, and keeps `STATUS:NEEDS-ACTION` (it doesn't
  write `COMPLETED`). The PUT carries `If-Match` like any other task update.
- Overdue and due-soon colours come from `DUE`. A Chores panel can sit on
  Main as well as the Upkeep tab.

### Task lists on the Ideas board

A **Tasks** card on the board shows one CalDAV list live (tick, add) next to
the ideas it belongs to. A **To-do** card is a checklist that lives only on
the board.

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
  to unlink or swap sides. Drag the bar between the halves to resize them
  (20 to 80 percent; double-click resets to half); the split is saved per
  link. Each half keeps its own panel layout. On narrow
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

**Live app panels** come from small adapters in the server. Each adapter
polls its app, keeps the last result in `cache`, and serves the browser a
small JSON shape. The browser never sees an app's key.

| `widget.type` | Calls | Shows |
| --- | --- | --- |
| `plex` | `GET /status/sessions` with `X-Plex-Token` | who is watching what, progress |
| `sabnzbd` | `GET /api?mode=queue&output=json&apikey=` | speed, time left, queue |

New types are one file each; Homepage's widget list is a good backlog
(Sonarr, Radarr, qBittorrent, Proxmox, Home Assistant).

## UpstreamManager (the Upkeep tab)

UpstreamManager runs on another computer. Orb talks to its JSON API over the
LAN; Orb's own chore list stays as one panel on the same tab.

| Panel | Call | Notes |
| --- | --- | --- |
| Repositories | `GET /api/repos` | per repo: `focus_branch`, `behind`, `ahead`, `conflicts`, `upstream_details`, `components`, `last_commit`, `dirty`, `error` |
| Approval requests | `GET /api/requests` | `type` (merge, components, push, actions), `upstreams[]` with `behind` and `reason`, `safe`, `status` |
| Approve / Deny | `POST /api/request/<id>/decide` | body `{"decision": "approve" \| "deny", "comment": "..."}`; 409 if already decided |
| Daily check | `POST /api/run-daily` | returns `results[]` with `status` merged, request_raised or error |
| Fetch | `POST /api/repo/<id>/fetch` | returns a merge `plan` |
| Project commits | `GET /api/repo/<id>/commits?view=all&limit=50` | items `{full, sha, date, author, subject}` |

Orb calls these from its server, never from the browser. Every POST must
send `Content-Type: application/json`, because UpstreamManager refuses
anything else to block cross-site requests. Server-to-server calls carry no
`Origin` header, so they pass that check.

**Reaching it on another computer.** UpstreamManager has no login and can run
git, so it listens on `127.0.0.1` unless told otherwise. On that computer:

1. start it with `HOST=0.0.0.0` (and `PORT` if not 5000);
2. allow port 5000 only from the Orb host in the firewall, for example
   `ufw allow from <orb-ip> to any port 5000 proto tcp`;
3. never publish it through the Cloudflare tunnel.

If you put a reverse proxy in front of it, add the proxy's host to
`UPSTREAM_ALLOWED_HOSTS` and let Orb send the proxy's auth header (set
`upstream.header_env` in `orb.yaml`).

### Where Fetch and the daily check run

Everything git-related runs **inside UpstreamManager, on its own computer,
against its own clones**. Orb never touches those folders and needs no file
share (no SMB or NFS). Fetch is an HTTP call: Orb sends
`POST /api/repo/<id>/fetch`, UpstreamManager runs `git fetch` locally and
answers with the merge plan (behind, ahead, conflicts), and Orb shows that.
The same goes for the daily check, approvals and commit lists. A shared
folder would be worse: Orb would need git, the paths would differ between
machines, and two programs would be writing the same repos.

### Approving part of a request

- **Component updates** (`type: components`, a `components` list) can be split
  today: Orb denies the request, raises a new one for just the ticked
  components with `POST /api/repo/<id>/components/request {"names": [...]}`,
  and approves that.
- **Merges with several upstreams** need a small UpstreamManager change:
  accept `{"decision": "approve", "only": ["upstream-name"]}` in
  `/api/request/<id>/decide`, run only those merges, and leave a new pending
  request for the rest.
- Each request links to UpstreamManager's Requests page and, when the repo has
  a GitHub remote (`GET /api/repo/<id>/publish` gives `owner` and
  `github_repo`), to its pull requests on GitHub.


### Linking a project to a repo

A project can be linked to one UpstreamManager repo (`projects.upstream_repo`).
Then:

- the project page shows the repo's branch, behind/ahead and recent commits;
- the board card shows a ↓N chip when upstream has new commits;
- with **Log new commits** on, Orb polls `GET /api/repo/<id>/commits` every
  15 minutes and writes each new commit as a log entry: its subject cut to
  `log_max`, `by: git`, the short sha kept with it. `projects.last_logged_sha`
  stops it logging a commit twice.

## Hermes Studio chats

A project can link any number of chats (`projects.chats`, a list of session
ids). Orb reads them from Hermes Studio, which already lists both its own
chats and Hermes Agent's native sessions, so one connection covers both.

| Use | Call |
| --- | --- |
| Sign in | `POST /api/auth/login` with `{username, password}` from `HERMES_USER` / `HERMES_PASSWORD`; returns a JWT. Orb keeps it and signs in again when it expires (`HERMES_WEB_UI_AUTH_JWT_EXPIRES_IN` on the Studio side). |
| Studio chats | `GET /api/studio/sessions?limit=50&offset=0` → `{sessions: [{id, title, source, agent, model, messageCount, startedAt, ...}]}` |
| Hermes Agent sessions | `GET /api/studio/sessions/hermes?limit=50` |
| Search | `GET /api/studio/search/sessions?q=...` |
| One chat | `GET /api/studio/sessions/<id>` → `{session}` |

Requests send `Authorization: Bearer <jwt>`. Use a dedicated Studio user for
Orb so its access can be limited and revoked.

The project page's Chats panel shows linked chats (title, agent, model,
message count, last active) and searches the rest to link more. Later, Golem
can read a linked chat (read only) to answer "what did we decide about X".

## Uptime

Uptime Kuma is in `docker-compose.example.yml` behind a profile: it only
starts with `docker compose --profile uptime up -d`. If you already run one,
leave the profile off and set `UPTIME_URL`. Read it; don't copy its code into
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
   viewing only. Start it with `docker compose --profile btop up -d`
   (built from `docker/btop`) and set Settings → btop terminal to
   `http://<host>:7681`.

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

The server runs the tool loop with the same tools as the MCP list below,
plus the LLMWIKI MCP tools (read only) and Argos's `/api/mcp` status tools.

## REST API

People sign in with `ORB_PASSWORD` (an HttpOnly cookie that lasts 30 days);
agents send `Authorization: Bearer <token>` from `ORB_API_TOKENS`. Tokens are
named, so the log shows which agent wrote what. Only `/api/health`,
`/api/login` and `/api/logout` are open. Writes must be JSON, and writes from
another site (a different `Origin`) are refused.

```
GET    /api/health                   version and sign-in mode (open)
POST   /api/login  /api/logout       {password}
GET    /api/me                       who you are
GET    /api/c/:coll[/:id]            records: projects, logs, tasks, chores, canvas,
POST   /api/c/:coll                    edges, events, layouts, settings, chats
PUT    /api/c/:coll/:id              (If-Match: "<version>" on PATCH)
PATCH  /api/c/:coll/:id
DELETE /api/c/:coll/:id
GET    /api/stream                   SSE: every record change
GET    /api/config                   settings as the server sees them (no secrets)
POST   /api/connections/test/:id     test a connection
GET    /api/caldav/status            lists, last sync, last error
POST   /api/caldav/sync              pull now
POST   /api/chores/:id/done          mark done (runs its action first)
GET    /api/wiki/tree                notes with front-matter
GET    /api/wiki/note?path=          one note
GET    /api/wiki/search?q=
POST   /api/wiki/section             {path, heading, text}  Current state / Next steps
POST   /api/wiki/project             {projectId, area}  new note from the template
POST   /api/wiki/related             {path, titles}  add related links
POST   /api/wiki/digest              {date?}  write a day's digest line
GET    /api/upstream/repos | requests | repo/:id/commits
POST   /api/upstream/repo/:id/fetch | run-daily | request/:id/decide | poll
GET    /api/uptime   GET /api/system   GET /api/hermes/sessions
GET    /api/widgets/:app             live panel data
POST   /api/golem                    {messages} -> {text, did}
POST   /api/golem/stream             {messages} -> SSE: text, tool, done, error
GET    /api/outbox                   writes waiting to retry
POST   /api/outbox/retry             retry them now
DELETE /api/outbox/:id               drop one
```

Agents can't write `settings` (only a signed-in person can), can't set a
task's `caldav` sync fields, and their logs always carry their own name in
`by`.

## MCP tools (POST /mcp)

| Tool | Does |
| --- | --- |
| `orb_list_projects` / `orb_get_project` | projects; one project with its recent logs and tasks |
| `orb_add_log` / `orb_list_logs` | short log entries (rejects over `log_max`) |
| `orb_move_project` | change board column (and wiki `project_status`) |
| `orb_list_tasks` / `orb_add_task` | tasks, from CalDAV lists or Orb-only lists |
| `orb_set_task_priority` / `orb_complete_task` | change priority; close a task (also logs it) |
| `orb_list_chores` / `orb_chore_done` | chores and when they are due |

Golem has these plus read-only `wiki_search`, `wiki_read` and
`project_chats` (and the ALLGlance tools when that gateway is set).

`orb_complete_task` is how an agent marks work done: one call closes the
VTODO where it lives and writes a log line like `Done: test prompt cache`,
with `by` set to the agent.

## orb.yaml

See `config/orb.example.yaml` for every key. A value in orb.yaml beats the
same address passed as an environment variable. Golem can be flat
(`base_url`, `model`, `key_env`, `can_write`) or have a block per provider:

```yaml
golem:
  provider: local                       # local | frontier
  local:    { base_url: http://argos:8080/v1, model: "" }
  frontier: { base_url: https://openrouter.ai/api/v1, model: "", key_env: OPENROUTER_API_KEY }
  can_write: true                       # applies to both
```

Apps, app groups and live widgets are not in orb.yaml: they live in
Settings → Apps (YAML), for example:

```yaml
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

`key_env` (and every `*_env` in Settings) must be a plain upper-case variable
name and can't be one of Orb's own (`ORB_*`).

Check the CalDAV URL against your vikunja version; the path differs between
servers. The Obsidian Local REST API's plain-HTTP port (27123) is off by
default in the plugin; turn it on, or use the HTTPS port.

## Build status

Done in `server/` and `web/` (see the README for running it):

1. Node server, SQLite, records API with checks and live updates; React app
   with the panel grid (drag, resize, hide, remove, add per page), linked
   tabs with a slider, themes; Dockerfile and compose file.
2. CalDAV: task lists and chores pulled every 5 minutes and on "Sync now";
   done, priority, title, due, new tasks and chore Done written back with
   If-Match.
3. LLMWIKI: tree and notes from the read-only mount (or REST), section
   edits, `project_status` following the board, new project notes from the
   PROJECT template linked from the area hub, log lines.
4. MCP endpoint (`POST /mcp`) and named tokens.
5. Golem over any OpenAI-compatible endpoint, with the same tools.
6. UpstreamManager (requests with partial approval, daily check, fetch,
   commits logged per project) and Uptime Kuma.
7. System from `/proc` and the Docker socket proxy.
8. The Ideas board in the Milaclone style (cards, columns, nested boards,
   arrows, to-do and Tasks cards).

9. A retry queue (outbox) for CalDAV pushes and background wiki writes: a
   failed write waits and retries every 2, 4, 8 … up to 60 minutes. The
   header shows a "waiting to sync" pill; Settings lists the queue with
   Retry now and Drop.
10. CalDAV discovery: with only the server URL set, Orb finds the task lists
    through `current-user-principal` and `calendar-home-set`.
11. Live panels for Plex (now playing) and SABnzbd (queue), from an app's
    `widget:` in the apps YAML. Keys come from the env var named in
    `key_env`.
12. Golem streams its reply, can be stopped, and reads (never writes) the
    wiki (`wiki_search`, `wiki_read`) and a project's linked Hermes chats.
13. Wiki `related` links from a project's note panel (add only).
14. Chores can run UpstreamManager's daily check when marked done.
15. Daily digest: an optional line in the day's wiki log summing up Orb's
    log entries (Settings → Daily digest).
16. Containers show CPU and memory; real btop through the `btop` compose
    profile (ttyd, read only), embedded on the System tab.
17. Panels without a saved size open at the height of their content.

Not done, on purpose:

- Mail: dropped for now; the demo's Mail room is kept on the `mail` branch.
- Writing tasks through to dayGLANCE and other ALLGlance work: waiting on
  ALLGlance, which is still being tested.
- Several users with their own logins and layouts: Orb is single user.
- Miladash itself lives in `milaclone-mcp` (see docs/miladash.md); the Ideas
  tab is Orb's own board.

## Open questions

- Single user, or per-person like ALLGlance's roster?
- Which CalDAV server and path holds the task lists today?
- Hub note titles for the other areas (automation, hardware, ttrpg, ...).
- Should Main layouts be per device (phone vs desktop) or one layout?
