# Pondering Orb

A self-hosted homelab command center, styled as a wizard's tower. One page to
see what you're working on, what's due, how the lab is doing and what the day
holds, with the Golem, an assistant that can read all of it.

One Orb is one person. For someone else, run a second container with its own
folder, `.env` and port.

## What's in it

Every page is a grid of panels you can move, resize, hide and add in **Edit
layout**. Drag a tab onto another to show two pages side by side.

| Tab | What it shows |
| --- | --- |
| **Links** | A grid of icons for every app with a web page: the Unraid server's containers (with Unraid's WebUI address and icon), the apps list, and links you add. Hide, rename, give another address (a container port or any URL), sort into categories and drag into place |
| **Main** | The Golem, favorite projects, open and top-priority tasks, today's family calendar, the log, chores, uptime, UpstreamManager, system, and a panel per app (with live views for Plex, SABnzbd, Firefly III and Omi) |
| **Daily** | The morning brief, written by the Golem from the weather, news, your watchlist, tasks, chores, bills and every calendar; plus Today and This week |
| **Journal** | One page per day: Orb's log of the day (money spent and earned, tasks and chores done, commits, UpstreamManager requests, Hermes Studio agent work, Omi's recap, alerts), your typed notes, and pages to write or draw on with a pen or tablet, blank or over an image or PDF you bring in |
| **Projects** | Kanban board (next, active, blocked, paused, shipped) and the log; each project has a page with its tasks, log, wiki note, repository and linked chats |
| **Agents** | Hermes Studio chats working on your plans: watch them, or send a project or task to a new one (Ekko, Hermes or a coding agent) |
| **Ideas** | A board in Milaclone's style: cards, columns, nested boards, arrows, to-do cards |
| **To-do** | CalDAV task lists with priorities, plus dayGLANCE's tasks |
| **Wiki** | The LLMWIKI vault: tree, notes, search, section edits, related links |
| **Calendar** | Month and next two weeks: your events, the family calendar, CalDAV calendars, task due dates and chores |
| **Picks** | Daily stock research, a verdict per stock from your self-hosted decision model, your call with an amount, an order on Robinhood when you confirm it, and what every pick did afterwards |
| **Money**, **Coinpile**, **Omi** | Optional full pages for Firefly III (this month, bills, budgets, accounts, piggy banks, transactions), Coinpile (savings, goals, alerts, maturities, forecast) and Omi (`page: true` in the apps YAML) |
| **Upkeep** | UpstreamManager's repos, approval requests and daily check, and your chores |
| **Uptime** | Monitors from an Uptime Kuma status page |
| **System** | btop-style cores, memory, disks and containers (with CPU and memory), or real btop |
| **Settings** | Connections, Golem, appearance and themes, which pages show, Daily page, stock picks, Robinhood, apps YAML, what's waiting to sync |

Pages that need an app you haven't set up stay out of the tabs: Agents (Hermes
Studio), Wiki (the vault mount or its REST key), Upkeep (UpstreamManager, or
any chores), Uptime (Uptime Kuma) and Picks (stock picks turned on). Settings →
Pages can always show or hide any page except Main and Settings.

### The Golem

The assistant on Main. It runs on any OpenAI-compatible endpoint: a local
model (Argos, llama-server, Ollama) or a frontier API such as OpenRouter. It
streams its replies. With tools it reads projects, logs, tasks, chores, the
wiki, linked chats, ALLGlance, Firefly III and Omi. When writing is allowed,
it adds logs and tasks and completes them. Settings → Golem picks the model
and whether it may write.

## Integrations

Each one is optional; leave its address empty and its panels say so.

