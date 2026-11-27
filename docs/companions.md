# Firefly III, Coinpile, Omi, Immich and the media apps

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

**Joint accounts.** People on the connector can share a bank account with
each other: one asks, the other accepts, no admin needed (see the
connector's README). An accepted account lands in the other person's
Firefly III as a new account ("Shared by <name>") or in one they already
have, so Orb shows it like any other account. Firefly III holds the whole
balance, so Orb's Firefly III net worth counts all of it; Coinpile counts
only your share (below). When a share stops, the account stays in Firefly III
with its history and gets no new transactions.

## Coinpile (savings, goals, alerts, the forecast)

[Coinpile](https://github.com/Wizard815/coinpile) is the friendly view over
Firefly III (formerly Goblin-Bank). Orb reads the summary Coinpile keeps for
it: `GET /api/v1/summary` with a Coinpile API token that has the **orb**
scope (Coinpile → Settings → Home Assistant & API → new token, tick *orb*).
On the same page you tick what Orb may see; nothing else is shared, and
never transactions.

If the Coinpile panel stops with "sign in to Coinpile again": Firefly III no
longer accepts Coinpile's sign-in for you (the token was revoked or ran
out). Coinpile's API tokens, Orb's included, keep answering for a day and
then stop until you sign in to Coinpile again; the same token works again
after that. "Sign out everywhere … and end API tokens" in Coinpile revokes
Orb's tokens for good: make new ones and put them in `.env`.

Firefly III already gives Orb accounts, bills, budgets and piggy banks, so
Coinpile is for what Firefly has no place for:

| Coinpile shares | Orb shows |
| --- | --- |
| Savings: total, free, set aside | the Coinpile panel and page, the brief |
| Goals (your Firefly III piggy banks) and their progress (0–1), with the target date | bars on the panel and page |
| Firefly III budgets this month (limit, spent, left) | a line on the panel; budgets at 90% or more in the brief (when Firefly III isn't set up in Orb itself) |
| Next paycheck (date, amount, bills before the next one, piggy banks' share, what is left) | a line on the panel; the brief when it lands this week |
| This week (in and out against last week, the 3 biggest payments, net worth change) | a line on the panel; one line in the brief |
| Alert list (and counts) | the panel and page (critical first): a bank to sign in again at the Plaid connector, an account running short, missed payments, money earmarked twice, CDs maturing |
| CDs maturing / matured and idle | **Maturing today** on Daily's Today (an idle matured CD stays there until handled), This week, the page, the brief |
| Spending forecast | so far, on track for, % of income, left after: panel, page, brief |
| Robinhood (main and agentic) | value on the panel and page |
| Holdings (`holdings`: symbol, quantity, net_cost, equity, account) | Picks → What you hold, the decision model's state, scheduled reviews (when Coinpile shares them) |
| Trading (`trading`: Coinpile's auto wallet, its orders, last session and ideas for your stocks; Robinhood owner only) | Picks → Auto wallet & trade ideas (read only; approving orders, guidance and rules stay in Coinpile → Trading) |
| Daily totals (`daily`: date, spent, income) | the Journal's money for the day, instead of Firefly III's transactions (when Coinpile shares them) |
| Net worth, subscriptions per month, bill totals and the bill list | the page; Daily's bills and the brief use these only when Firefly III isn't set up (Coinpile's list holds Firefly's bills, so they'd show twice) |

`page: true` gives it a **Coinpile** tab. Golem's read-only tool is
`coinpile_summary`.

### Golem with Coinpile's own tools (MCP)

Coinpile is also an MCP server (`POST /api/v1/mcp`). Make a second Coinpile
token with the **mcp** scope, put it in `.env` (say `COINPILE_MCP_TOKEN`) and
name it in the widget:

```yaml
        widget: { type: coinpile, key_env: COINPILE_TOKEN, mcp_key_env: COINPILE_MCP_TOKEN }
```

Golem then gets every tool of Coinpile's agent as `coinpile_...`: accounts,
transactions (with Firefly III tags, budgets and payees), cash flow, budgets,
piggy banks, the paycheck plan, the tax year, loan payoff and savings plans,
and Coinpile's calculator (Golem is told to use it for every sum). Tools that
would change something only **ask**: the request waits on Coinpile's Agent
page for your Yes, so nothing changes from Orb. Without `mcp_key_env`, or if
Coinpile is down, Golem works as before.

Payee names, bill names and web pages are text from outside, so once Golem
has read a `coinpile_` or `finance_` result in a reply, it won't change
anything in Orb (tasks, logs, chores, projects) in that same reply. It tells
you what it would do; say yes in your next message and it does it.

### Joint accounts and linked people

In Coinpile, two linked people can tie their copies of a joint account
together and agree a split. Coinpile then counts only your share, so the
savings, net worth and goals Orb gets from Coinpile are your part. They can
differ from Firefly III's net worth, which counts the whole account.
Daily totals (`daily`) are the exception: they add up every posted
transaction in your Firefly III, so a payment from a joint account counts in
full, whoever made it.

Orb never gets the other person's numbers:

- The summary (`orb` token) is built only from your own data. It doesn't
  include what a linked person shows you or their side of a joint account.
- Over MCP, Golem can use `coinpile_shared_expenses` and
  `coinpile_shared_with_me`. It sees your own side of each joint account:
  your account, your share and what you put in this month. The other
  person's side is answered with "withheld": what they put in, their
  balance, their name for the account, the settle-up line, and anything
  else they share with you. Golem asks you for their figure when it needs
  one. To use those numbers, ask Coinpile's own agent with a model that runs
  on your machine.

## Immich (photos: on this day)

The Immich panel shows Immich's own "on this day" memories (photos from this
date in earlier years) and, if you are Immich's admin, the library's size.

```yaml
      - name: Immich
        url: http://192.168.20.5:8407        # where you open Immich: photos link here
        widget: { type: immich, url: http://immich:2283, key_env: IMMICH_API_KEY }
```

- Make the key while signed in as **yourself**: Immich → Account settings →
  API keys. Give it `memory.read` and `asset.view` (add `server.statistics`
  for the library size, admin only). Orb is your own dashboard, so it shows
  what your Immich account sees: your photos, a partner's, albums shared
  with you. Don't use a family member's key.
- `url` in `widget` is how Orb's server reaches Immich (the container name
  on a shared network, or the box IP and port). The app's own `url` is where
  your browser opens a photo.
- Pictures come through Orb's server (`/api/widgets/Immich/photo/<id>`), so
  the key never reaches the browser.

What goes wrong:
- "Immich refused the key": it was deleted or mistyped. Make a new one.
- "No memories for today": Immich makes memories overnight. Check
  Administration → Jobs, and that the photos have dates.
- No library size: the key isn't an admin's, or lacks `server.statistics`.

## Sonarr, Radarr, Tautulli and Seerr

Read-only panels for the media stack. Orb's server makes every call (always
GET) with the key from `key_env`; the browser never sees a key.

```yaml
  - name: Media
    apps:
      - name: Sonarr
        url: http://192.168.20.5:8200          # where your browser opens it
        widget: { type: sonarr, url: http://192.168.20.5:8200, key_env: SONARR_API_KEY }
      - name: Radarr
        url: http://192.168.20.5:8201
        widget: { type: radarr, url: http://192.168.20.5:8201, key_env: RADARR_API_KEY }
      - name: Tautulli
        url: http://192.168.20.5:8210
        widget: { type: tautulli, url: http://192.168.20.5:8210, key_env: TAUTULLI_API_KEY }
      - name: Seerr
        url: http://192.168.20.5:5055
        widget: { type: seerr, url: http://192.168.20.5:5055, key_env: SEERR_API_KEY }
```

| App | Calls | Shows |
| --- | --- | --- |
| Sonarr | `/api/v3/calendar` (today + 7 days, with series), `/api/v3/queue`, header `X-Api-Key` | episodes airing, queue with progress, status, time left |
| Radarr | `/api/v3/calendar`, `/api/v3/queue`, header `X-Api-Key` | movies released (cinema, digital or physical), queue |
| Tautulli | `/api/v2?cmd=get_activity`, `cmd=get_history&length=5`, `apikey=` | streams, who watches what, transcode or direct, the last five plays |
| Seerr | `/api/v1/request?take=5&sort=added`, `/api/v1/request/count`, header `X-Api-Key` | requests waiting for approval, the last five with status |

- Keys: Sonarr, Radarr and Seerr → Settings → General → API Key. Tautulli →
  Settings → Web Interface → API Key. Put each in Orb's `.env` and name the
  variable in `key_env`.
- `type: jellyseerr` and `type: overseerr` work the same as `seerr`.
- Tautulli and Seerr show people's names (who is watching, who asked). Orb is
  your own dashboard, so that's fine; don't share the page.
- If Sonarr or Radarr has a URL base (`/sonarr`), put it in the widget's `url`.

What goes wrong:
- "refused the API key": the key in that variable is wrong or was
  regenerated. Copy it again.
- "Couldn't reach …": the app is down, or the address is wrong from inside
  Orb's container (use the box IP and port, or the container name on a shared
  network).
- "has no calendar at that address (404)": the url is missing a URL base.
- "answered with a web page": the url points at a login page or a proxy.

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
