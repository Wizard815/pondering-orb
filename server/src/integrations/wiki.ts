import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { call, trimSlash } from "./http.js";
import { HttpError } from "../records.js";
import { today } from "../dates.js";

export type Note = { path: string; title: string; type?: string; area?: string; project_status?: string; status?: string; tags?: string[]; updated?: string; related?: string[]; body: string };

/** The LLMWIKI vault. Reads come from the read-only vault mount when it's
 *  there (fast, sees every file); every write goes through the Obsidian Local
 *  REST API, never the files, so ownership and the vault's rules hold. */
export class Wiki {
  constructor(private base: () => string, private key: () => string, private vault: () => string) {}
  private h(extra: Record<string, string> = {}) { const k = this.key(); return { ...(k ? { Authorization: `Bearer ${k}` } : {}), ...extra }; }
  /** REST address of a vault path. Dot segments are refused (fetch would
   *  resolve them, so "wiki/../raw/x.md" would reach raw/), and writes must
   *  stay under wiki/. */
  private url(path: string, write = false) {
    const b = trimSlash(this.base()); if (!b) throw new HttpError(503, "The wiki isn't set up. Add its address in Settings → Connections.");
    const parts = path.replace(/\/$/, "").split("/");
    if (parts.some(x => x === "." || x === ".." || /[\\\x00-\x1f]/.test(x)) || parts.slice(0, -1).some(x => !x)) throw new HttpError(400, "That isn't a vault path.");
    if (write && parts[0] !== "wiki") throw new HttpError(403, "Orb only edits notes under wiki/, never raw/.");
    return `${b}/vault/${parts.map(encodeURIComponent).join("/")}${path.endsWith("/") ? "/" : ""}`;
  }

  /** The mount counts only when it holds the vault (an empty folder Docker
   *  made for a missing path would hide every note). */
  async hasMount() { try { return (await stat(this.vault())).isDirectory() && (await stat(join(this.vault(), "wiki"))).isDirectory(); } catch { return false; } }

