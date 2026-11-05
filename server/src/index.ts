import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { logCommits } from "./pollers.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.ORB_DATA || "/data";
const { app, auth, records, upstream, cfg } = await buildApp({
  dataFile: resolve(dataDir, "orb.db"),
  webDir: process.env.ORB_WEB || resolve(here, "../../web/dist"),
  logger: true,
});
if (auth.open) app.log.warn("No ORB_PASSWORD or ORB_API_TOKENS set: anyone who can reach this port can use Orb. Fine on a private LAN, never on a tunnel.");

const port = cfg().port, host = process.env.HOST || "0.0.0.0";
await app.listen({ port, host });

// Log new commits for linked projects every pollMinutes.
const tick = async () => { if (!cfg().upstream.baseUrl) return; try { const done = await logCommits(records, upstream, cfg().logMax); if (done.length) app.log.info({ done }, "logged commits"); } catch (e) { app.log.warn(e, "commit poll failed"); } };
setInterval(tick, Math.max(1, cfg().pollMinutes) * 60000).unref();
setTimeout(tick, 15000).unref();

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, async () => { await app.close(); process.exit(0); });
