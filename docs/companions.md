# Firefly III, Omi and Goblin-Bank

Your own apps, read only. Add them as apps with a widget in Settings → Apps
(the apps YAML):

```yaml
groups:
  - name: Household
    apps:
      - name: Firefly III
        url: http://firefly:8080
        widget: { type: firefly, key_env: FIREFLY_TOKEN, page: true }
      - name: Omi
        url: http://192.168.20.5:8000
        widget: { type: omi, key_env: OMI_DEV_KEY }
```

Put the keys in `.env` (`FIREFLY_TOKEN`, `OMI_DEV_KEY`). They stay on the
server; the browser only sees what Orb shows.

## Firefly III (your finances)

Orb reads Firefly III through its REST API with a **Personal Access Token**
(Firefly → Options → Profile → OAuth → Personal access tokens). Put it in
`.env` as `FIREFLY_TOKEN` and add the app:

```yaml
      - name: Firefly III
        url: http://firefly:8080          # or http://<host>:<port>
        widget: { type: firefly, key_env: FIREFLY_TOKEN, page: true }   # page: a "Money" tab
```

Every request is a GET; Orb never creates, edits or deletes anything there.

| Firefly | Orb |
| --- | --- |
| `GET /api/v1/summary/basic` (this month, your primary currency) | net worth, balance, spent, earned, left to spend, bills paid and still to pay |
| `GET /api/v1/bills?start&end` (`pay_dates`, `paid_dates`) | bills for the next 30 days, each marked paid when Firefly matched a payment; unpaid ones show in Daily's Today and This week |
| `GET /api/v1/budget-limits`, `/budgets` | this month's budgets: limit, spent, % used |
| `GET /api/v1/piggy-banks` | saved, target, % (Firefly's own 0–100) |
| `GET /api/v1/accounts?type=asset` / `liabilities` | balances, and which count toward net worth |
| `GET /api/v1/transactions`, `/search/transactions` | recent transactions and Firefly's search syntax |

Where it shows up: the **Firefly III** panel (Main and Daily; the month, next
bills, budgets near their limit), the **Money** tab with `page: true`, Daily's
Today and This week (unpaid bills), the morning brief (bills this week,
budgets near or over, spent / earned / left to spend), and Golem's read-only
tools `finance_summary`, `finance_accounts` and `finance_search_transactions`.

If Plaid feeds Firefly (for example through Goblin-Bank acting as a Plaid
router), Orb doesn't need to know: it reads the result in Firefly.

## Goblin-Bank (optional)

Goblin-Bank can still be read the same way (its shared summary), but with
Firefly III set up Orb uses Firefly for the brief and Daily's bills. Its tab is
"Goblin-Bank" now; "Money" is Firefly's.

## Panel, or a full page

Each app is a panel by default (on Main and Daily; add it to any page in Edit
layout). Add `page: true` to its widget to also give it a tab of its own, or
`page: "Household"` to name the tab:

```yaml
        widget: { type: goblinbank, key_env: GOBLIN_ORB_KEY, page: true }   # tab "Money"
        widget: { type: omi, key_env: OMI_DEV_KEY, page: "Omi" }
```

- **Money** (Goblin-Bank): each person's shared totals, bills for the next 30
  days, alerts (critical first), savings and goals, Robinhood balances.
- **Omi**: day recaps you can step through (headline, highlights, decisions,
  open questions, what it learned), Omi's action items (from CalDAV),
  memory search and recent conversations.

Take `page:` away and the tab goes; the panels stay.

## What Orb reads

| App | Request (always GET) | Shown |
| --- | --- | --- |
| Goblin-Bank | `GET /api/v1/summary` on CoinGateway, with its Orb key (`summary:read`) | per person, only what they share (Goblin-Bank → Settings → Sharing): net worth, subscriptions, bill totals and the **bill list**, alert counts and the **alert list**, savings, goals, Robinhood balances |
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

CDs and bonds nearing maturity arrive as dated alerts (kind `maturing`, with the date and where the money would go) once the alert list is shared; they show under **Maturing today** on Today, in This week, on the Money page and in the brief when they are within a week.

Bill and alert *lists* are their own share options in Goblin-Bank (`bill_list`,
`alert_list`); sharing the totals doesn't share them.

## Where they show up

- **Panels**: Goblin-Bank and Omi are on Main and the Daily page to start
  with. Any app panel can be added to Main, Daily or Picks in Edit layout.
- **Daily page**: shared bills appear under Today and in This week.
- **Morning brief**: bills this week and critical or warning alerts, yesterday
  per Omi, and net worth from Goblin-Bank's shared summary.
- **Golem** (read-only tools): `money_summary`, `omi_search_memories`,
  `omi_daily_summary`, `omi_recent_conversations`.
