# Pondering Orb demo stack

A working Orb in Docker with synthetic data. Every app Orb talks to is
replaced by one small fake server, so every tab has something to show. All
names, numbers, headlines and tickers are made up; the ETF prices are random.

```bash
cd demo/stack
docker compose up -d --build     # the first run builds Orb from this repo
```

Open `http://localhost:8095` (or `ORB_PORT`) and sign in with **demo**.

```bash
docker compose logs seed         # what the seed did
docker compose down -v           # stop and forget everything
```

## What runs

| Service | What it is |
| --- | --- |
| `orb` | Pondering Orb, built from this repo |
| `fakes` | Stand-ins for the ALLGlance gateway (dayGLANCE, lastGLANCE, lifeGLANCE and CalDAV at `/glance/dav/`), Firefly III, Coinpile, Omi, Uptime Kuma, UpstreamManager, Hermes Studio, LLMWIKI's REST API, Plex, SABnzbd, a model for the Golem, a Jev-format decision model, weather, prices and news |
| `seed` | Runs once: projects, the log, Orb's own events, the Ideas board, twelve past stock picks with your calls, and settings; then a CalDAV sync, today's research and the morning brief |
| `docker-proxy` | The read-only Docker socket proxy, so the System tab shows this host's real containers |

`vault/` is a small LLMWIKI vault, mounted read only as in a real setup.

## Things to try

- **Main**: ask the Golem "What's due today?", "How's my money?" or "What did Omi
  hear yesterday?". The fake model calls one of Orb's tools and answers from
  what it returned.
- **Daily**: Write it again rewrites the brief from today's data.
- **Picks**: agree or pass on today's picks, and see the history and scorecard.
- **To-do**: tick a task; the change goes to the fake CalDAV server. Omi's two
  action items are read only.
- **Calendar**: add an event to the family calendar.
- **Upkeep**: run the daily check, approve a request.
- **Settings → Pages**: hide a tab, or turn Picks off.

## Limits

- Robinhood isn't faked (Orb only connects to it over https), so the Robinhood
  panel says it isn't connected.
- The fakes keep everything in memory: restart `fakes` and task changes are
  gone, while Orb's own records stay in the `orb-data` volume.
- Times follow `TZ` (default `America/Chicago`): `TZ=Europe/London docker compose up -d`.
- `ORB_DEMO_SOURCES` points Orb's weather, prices and news at the fakes. Never
  set it on a real Orb.