| App | What Orb does | Doc |
| --- | --- | --- |
| **ALLGlance** gateway | Tasks over vikunja's CalDAV at the gateway's `/dav` (read and write, priorities kept), the family calendar (dayGLANCE: read, and add events), lastGLANCE chores, lifeGLANCE milestones | [docs/allglance.md](docs/allglance.md) |
| Any **CalDAV** server | Task lists, chores (as recurring to-dos) and calendars; changes that fail wait in a retry queue | [docs/backend.md](docs/backend.md) |
| **LLMWIKI** (Obsidian Local REST API) | Reads the vault (mounted read only); writes only through the REST API, following the vault's rules; a daily digest line if you want one | [docs/backend.md](docs/backend.md) |
| **UpstreamManager** | Repos, approval requests (approve part of one), daily check, fetch, new commits logged per project | [docs/backend.md](docs/backend.md) |
| **Hermes Studio** | Chats linked to projects; work sent to Studio on the Agents tab, with its status reported back | |
| **Unraid Management Agent** | Read only: every container, its state, port mappings and updates, for the Links page; suggests addresses for Orb's other connections from what's running | [docs/links.md](docs/links.md) |
| **Uptime Kuma** | Monitors from a public status page | |
| **Firefly III** | Read only: this month (net worth, spent, earned, left to spend), bills due and paid, budgets, piggy banks, accounts, transactions and search; bills also show in Today and This week, and in the brief. Bank data reaches Firefly through [plaid-firefly-connector](https://github.com/Wizard815/plaid-firefly-connector) | [docs/companions.md](docs/companions.md) |
| **Coinpile** | Read only: what you share with the Orb: savings (free vs set aside), goals, alerts (a bank to sign in again, CDs maturing), the spending forecast, Robinhood value | [docs/companions.md](docs/companions.md) |
| **Omi** (omi-local) | Read only: daily recaps, conversations, memory search; its action items come through CalDAV, once | [docs/companions.md](docs/companions.md) |
| **Robinhood** | Its Trading MCP (OAuth): the agentic account, and orders for picks you approve, within caps you set | [docs/picks.md](docs/picks.md) |
| **Plex**, **SABnzbd** | Live panels | |
| Agents (MCP) | `POST /mcp` with a token: projects, logs, tasks, chores | [docs/backend.md](docs/backend.md) |

Every key stays on the server. Settings and the apps YAML only name the
environment variable that holds it.

## Run it with Docker

```bash
git clone https://github.com/Wizard815/pondering-orb && cd pondering-orb
cp docker-compose.example.yml docker-compose.yml
cp .env.example .env                        # time zone, password, addresses, keys
cp config/orb.example.yaml config/orb.yaml  # optional: more settings
mkdir -p data && sudo chown 1000:1000 data  # Orb runs as uid 1000 and keeps orb.db here
docker compose pull                         # the published image (or skip this and add --build below)
docker compose up -d
```

Open `http://<host>:8095` and sign in with `ORB_PASSWORD`. Then go to
Settings → Connections and press **Test** on each app you use.

`docker compose pull` fetches `ghcr.io/wizard815/pondering-orb:latest`, which
GitHub Actions tests, builds and publishes from `main` (and `:<version>` from
a `v*` tag). A new GitHub package is private: make it public once (GitHub →
your profile → Packages → pondering-orb → Package settings → Change
visibility), or `docker login ghcr.io` first. To build it yourself instead,
skip the pull and run `docker compose up -d --build`. The image is multi-arch
(amd64, arm64), runs as a non-root user and has a health check.

What the compose file starts: Orb, and a read-only Docker socket proxy for the
System tab (it can list containers and nothing else). Everything else you
already run stays where it is; Orb reaches it by address. Optional extras:

```bash
docker compose --profile uptime up -d   # a bundled Uptime Kuma (then UPTIME_URL=http://uptime-kuma:3001)
docker compose --profile btop up -d     # real btop as a web terminal for the System tab
```

### `.env`

Start from [`.env.example`](.env.example). Values here never reach the browser.

| Variable | What it is |
| --- | --- |
| `TZ` | Your time zone, e.g. `America/Chicago`. It decides what "today" is for logs, chores, bills and the brief. Use the same one in your other apps. |
| `ORB_PASSWORD` | Sign-in for the web app (required) |
| `ORB_API_TOKENS` | `name:token` pairs for agents and `/mcp`, e.g. `hermes:abc,claude:def`; the name is recorded on what each one writes |
| `ORB_PORT`, `ORB_HOSTNAME` | The host port (default 8095) and the name the System tab shows |
| `UNRAID_URL`, `UNRAID_TOKEN`, `UNRAID_LINK_HOST` | The Unraid Management Agent (`http://tower:8043`), its API token, and optionally the address app links use |
| `ALLGLANCE_URL`, `UPSTREAM_URL`, `UPTIME_URL`, `HERMES_URL`, `HERMES_PUBLIC_URL`, `ARGOS_URL`, `WIKI_URL` | Addresses of your apps. Empty means not used. Use a container name if Orb shares the app's network, else `http://<host>:<port>`. |
| `LLMWIKI_VAULT` | The vault folder on this host, mounted read only |
| `CALDAV_USER`, `CALDAV_PASSWORD` | Your CalDAV login; with ALLGlance, your vikunja login |
| `ALLGLANCE_TOKEN` | The gateway's `GATEWAY_TOKEN` |
| `WIKI_API_KEY` | Obsidian Local REST API key |
| `HERMES_USER`, `HERMES_PASSWORD` | A Hermes Studio user for Orb |
| `OPENROUTER_API_KEY` (or any name) | A frontier model key, named in Settings → Golem |
| `DECIDER_KEY` (or any name) | Key for your self-hosted decision model, if it needs one |
| `TIINGO_API_KEY` | Free key for stock prices (else Yahoo, then Stooq) |
| `FIREFLY_TOKEN`, `COINPILE_TOKEN`, `OMI_DEV_KEY` | A Firefly III Personal Access Token, a Coinpile token with the `orb` scope, and a read-only Omi key |
| `PLEX_TOKEN`, `SABNZBD_API_KEY` (or any name) | Keys for live app panels, named in the apps YAML |
| `BTOP_AUTH` | Optional `user:password` for the btop terminal |

Where settings live: addresses and keys in `.env`; anything else you'd rather
keep in a file in `config/orb.yaml` (a value there wins over the same one in
`.env`); everything else in Settings, saved in `data/orb.db`.

### Reaching your other apps

Orb's container is on its own network. To use container names such as
`http://hermes-studio:6060`, join the networks those apps are on: in
`docker-compose.yml`, add them to the `orb` service's `networks:` and declare
them as `external: true` at the bottom (the file has an example). Apps in
another compose project or on another machine just need
`http://<host>:<port>`.

### Updating, backups

```bash
docker compose pull && docker compose up -d   # or: git pull && docker compose up -d --build
```

Everything Orb keeps is in `data/orb.db` (SQLite), plus images brought into
the Journal in `data/journal/`. Back up the `data` folder
and `.env`. Stopping the container cleanly is enough for a consistent copy.

### If something's wrong

- **"can't write to its data folder"** on start: run `sudo chown 1000:1000 data`.
- **A tab says an app isn't set up**: its address is empty; set it in `.env`
  or Settings → Connections, then **Test**.
- **The System tab shows no containers**: the socket proxy isn't running, or
  `DOCKER_HOST` doesn't point at it.
- **Days roll over at the wrong hour**: set `TZ` in `.env`. Settings → Logs
  shows the zone in use.

## Security

- Sign in with `ORB_PASSWORD`. Agents use tokens from `ORB_API_TOKENS`, and
  they can't change settings, decide stock picks or place orders.
- With neither set, Orb is open to anyone who can reach the port. That's only
  for a private LAN, and the server warns about it on start.
- Requests from other websites are refused, and the Docker socket is only
  reachable read-only through the proxy.
- Firefly III, Coinpile and Omi are read only. Robinhood orders need your confirmation
  each time, stay within your caps, and are off until you turn them on.
- Never put keys in `orb.yaml`, the apps YAML or Settings. Those only name the
  environment variable that holds the key.

## Develop

Node 22.13 or newer.

```bash
npm install
npm run dev     # server on :8095 (restarts on change), web on :5173 with the API proxied
npm test        # server tests and the web type check
npm run build   # server/dist and web/dist
```

- `server/`: Node + TypeScript + Fastify, with Node's built-in SQLite. It
  keeps Orb's records, talks to the other apps, runs the Golem, schedules the
  brief, research and syncs, and serves the API, `/mcp` and the web app.
- `web/`: React + Vite + TypeScript.
- `docker/btop/`: the optional btop terminal.
- `demo/index.html`: the original single-page demo, kept for history.

## Docs

- [docs/backend.md](docs/backend.md): what Orb owns and what it reads, the
  REST API, MCP tools, CalDAV, the wiki rules
- [docs/allglance.md](docs/allglance.md): the ALLGlance stack, priorities,
  the family calendar
- [docs/companions.md](docs/companions.md): Firefly III, Coinpile and Omi
- [docs/links.md](docs/links.md): the Links page and the Unraid Management
  Agent
- [docs/journal.md](docs/journal.md): the Journal, its day log, notes and
  drawing pages
- [docs/picks.md](docs/picks.md): the Daily page, stock picks, the decision
  model and Robinhood
- [docs/miladash.md](docs/miladash.md): the ideas board and Miladash

Not in Orb, by choice: several users in one Orb (run one per person), and
mail (an early version is kept on the `mail` branch).

## License

MIT, see [LICENSE](LICENSE).
