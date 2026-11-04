# Pondering Orb

A homelab command center: what you are working on, a project log, plans,
upkeep checks, system stats, and links into the rest of the stack.

Tabs (each one a room of the tower):

- **Main**: the scrying table; choose and order its panels with Arrange
- **Projects**: project cards with status, plus the project log
- **Notes & Plans**: notes editor and next / later / someday plans
- **Calendar**: month view of your events and upkeep due dates
- **Mail**: waiting for the Gmail connector
- **Upkeep**: recurring checks, amber when due, red when overdue
- **System**: per-host CPU, memory, disk and GPU
- **Agents**: Argos and Odysseus links, and "ask the orb"
- **Apps**: the stack, defined in YAML (see below)

Star a project, note or plan to put it in Favorites on the Main tab.

## orb.yaml

```yaml
favorites:
  - Odysseus
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
