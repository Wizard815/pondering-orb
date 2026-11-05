import type { Records } from "./records.js";
import type { Upstream } from "./integrations/upstream.js";

/** Logs new commits for projects linked to an UpstreamManager repo with
 *  "Log new commits" on. last_logged_sha stops a commit being logged twice;
 *  the first run only remembers where the branch is, so old history isn't
 *  dumped into the log. */
export async function logCommits(r: Records, up: Upstream, logMax: number) {
  const done: string[] = [];
  for (const p of r.list("projects") as any[]) {
    if (!p.upstreamRepo || !p.logCommits || p.archived) continue;
    let items: any[] = [];
    try { items = (await up.commits(p.upstreamRepo, 30))?.items || []; } catch { continue; }
    if (!items.length) continue;
    if (!p.lastLoggedSha) { r.patch("projects", p.id, { lastLoggedSha: items[0].full }); continue; }
    const idx = items.findIndex(c => c.full === p.lastLoggedSha);
    const fresh = (idx < 0 ? items : items.slice(0, idx)).reverse();
    for (const c of fresh) {
      const text = String(c.subject).length > logMax ? String(c.subject).slice(0, logMax - 1).trimEnd() + "…" : String(c.subject);
      try { r.create("logs", { project: p.name, text, by: "git", sha: c.sha, date: String(c.date).slice(0, 10), created: Date.parse(c.date) || Date.now() }); } catch { /* skip */ }
    }
    if (fresh.length) { r.patch("projects", p.id, { lastLoggedSha: items[0].full }); done.push(`${p.name}: ${fresh.length}`); }
  }
  return done;
}
