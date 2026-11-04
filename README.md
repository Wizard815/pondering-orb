# Pondering Orb

A homelab command center: what you are working on, a project log, plans,
upkeep checks, system stats, and links into the rest of the stack.

Tabs (each one a room of the tower):

- **Main**: the scrying table; pick and order its panels (Golem, Favorites,
  Apps, Recent log, Next 7 days, Upkeep due and more)
- **Projects**: kanban board (Up next, Active, Blocked, Paused, Shipped) and
  the project log, filterable by project
- **Ideas**: a free-form board (a preview of Miladash); where a card sits
  sets its stage (Thought, Design, Code); Promote puts it on the board
- **Notes & Plans**: notes editor and next / later / someday plans
- **Calendar**: month view of your events and upkeep due dates
- **Mail**: waiting for the Gmail connector
- **Upkeep**: recurring checks, amber when due, red when overdue
- **System**: per-host CPU, memory, disk and GPU
- **Settings**: Golem, log length, Main layout and the apps YAML

Star a project to put it in Favorites on the Main tab; each project has its
own page with its tasks and recent log entries. Log entries are
short: 50 characters by default, set in Settings.

## Golem

The dashboard assistant on the Main tab. It reads projects, logs, ideas and
upkeep, and when allowed it adds logs, plans and ideas and moves project
cards. It thinks with Claude today. Argos already serves MCP at `/api/mcp`;
once that is added as a claude.ai connector, Golem can read GPU and request
status from it.

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

## Container backend

The page here is the demo. The real Orb runs as a container with its own
REST API and MCP endpoint, reads and completes tasks through ALLGlance, runs
Golem on Argos, and uses Miladash (a Milaclone branch) for ideas. See
[docs/backend.md](docs/backend.md).

## Status

`index.html` is the first version, built as a claude.ai artifact. Its
storage and "ask" box use the artifact runtime (`window.claude`), so opened
as a plain file it renders but does not save.

## Planned

- Gmail and Google Calendar through claude.ai connectors
- Odysseus CalDAV events through n8n
- A small reporter on each host that posts system stats
- Milaclone boards through its MCP server
- Free-form app tiles

## License

MIT, see [LICENSE](LICENSE).