  /** Every .md note with its front-matter (body left out). */
  async tree(): Promise<Omit<Note, "body">[]> {
    if (await this.hasMount()) {
      const root = this.vault(), out: Omit<Note, "body">[] = [];
      const walk = async (dir: string) => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          if (e.name.startsWith(".")) continue; // .obsidian, .git, .trash
          const p = join(dir, e.name);
          if (e.isDirectory()) await walk(p);
          else if (e.name.endsWith(".md")) { const { fm } = split(await readFile(p, "utf8")); out.push(meta(relative(root, p).split("\\").join("/"), fm)); }
        }
      };
      await walk(root); return out;
    }
    // No mount: list wiki/ through the REST API (front-matter comes per note).
    const out: Omit<Note, "body">[] = [];
    const walk = async (dir: string) => {
      const r = await call(this.url(dir).replace(/\/?$/, "/"), { headers: this.h() });
      if (!r.ok) throw new HttpError(502, `The wiki answered ${r.status} for ${dir}.`);
      for (const f of r.body?.files || []) { if (f.endsWith("/")) await walk(dir.replace(/\/?$/, "/") + f.replace(/\/$/, "")); else if (f.endsWith(".md")) out.push({ path: dir.replace(/\/?$/, "/") + f, title: f.replace(/\.md$/, "").split("/").pop()! }); }
    };
    await walk("wiki"); return out;
  }

  async note(path: string): Promise<Note> {
    let text: string;
    const fromMount = await this.hasMount() ? await readFile(join(this.vault(), path), "utf8").catch((e: any) => { if (e.code === "ENOENT") throw new HttpError(404, `No note at ${path}.`); throw new HttpError(500, "Couldn't read that note from the vault mount."); }) : null;
    if (fromMount !== null) text = fromMount;
    else { const r = await call(this.url(path), { headers: this.h({ Accept: "text/markdown" }) }); if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, `The wiki answered ${r.status} for ${path}.`); text = String(r.body); }
    const { fm, body } = split(text);
    return { ...meta(path, fm), body };
  }

  /** Replace one section by its heading path (e.g. "Pondering Orb::Next steps"),
   *  set `updated` to today, and log the edit. */
  async replaceSection(path: string, heading: string, text: string, log: string) {
    const n = await this.note(path);
    const h1 = /^#\s+(.+)$/m.exec(n.body)?.[1]?.trim();
    const target = h1 ? `${h1}::${heading}` : heading;
    await this.patch(path, { Operation: "replace", "Target-Type": "heading", Target: encodeURIComponent(target) }, text.trim() + "\n");
    await this.setFront(path, "updated", today());
    await this.log(log);
  }
  /** Add [[links]] to a note's `related` front-matter. Only notes that exist
   *  are added, existing entries are never removed, and the edit is logged. */
  async addRelated(path: string, titles: string[]) {
    const n = await this.note(path), existing = n.related || [];
    const known = new Set((await this.tree()).map(x => x.title));
    const have = new Set(existing.map(r => r.replace(/^\[\[|\]\]$/g, "")));
    const add = titles.filter(t => t && t !== n.title && known.has(t) && !have.has(t));
    if (!add.length) return { added: [], related: existing };
    const related = [...existing, ...add.map(t => `[[${t}]]`)];
    await this.setFront(path, "related", related);
    await this.setFront(path, "updated", today());
    await this.log(`[[${n.title}]]: related ${add.map(t => `[[${t}]]`).join(", ")}`);
    return { added: add, related };
  }
  async setFront(path: string, key: string, value: unknown) {
    await this.patch(path, { Operation: "replace", "Target-Type": "frontmatter", Target: key, "Content-Type": "application/json", "Create-Target-If-Missing": "true" }, JSON.stringify(value));
  }
  private async patch(path: string, headers: Record<string, string>, body: string) {
    const r = await call(this.url(path, true), { method: "PATCH", headers: this.h({ "Content-Type": "text/markdown", ...headers }), body });
    if (!r.ok) throw new HttpError(502, `The wiki refused the edit (${r.status}): ${typeof r.body === "string" ? r.body.slice(0, 160) : r.body?.message || ""}`);
  }
  /** Append a bullet under "## Pondering Orb" in today's log, creating the
   *  file from the LOG template when it doesn't exist. */
  private logChain: Promise<unknown> = Promise.resolve();
  /** Log writes run one at a time: two at once on a new day would both
   *  create the file and the second would overwrite the first. */
  log(line: string): Promise<void> {
    const run = this.logChain.then(() => this.logNow(line));
    this.logChain = run.catch(() => {});
    return run;
  }
  private async logNow(line: string) {
    line = line.replace(/[\r\n]+/g, " ");
    const d = today(), path = `wiki/logs/Log - ${d}.md`, bullet = `- ${line}\n`;
    const r = await call(this.url(path), { headers: this.h({ Accept: "text/markdown" }) });
    if (r.status === 404) {
      const body = `---\ntitle: "Log - ${d}"\ntype: log\ntags: [wiki, log]\ncreated: ${d}\nupdated: ${d}\nsource: ""\nstatus: draft\n---\n# Log - ${d}\n\n## Pondering Orb\n${bullet}`;
      const w = await call(this.url(path, true), { method: "PUT", headers: this.h({ "Content-Type": "text/markdown" }), body }); if (!w.ok) throw new HttpError(502, `The wiki refused the log (${w.status}).`); return;
    }
    const text = String(r.body || "");
    if (/^##\s+Pondering Orb\s*$/m.test(text)) { const h1 = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || `Log - ${d}`; await this.patch(path, { Operation: "append", "Target-Type": "heading", Target: encodeURIComponent(`${h1}::Pondering Orb`) }, bullet); }
    else { const w = await call(this.url(path, true), { method: "POST", headers: this.h({ "Content-Type": "text/markdown" }), body: `\n## Pondering Orb\n${bullet}` }); if (!w.ok) throw new HttpError(502, `The wiki refused the log (${w.status}).`); }
  }
  /** New project note from the PROJECT template, linked from its area hub. */
  async createProject(name: string, area: string, status: string, next: string, hub: string) {
    if (!isNoteName(name)) throw new HttpError(422, "That project name can't be a note name (no / \\ [ ] | # ^ : or line breaks).");
    next = next.replace(/[\r\n]+/g, " ");
    const d = today(), path = `wiki/1-projects/${name}.md`;
    const exists = await call(this.url(path), { headers: this.h({ Accept: "text/markdown" }) });
    if (exists.ok) return { path, created: false };
    const tags = ["wiki", "project", ...(["homelab", "ai", "ttrpg", "raidlab"].includes(area) ? [area] : [])];
    const body = `---\ntitle: "${name.replace(/"/g, '\\"')}"\ntype: project\narea: ${area}\nproject_status: ${status}\ntags: [${tags.join(", ")}]\ncreated: ${d}\nupdated: ${d}\nsource: manual\nstatus: draft\nrelated: []\n---\n# ${name}\n\n**Area:** [[${hub}]]\n**Goal / finish line:** \n\n## Current state\n- \n\n## Next steps\n- ${next}\n`;
    const w = await call(this.url(path, true), { method: "PUT", headers: this.h({ "Content-Type": "text/markdown" }), body }); if (!w.ok) throw new HttpError(502, `The wiki refused the new note (${w.status}).`);
    let linked = false;
    try { const hubPath = (await this.tree()).find(n => n.path.startsWith("wiki/2-areas/") && n.title === hub)?.path;
      if (hubPath) { await this.patch(hubPath, { Operation: "append", "Target-Type": "heading", Target: encodeURIComponent(`${hub}::Projects`) }, `- [[${name}]]\n`); linked = true; } } catch { /* hub missing or no Projects heading */ }
    await this.log(`[[${name}]]: created from the PROJECT template${linked ? `, linked from [[${hub}]]` : ""}`);
    return { path, created: true, linked };
  }
  async search(q: string) {
    const b = trimSlash(this.base()); if (!b) throw new HttpError(503, "The wiki isn't set up.");
    const r = await call(`${b}/search/simple/?query=${encodeURIComponent(q)}`, { method: "POST", headers: this.h() });
    if (!r.ok) throw new HttpError(502, `The wiki answered ${r.status} to the search.`);
    return (r.body || []).map((x: any) => ({ path: x.filename, score: x.score, snippet: x.matches?.[0]?.context || "" }));
  }
}
function split(text: string) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fm: {} as Record<string, any>, body: text };
  let fm: Record<string, any> = {}; try { fm = parseYaml(m[1]) || {}; } catch { /* bad front-matter */ }
  return { fm, body: text.slice(m[0].length) };
}
function meta(path: string, fm: Record<string, any>) {
  const title = String(fm.title || path.split("/").pop()!.replace(/\.md$/, ""));
  // An unquoted [[Link]] in YAML parses as a nested list; turn it back into the link.
  const related = Array.isArray(fm.related) ? fm.related.map((r: any) => Array.isArray(r) ? `[[${r.flat(Infinity).join("")}]]` : String(r)) : [];
  return { path, title, type: fm.type, area: fm.area, project_status: fm.project_status, status: fm.status, tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [], related, updated: fm.updated ? String(fm.updated).slice(0, 10) : undefined };
}

/** A name that is safe as a note file name and inside [[links]]. */
export const isNoteName = (n: string) => !!n.trim() && !/[\\/\x00-\x1f\[\]|#^:*?"<>]/.test(n) && !n.startsWith(".");
/** A vault path the API may read, or (write) edit: a .md under wiki/, never raw/. */
export function notePath(p: unknown, write = false) {
  const s = String(p || "");
  if (!s.endsWith(".md") || s.split("/").some(x => x === ".." || x === "." || !x) || s.startsWith("/") || /[\\\x00-\x1f]/.test(s)) throw new HttpError(400, "That isn't a note path.");
  if (write && (s.startsWith("raw/") || !s.startsWith("wiki/"))) throw new HttpError(403, "Orb only edits notes under wiki/, never raw/.");
  return s;
}
