# Pondering Orb

A homelab command center: what you are working on, a project log, plans,
upkeep checks, system stats, and links into the rest of the stack.

- **Working on**: project cards with status and the next step
- **Project log**: dated notes per project
- **Plans**: next / later / someday
- **Upkeep**: recurring checks that go amber when due and red when overdue
- **System**: per-host CPU, memory, disk and GPU
- **Next 14 days**: upkeep due dates now; Odysseus calendar (CalDAV) planned
- **Agents**: links to the Argos assistant and Odysseus agents, plus an
  "ask about the lab" box
- **Stack**: Odysseus, Argos, UpstreamManager, Milaclone

## Status

`index.html` is the first version, built as a claude.ai artifact. Its
storage and "ask" box use the artifact runtime (`window.claude`), so opened
as a plain file it renders but does not save.

## Planned

- Odysseus CalDAV events in the 14-day view
- A small reporter on each host that posts system stats
- Milaclone boards through its MCP server
- Free-form app tiles

## License

MIT, see [LICENSE](LICENSE).
