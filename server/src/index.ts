import { resolve, dirname } from "node:path";
import { accessSync, constants, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { logCommits } from "./pollers.js";
import { badTimeZone, timeZone } from "./dates.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.ORB_DATA || "/data";
try {
  mkdirSync(dataDir, { recursive: true });
  accessSync(dataDir, constants.W_OK);
} catch {
  const uid = typeof process.getuid === "function" ? process.getuid() : "?";
  console.error(`Pondering Orb can't write to its data folder ${dataDir} (running as uid ${uid}).\n` +
    `On the host, make the folder you mounted there writable for that user, e.g.:\n  mkdir -p data && sudo chown ${uid}:${uid} data`);
  process.exit(1);
}
const { app, auth, records, upstream, cfg, sync, outbox, writeDigest, daily, market, journal } = await buildApp({
  dataFile: resolve(dataDir, "orb.db"),
  webDir: process.env.ORB_WEB || resolve(here, "../../web/dist"),
  logger: true,
});
if (badTimeZone()) app.log.warn(`TZ=${process.env.TZ} isn't a time zone Orb knows (use a name like Europe/London or America/Chicago); using UTC.`);
app.log.info(`Days follow the ${timeZone()} time zone (set TZ in .env to change it).`);
if (auth.open) app.log.warn("No ORB_PASSWORD or ORB_API_TOKENS set: anyone who can reach this port can use Orb. Fine on a private LAN, never on a tunnel.");

const port = cfg().port, host = process.env.HOST || "0.0.0.0";
await app.listen({ port, host });

// Log new commits for linked projects every pollMinutes.
const tick = async () => { if (!cfg().upstream.baseUrl) return; try { const done = await logCommits(records, upstream, cfg().logMax); if (done.length) app.log.info({ done }, "logged commits"); } catch (e) { app.log.warn(e, "commit poll failed"); } };
setInterval(tick, Math.max(1, cfg().pollMinutes) * 60000).unref();
setTimeout(tick, 15000).unref();

// Pull CalDAV task lists and chores.
const pullTasks = async () => { if (!cfg().caldav.url) return; try { await sync.pull(); } catch (e: any) { sync.lastError = e.message; app.log.warn({ err: e.message }, "CalDAV sync failed"); } };
setInterval(pullTasks, 5 * 60000).unref();
setTimeout(pullTasks, 3000).unref();

// Retry writes that failed to reach CalDAV or the wiki.
setInterval(() => { outbox.flush().then(r => { if (r.done || r.failed) app.log.info(r, "outbox"); }).catch(() => {}); }, 60000).unref();
// Yesterday's digest in the wiki log, when turned on (checked hourly, written once a day).
setInterval(() => { writeDigest().catch(e => app.log.warn({ err: e.message }, "digest failed")); }, 3600000).unref();
setTimeout(() => { writeDigest().catch(() => {}); }, 20000).unref();

// The morning brief (Daily page) once its hour has passed, and the stock
// research run on market days; both are checked every five minutes.
setInterval(() => { daily.morningTick().catch(e => app.log.warn({ err: e.message }, "morning brief failed")); market.tick().catch(e => app.log.warn({ err: e.message }, "market research failed")); }, 5 * 60000).unref();
setTimeout(() => { daily.morningTick().catch(() => {}); }, 30000).unref();

// Save yesterday's journal log once the day is over (checked every half hour).
setInterval(() => { journal.tick().catch(e => app.log.warn({ err: e.message }, "journal log failed")); }, 30 * 60000).unref();
setTimeout(() => { journal.tick().catch(() => {}); }, 45000).unref();

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, async () => { await app.close(); process.exit(0); });
