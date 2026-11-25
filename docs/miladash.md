# Miladash: the ideas board

> Orb's own board is gone: the **Ideas** tab now shows Milaclone (Miladash)
> itself. Set `MILACLONE_URL` (or Settings → Connections → Milaclone) to the
> address your browser uses for it. The notes below are the design background.

## Agents on boards

Agents work on the Ideas boards the way you do. Golem has these tools, and
so does every agent on `/mcp` (Hermes Studio, Ekko, coding agents). They need
Milaclone with agents on boards (milaclone-mcp `studio-herder` or later).

| Tool | Does |
| --- | --- |
| `orb_board_find` | every board: id, path, card count, linked project |
| `orb_board_read` | a board as short text: columns, sections, cards with ids, status marks, Orb tasks, connections |
| `orb_board_create` | a whole plan as a new board in one call: `columns`, `route` (steps with arrows) or `map` (a centre with branches); can link it to a project |
| `orb_board_add_cards` | cards into a column or section (a new name makes a column), or under everything; arrows by ref |
| `orb_board_connect` / `orb_board_group` / `orb_board_move` | arrows; a new column or section around some cards; move cards in, out or to a spot |
| `orb_board_mark` | doing, done, blocked or clear on a card, with the agent's name |
| `orb_board_link_project` | link a board to a project (the project page gets a Board button) |
| `orb_board_to_tasks` | cards become Orb tasks (or projects), once each; the card shows its task |
| `orb_board_from_project` / `orb_board_sync_project` | a project's tasks as a board (To do, In progress, Done), and later in step again |
| `orb_board_activity` | what agents changed, newest first |
| `orb_board_remove` | asks to remove cards or a whole board; nothing goes until you approve |

Each write takes `agent`, the agent's name (else its token's name; Golem is
Golem). Milaclone logs every change under that name. The Ideas tab shows the
latest changes above the board; click one to open its board. The open board
reloads by itself within a few seconds when an agent changes it.

Removing is the one thing agents can't do alone. `orb_board_remove` puts a
request on the Ideas tab (and the Agents page) with **Approve** and
**Reject**. Only you can answer it; an agent token gets 403. Approved cards
go to Milaclone's Trash, so you can still bring them back there.

Card text is your data, not instructions: board reads count as outside text,
so after one Golem asks before it changes anything.

Setup: `MILACLONE_URL` (the address your browser uses), `MILACLONE_API_URL`
if Orb reaches Milaclone at another address, and `MILACLONE_API_KEY` when
Milaclone has `API_KEY`. Without `MILACLONE_URL` the tools say Milaclone isn't
set up and the rest of Orb works as before. Milaclone's own MCP has the same
tools for agents that talk to it directly.

