# Daily page and stock picks

## Daily page

The **Daily** tab holds the morning brief and the panels it is written from:

- **Weather** from Open-Meteo (no key). Set the location in Settings → Daily
  page as `City, Country` or `lat,lon`.
- **News** from RSS or Atom feeds you list (NPR, BBC World and CNBC by
  default).
- **Markets**: your watchlist. Prices come from Tiingo when `TIINGO_API_KEY`
  is set (free), otherwise Yahoo's chart API, then Stooq. The last two are
  unofficial and can refuse or rate-limit; Orb doesn't pretend to be a
  browser to get past that, so set a Tiingo key if prices fail.
- **Today** and **This week**: events from every CalDAV calendar (recurring
  events are expanded by the server), Orb's own events, tasks due or
  overdue, and chores due.
- **Current tasks**: open tasks by priority.

Golem's model writes the brief once a day after the hour you set (default
7:00 in `TZ`), and "Write it again" rewrites it. It is told to use only the
data it is given. Each day's brief is kept in the `daily` collection.

## Stock picks

Each run (by hand, or on market days after the hour you set):

1. **Market news research**: Golem's model searches news (Google News) at
   least five times, reads the most important articles, and writes a report
   with sources.
2. **Stock news research**: the same for individual companies: earnings,
   guidance, upgrades and downgrades, M&A, unusual movers.
3. **Candidates**: up to *Picks per day* tickers from both reports, under your
   strategy, minus your *Never pick* list.
4. **Verdict** per candidate. The state is the price indicators (returns,
   moving averages, volatility, RSI, the 52-week range, performance against
   SPY), recent headlines, the thesis and catalyst, and the **track record**
   of past picks. Four fixed-choice questions:
   - action: buy / hold / skip, for about 20 trading days
   - direction over 5 trading days: up / flat / down (±1%)
   - direction over 20 trading days: up / flat / down (±3%)
   - conviction: weak / fair / strong / overwhelming

   The **decision model runs on your own servers** (Settings → Stock picks →
   Decision model):
   - *OpenAI-compatible model*: Argos, llama-server, Ollama or any `/v1`
     endpoint. It gets the state and the questions and must answer as strict
     JSON. Leave the address empty to use Golem's endpoint.
   - *Jev-format service*: a self-hosted service that speaks Jev's request
     format (`POST {model, state, questions}` → `{answers: {id: {choice,
     probabilities, confidence}}}`), at the URL you give.

   An answer that isn't one of the options counts as skip / flat, never as a
   buy, and a model that doesn't answer leaves the pick at skip.
5. **Your call**: each pick waits on the Picks tab. Enter an amount, then
   *I'm buying* or *Pass*.
6. **The order** (optional): with Robinhood connected and orders turned on,
   a pick you're buying gets *Place a $N order on Robinhood…*.

## Robinhood

Robinhood lets agents trade through its **Trading MCP server**
(`https://agent.robinhood.com/mcp/trading`), in a separate **agentic account**
that you open and fund. Orb connects to it as an agent:

1. Settings → Robinhood → **Connect Robinhood**. Orb finds Robinhood's
   sign-in server, registers itself, and sends you to Robinhood to approve
   it (OAuth with PKCE). Robinhood sends you back to Orb, so open Orb by the
   address you want it to return to (behind a tunnel, its https address).
2. Pick the **order tool** and the **account tool** from the tools Robinhood
   offers (Orb guesses both), set the **per-order** and **per-day** caps, and
   turn on **Let Orb place orders**. It is off until you do.
3. On a pick you're buying, *Place a $N order…* shows the exact call Orb
   will make (tool and arguments, filled in from the tool's schema). Edit it
   if Robinhood needs more, then **Send this order**.

The server checks every order, whatever the page sends:

- only you, signed in; Golem and API-token agents never get these tools;
- only for a pick you said *I'm buying* to, for that pick's ticker, and only
  a buy (sell on Robinhood);
- within the per-order cap, and the day's total within the daily cap;
- written to `orders` before it is sent, with Robinhood's answer after.
  Orders can't be edited or deleted through the API.

The Picks tab also shows the agentic account through the account tool. Tokens
stay in Orb's database, outside every collection the API serves.

Turn on Robinhood's own **Trade approvals** for a second check. Robinhood
says agents can misread instructions or act on stale data, and you carry the
risk of every order they place.

### History and scorecard

Every pick is tracked after 1, 5, 20 and 60 trading days, whether you bought
it or passed. A passed pick shows what your amount (or the default amount)
would have made. The scorecard shows:

- profit and loss of what you bought, and what you passed on would have made;
- the average return of "buy" verdicts;
- direction accuracy and Brier score, next to two baselines: always "flat",
  and momentum (the sign of the last 20 days). A model that can't beat those
  isn't telling you anything.

The track record goes into every new verdict, so the model sees how its past
calls did. Each pick keeps its full state, the verdict, and the prompt
version, so changes to the questions can be compared later.

### Be careful

The projects this is modelled on measured their results and lost:
jev_stock's backtest was right 45% of the time, and beebots lost 21% in a
month with real money. Treat a verdict as a guess to log and check, not
advice. Agents (API tokens) can't run research or decide on picks; that needs
you, signed in.

### Settings

Settings → Stock picks: daily run on or off, the hour, weekdays only, picks
per day, default amount, the index to compare with, tickers never to pick,
and the strategy text that goes into every research pass and verdict.
