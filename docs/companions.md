# Goblin-Bank and Omi

Two of your own apps, read only. Add them as apps with a widget in Settings →
Apps (the apps YAML):

```yaml
groups:
  - name: Household
    apps:
      - name: Goblin-Bank
        url: http://coingateway:8080
        widget: { type: goblinbank, key_env: GOBLIN_ORB_KEY }
      - name: Omi
        url: http://192.168.20.5:8000
        widget: { type: omi, key_env: OMI_DEV_KEY }
```

Put the keys in `.env` (`GOBLIN_ORB_KEY`, `OMI_DEV_KEY`). They stay on the
server; the browser only sees what Orb shows.

## What Orb reads

| App | Request (always GET) | Shown |
| --- | --- | --- |
| Goblin-Bank | `GET /api/v1/summary` on CoinGateway, with its Orb key (`summary:read`) | per person: net worth, monthly subscriptions, bills due (this week, 30 days, the next one), alert counts, savings (total and free), goal progress and Robinhood balances, each only if that person ticked it under Goblin-Bank → Settings → Sharing |
| Omi | `GET /v1/dev/user/daily-summaries`, `/conversations`, `/memories/search`, with an `omi_dev_` key | yesterday's recap (headline, overview, decisions, open questions) and recent conversations |

Orb never sends anything to either app, never asks for transactions, and
never reads Omi's action items from Omi.

## One task list: CalDAV

Omi writes its action items to your CalDAV server as to-dos
(`UID:omi-task-…@omi-local`), and its day reviews and conversations as
events (`omi-day-…`, `omi-event-…`). Orb reads every task from that same
CalDAV server, so each Omi action item shows up **once**, like any other
task, marked **Omi**. To keep Omi in charge of them:

- Orb shows them read only: no checkbox, priority or delete in the page;
  the API, Golem and agents are refused (403), and the CalDAV sync never
  writes them back, even if a record changed. Finish them in Omi; the next
  sync brings the change in.
- Omi's day reviews and conversation events stay out of Today, This week and
  the brief's calendar, since they record what happened rather than plans.
  The Omi panel shows them instead.

## Where they show up

- **Panels**: Goblin-Bank and Omi are on Main and the Daily page to start
  with. Any app panel can be added to Main, Daily or Picks in Edit layout.
- **Morning brief**: yesterday per Omi, and net worth from Goblin-Bank's
  shared summary.
- **Golem** (read-only tools): `money_summary`, `omi_search_memories`,
  `omi_daily_summary`, `omi_recent_conversations`.
