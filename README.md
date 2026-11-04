# Pondering Orb

A homelab command center: what you are working on, a project log, plans,
upkeep checks, system stats, and links into the rest of the stack.

Tabs (each one a room of the tower):

- **Main**: modular panels; Golem, favorite projects, open tasks, uptime,
  the log, and one panel per app or app group, with live views for Plex,
  SABnzbd and UpstreamManager
- **Projects**: kanban board and log; each project has a page with its
  tasks, log and wiki note
- **Ideas**: ideas by stage; the board itself becomes Miladash
  ([docs/miladash.md](docs/miladash.md))
- **To-do**: CalDAV-style task lists; pick which lists to show
- **Wiki**: preview of the LLMWIKI vault (PARA folders, section edits)
- **Calendar**, **Mail**, **Upkeep**
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
