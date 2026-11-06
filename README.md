# Pondering Orb

A homelab command center: what you are working on, a project log, plans,
upkeep checks, system stats, and links into the rest of the stack.

Tabs (each one a room of the tower):

- **Edit layout** on every page: add, remove, hide, move and resize panels
- **Main**: modular panels; Golem, favorite projects, open tasks, uptime,
  the log, and one panel per app or app group, with live views for Plex,
  SABnzbd and UpstreamManager
- **Projects**: kanban board and log; each project has a page with its
  tasks, log and wiki note
- **Ideas**: a Milaclone-style board with cards, columns, nested boards and
  arrows (a preview of Miladash)
- **To-do**: CalDAV-style task lists; pick which lists to show
- **Wiki**: preview of the LLMWIKI vault (PARA folders, section edits)
- **Upkeep**: UpstreamManager's repos, approval requests and daily check,
  plus your chores
- **Calendar**
- **Uptime**: monitors as Uptime Kuma reports them
- **System**: btop-style cores, memory, disks and containers
- **Settings**: Golem's model endpoint, task lists on Main, log length,
  Main layout, apps YAML

Star a project to put it in Favorites on Main. Log entries are short: 50
characters by default.

## Golem

The dashboard assistant on the Main tab. It reads projects, logs, ideas and
upkeep, and when allowed it adds logs, plans and ideas and moves project
cards. In the demo it thinks with Claude. In the container it uses a local
OpenAI-compatible endpoint (such as Argos) or a frontier API (OpenRouter or
the Claude API), chosen in Settings.

## orb.yaml

```yaml
groups:
  - name: The Tower
    apps:
      - name: Argos
        rune: Ar
        url: http://homelab.local:8080
        description: Local models, GPU scheduler
        links:
          - label: Models
            url: http://homelab.local:8080/v1/models
        live:            # reserved for data a connector will feed
          source: n8n
          workflow: argos-status
```

## Running it

The app is two parts in one repo:

- `server/`: Node.js 22 + TypeScript + Fastify, with Node's built-in SQLite.
  It holds Orb's records, talks to your other apps, runs Golem, and serves the
  MCP endpoint and the web app.
- `web/`: React 18 + Vite + TypeScript.

`demo/index.html` is the original single-page demo (a claude.ai artifact). It
is kept for history only; the React app is the reference now and has moved on
from it.

### With Docker

```bash
cp config/orb.example.yaml config/orb.yaml   # addresses of your apps
cp docker-compose.example.yml docker-compose.yml
cp .env.example .env                           # time zone, password, keys
mkdir -p data && sudo chown 1000:1000 data       # Orb runs as uid 1000 and keeps orb.db here
docker compose up -d --build
```

The compose file joins two networks you may not have (`proxynat` for a
tunnel, `ai_net` for Hermes, Argos and LLMWIKI). Create them with
`docker network create <name>`, or remove them from the `orb` service. Change
the vault path to your own LLMWIKI vault folder. `ORB_PASSWORD` must be set
in `.env`; compose refuses to start without it.

Open `http://<host>:8095`. Settings and secrets go in `.env` next to the
compose file (start from `.env.example`):

| Variable | What it is |
| --- | --- |
| `TZ` | your time zone, e.g. `America/Chicago` (default `UTC`). Every container gets it; it decides what "today" is for logs, chores, the digest and the wiki log. Settings → Logs shows the zone in use. |
| `ORB_PASSWORD` | sign-in password for the web app |
| `ORB_API_TOKENS` | `name:token` pairs for agents and `/mcp`, e.g. `hermes:abc,claude:def` |
| `CALDAV_USER`, `CALDAV_PASSWORD` | CalDAV account |
| `WIKI_API_KEY` | Obsidian Local REST API key |
| `HERMES_USER`, `HERMES_PASSWORD` | a Hermes Studio user for Orb |
| `ALLGLANCE_TOKEN` | the ALLGlance gateway's `GATEWAY_TOKEN` |
| `OPENROUTER_API_KEY` (or any name) | frontier model key, named in Settings → Golem |
| `PLEX_TOKEN`, `SABNZBD_API_KEY` (or any name) | keys for live app panels, named by `key_env` in the apps YAML |
| `UPSTREAM_URL`, `ALLGLANCE_URL` | addresses of apps on other computers |
| `BTOP_AUTH` | optional `user:password` for the btop terminal |

With neither `ORB_PASSWORD` nor `ORB_API_TOKENS` set, Orb is open to anyone
who can reach the port. That is only for a private LAN, and the server warns
about it when it starts.

`docker compose up` starts only Orb and a read-only Docker socket proxy. Apps
you already run (Hermes Studio, Argos, LLMWIKI, UpstreamManager, CalDAV,
Uptime Kuma) are reached by address. A bundled Uptime Kuma starts only with
`docker compose --profile uptime up -d`, and real btop as a web terminal for
the System tab with `docker compose --profile btop up -d`.

### For development

```bash
npm install
npm run dev        # server on :8095 (restarts on change), web on :5173 with the API proxied
npm test           # server tests and the web type check
npm run build      # server/dist and web/dist
```

### For agents (MCP)

`POST /mcp` with `Authorization: Bearer <token>` (from `ORB_API_TOKENS`)
serves tools to list and get projects, read and add logs, move projects,
list, add and complete tasks, and list and finish chores. Anything an agent
writes is marked with its token's name.

## Design and status

[docs/backend.md](docs/backend.md) covers what Orb owns and what it reads
from other apps, the API, the MCP tools, CalDAV, the wiki rules and what is
built so far. [docs/miladash.md](docs/miladash.md) covers the ideas board.
[docs/allglance.md](docs/allglance.md) covers ALLGlance and the task priority scale.

`demo/index.html` is the demo built as a claude.ai artifact. Its storage and
Golem use the artifact runtime (`window.claude`), so opened as a plain file it
renders but does not save.

Left out for now: Mail (kept on the `mail` branch), writing tasks through to
ALLGlance's dayGLANCE, and several users with their own logins.

## License

MIT, see [LICENSE](LICENSE).