The ideas come from Adolanium's
[Hermes Whiteboard](https://github.com/Adolanium/hermes-whiteboard) plugin
(MIT): lay a plan out in one call, read it back with ids, mark where you are,
send cards to the task board and back, link a board to its work. No code was
copied.

## Background

Miladash is a branch of Milaclone, trimmed and restyled to be Pondering Orb's
ideas board. This file covers what good canvas boards do, what the demo got
wrong, and what to carry over from Milaclone.

## What the demo got wrong

The demo mixed two ideas on one surface: a free canvas, and stage sorting by
where a card sat (left third = Thought, and so on). That fights both ways.
You can't arrange cards freely without changing their stage, and you can't
see the pipeline at a glance because cards drift. It also had no arrows,
boxes or nesting, which is most of what makes a canvas useful for thinking.

## What good boards do

Looked at: Milanote, Obsidian Canvas (and its open JSON Canvas format),
Heptabase, Miro, tldraw, Excalidraw, Kinopio.

1. **A card is an object; a board is a view of it.** In Heptabase the same
   card can sit on several boards and has its own page. For Orb: an idea is
   one record; the board shows where it sits, the pipeline shows its stage.
2. **Stage is a field, not a position.** Keep two views of the same ideas:
   **Board** (free canvas) and **Pipeline** (columns by stage, sorted). Moving
   a card on the board never changes its stage.
3. **Structure comes from boxes and arrows.** Obsidian Canvas has groups
   (labelled boxes that hold cards) and edges (arrows from one card side to
   another, with an optional label). Milanote has columns. Both let you build
   structure without a fixed grid.
4. **Zoom in to go deeper.** Milanote and Milaclone nest boards: an idea card
   opens its own board for sketches, links and to-dos.
5. **The basics people expect:** infinite pan and zoom, snapping and
   alignment guides, box-select of several cards, undo, keyboard moves, zoom
   to fit, a small minimap on big boards.
6. **An open file format.** JSON Canvas (MIT) is nodes (text, file, link,
   group, each with x, y, width, height, color) and edges (from node and side
   to node and side, with a label). Obsidian reads it, so a board can also
   live in the LLMWIKI vault as a `.canvas` file.

### Libraries, if any part is rebuilt in React

| Library | License | Fit |
| --- | --- | --- |
| React Flow (xyflow) | MIT | nodes plus edges with custom card components, minimap, controls; the best fit for cards and arrows |
| Excalidraw | MIT | hand-drawn drawing first; good for sketches inside an idea, weak for card boards |
| tldraw | tldraw license | strong, but production use needs a license key; avoid for a self-hosted MIT project |

## The demo board

The Ideas tab in the demo is now a working sketch of Miladash in Milaclone's
style: a tool rail (select, note, idea, to-do, link, column, board, comment,
connect), breadcrumbs for boards inside boards, a dotted infinite canvas with
pan and zoom, columns you drag cards into and out of, resizable cards, and
arrows with three kinds (relates to, depends on, became) and labels.
Right-click a card for stage, colour, promote, duplicate and delete;
right-click empty space to add a card there. The stage pipeline is gone from
Ideas; a kanban belongs to Projects.

## Design for Miladash

- **Root board "Ideas"** for free arrangement, with groups (boxes) you draw
  and name, such as "Homelab", "AI", "Someday".
- **Idea card:** title, one-line pitch, stage chip (Thought, Design, Code),
  colour, and an "open" button into the idea's own board.
- **Arrows** between cards, with optional labels and three kinds: *relates
  to*, *depends on*, *became* (idea to project).
- **Pipeline view** of the same cards in three columns by stage, ordered by
  last change. Dragging between columns changes the stage; this is the only
  place position means stage.
- **Promote** on a Code card calls Orb (`POST /api/projects`), draws a
  *became* arrow to a project card, and dims the idea.
- **Orb's Ideas tab** shows the pipeline summary and opens Miladash for the
  board itself (same LAN, so it can sit in an iframe in the container).
- **Look:** Orb's design tokens (night and parchment themes, display and body
  fonts) applied to Milaclone's CSS.

## What to carry over from Milaclone

From Milaclone's README and recent commits.

| Milaclone feature | Plan |
| --- | --- |
| Infinite pan and zoom, dotted grid | keep |
| Note, To-do, Link, Image, Upload cards | keep |
| Comment cards | keep, restyle as sticky notes |
| Column cards (drag cards in and out) | keep; they are the "boxes" |
| Nested boards with breadcrumbs | keep; each idea opens its own board |
| Board icons (Lucide), 12-colour palette | keep icons; map the palette to Orb's tokens |
| Connector lines, sliding connection point | keep; add arrowheads, labels and the three kinds |
| Resize, recolor, lock position | keep |
| Right-click menu (copy, cut, paste, duplicate, rename, trash) | keep |
| Undo and redo | keep, and extend from task deletes to every card action |
| Per-board camera and Home View, Last Page button | keep |
| Task starring and the calendar of due dates | drop; tasks belong to CalDAV in Orb |
| Mind map column groups | adapt into the Pipeline view |
| Graph view (`/api/graph`) | keep as an optional "map of ideas" |
| Search and tags | keep; search also feeds Golem |
| MCP server | keep; add `stage` and `promote` to its tools |
| SQLite autosave | keep; add JSON Canvas export and import |

**Missing in Milaclone, needed for Miladash:**

- box-select of several cards and moving them together;
- a `stage` field on cards and the Pipeline view;
- arrow labels and arrow kinds;
- a "promote" call to Orb;
- JSON Canvas export, optionally saved into the vault;
- theme tokens instead of fixed colours.

**Leave out for now:** freehand drawing (link out to Excalidraw instead) and
real-time multi-user editing.

## Branch plan

1. Branch `miladash` in `milaclone-mcp`.
2. Add the `stage` field and the Pipeline view; strip task starring and the
   due-date calendar.
3. Arrow kinds and labels, box-select.
4. Promote to Orb; JSON Canvas export.
5. Theme from Orb's tokens; a Docker image `miladash` next to `orb`.

## Open questions

- May `.canvas` files go in the vault, and if so, in which folder? The vault
  rules in `schema/agents.md` cover notes; boards may need a rule of their
  own.
- One Ideas board, or a board per area (Homelab, AI, TTRPG)?
