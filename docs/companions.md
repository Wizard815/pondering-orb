# Firefly III, Coinpile and Omi

Your own apps, read only. Add them as apps with a widget in Settings → Apps
(the apps YAML):

```yaml
groups:
  - name: Household
    apps:
      - name: Firefly III
        url: http://firefly:8080
        widget: { type: firefly, key_env: FIREFLY_TOKEN, page: true }
      - name: Coinpile
        url: http://coinpile:8000
        widget: { type: coinpile, key_env: COINPILE_TOKEN }
      - name: Omi
        url: http://192.168.20.5:8000
        widget: { type: omi, key_env: OMI_DEV_KEY }
```

Put the keys in `.env` (`FIREFLY_TOKEN`, `COINPILE_TOKEN`, `OMI_DEV_KEY`). They stay on the
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

Bank data reaches Firefly through your
[plaid-firefly-connector](https://github.com/Wizard815/plaid-firefly-connector);
Orb doesn't talk to Plaid or the connector, it reads the result in Firefly.

## Coinpile (savings, goals, alerts, the forecast)

[Coinpile](https://github.com/Wizard815/coinpile) is the friendly view over
Firefly III (formerly Goblin-Bank). Orb reads the summary Coinpile keeps for
it: `GET /api/v1/summary` with a Coinpile API token that has the **orb**
scope (Coinpile → Settings → Home Assistant & API → new token, tick *orb*).
On the same page you tick what Orb may see; nothing else is shared, and
never transactions.

Firefly III already gives Orb accounts, bills, budgets and piggy banks, so
Coinpile is for what Firefly has no place for:

| Coinpile shares | Orb shows |
| --- | --- |
| Savings: total, free, set aside | the Coinpile panel and page, the brief |
| Goals and their progress (0–1) | bars on the panel and page |
| Alert list (and counts) | the panel and page (critical first): a bank to sign in again at the Plaid connector, an account running short, missed payments, money earmarked twice, CDs maturing |
| CDs maturing / matured and idle | **Maturing today** on Daily's Today (an idle matured CD stays there until handled), This week, the page, the brief |
| Spending forecast | so far, on track for, % of income, left after: panel, page, brief |
| Robinhood (main and agentic) | value on the panel and page |
| Net worth, subscriptions per month, bill totals and the bill list | the page; Daily's bills and the brief use these only when Firefly III isn't set up (Coinpile's list holds Firefly's bills, so they'd show twice) |

`page: true` gives it a **Coinpile** tab. Golem's read-only tool is
`coinpile_summary`.

## Panel, or a full page

Each app is a panel by default (on Main and Daily; add it to any page in Edit
layout). Add `page: true` to its widget to also give it a tab of its own, or
`page: "Household"` to name the tab:

```yaml
        widget: { type: firefly, key_env: FIREFLY_TOKEN, page: true }   # tab "Money"
        widget: { type: omi, key_env: OMI_DEV_KEY, page: "Omi" }
```

- **Money** (Firefly III): this month, bills for the next 30 days, budgets,
  accounts and liabilities, piggy banks, transactions and search.
- **Omi**: day recaps you can step through (headline, highlights, decisions,
  open questions, what it learned), Omi's action items (from CalDAV),
  memory search and recent conversations.

Take `page:` away and the tab goes; the panels stay.

## What Orb reads

| App | Request (always GET) | Shown |
| --- | --- | --- |
| Firefly III | `GET /api/v1/...` with a Personal Access Token (see above) | the month, bills, budgets, piggy banks, accounts, transactions |
| Coinpile | `GET /api/v1/summary` with an `orb`-scoped token | savings, goals, alerts, maturities, the forecast, Robinhood (what you share) |
| Omi | `GET /v1/dev/user/daily-summaries`, `/conversations`, `/memories/search`, with an `omi_dev_` key | yesterday's recap (headline, overview, decisions, open questions) and recent conversations |

Orb never sends anything to either app, and never reads Omi's action items
from Omi.

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

- **Panels**: Firefly III, Coinpile and Omi are on Main and the Daily page to
  start with. Any app panel can be added to Main, Daily or Picks in Edit layout.
- **Daily page**: Firefly's unpaid bills appear under Today and in This week.
- **Morning brief**: bills this week, budgets near or over and the month from
  Firefly; savings, the spending forecast, alerts and CDs maturing from
  Coinpile; and yesterday per Omi.
- **Golem** (read-only tools): `finance_summary`, `finance_accounts`,
  `finance_search_transactions`, `coinpile_summary`, `omi_search_memories`, `omi_daily_summary`,
  `omi_recent_conversations`.
