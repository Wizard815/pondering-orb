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
   *  resolve them, so "wiki/../raw/x.md" would reach raw/). Writes follow the
   *  vault's Memory Tiers (schema/agents.md): your edits go under wiki/, Orb's
   *  own log under daily/, and "new-source" only adds a file to raw/sources/
   *  (callers check it isn't there yet: sources are never changed). */
  private url(path: string, write: boolean | "new-source" = false) {
    const b = trimSlash(this.base()); if (!b) throw new HttpError(503, "The wiki isn't set up. Add its address in Settings → Connections.");
    const parts = path.replace(/\/$/, "").split("/");
    if (parts.some(x => x === "." || x === ".." || /[\\\x00-\x1f]/.test(x)) || parts.slice(0, -1).some(x => !x)) throw new HttpError(400, "That isn't a vault path.");
    const allowed = write === "new-source" ? parts[0] === "raw" && parts[1] === "sources" && parts.length === 3 : !write || parts[0] === "wiki" || parts[0] === "daily";
    if (!allowed) throw new HttpError(403, "Orb edits notes under wiki/ and writes its log to daily/; it only adds new files to raw/sources/, never changes raw/.");
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
  /** The text of a day's note in daily/ (the vault's short-term memory), or,
   *  when create is set and it doesn't exist, today's from the DAILY template. */
  private async dailyText(day: string, create: boolean): Promise<string | null> {
    const r = await call(this.url(`daily/${day}.md`), { headers: this.h({ Accept: "text/markdown" }) });
    if (r.ok) return String(r.body || "");
    if (r.status !== 404) throw new HttpError(502, `The wiki answered ${r.status} for daily/${day}.md.`);
    if (!create) return null;
    const t = await call(this.url(DAILY_TEMPLATE), { headers: this.h({ Accept: "text/markdown" }) });
    return t.ok ? fillTemplate(String(t.body || ""), day) : `---\ntitle: "${day}"\ntype: daily\ntags: [daily]\ncreated: ${day}\nstatus: open\nrelated: []\n---\n\n# ${day}\n\n## Worked on\n\n- \n`;
  }
  private async putDaily(day: string, text: string) {
    const w = await call(this.url(`daily/${day}.md`, true), { method: "PUT", headers: this.h({ "Content-Type": "text/markdown" }), body: text });
    if (!w.ok) throw new HttpError(502, `The wiki refused daily/${day}.md (${w.status}).`);
  }
  private logChain: Promise<unknown> = Promise.resolve();
  /** One line under "Worked on" in today's daily note, marked (pondering-orb).
   *  Writes run one at a time: two at once on a new day would both create the
   *  note and the second would overwrite the first. Orb never writes wiki/logs:
   *  automation writes only the short-term tier, and Rollover files the day. */
  log(line: string): Promise<void> {
    const run = this.logChain.then(() => this.logNow(line));
    this.logChain = run.catch(() => {});
    return run;
  }
  private async logNow(line: string) {
    line = line.replace(/[\r\n]+/g, " ").trim();
    const d = today();
    const text = (await this.dailyText(d, true))!;
    await this.putDaily(d, insertUnderHeading(text, "Worked on", `${line} (pondering-orb)`));
  }
  /** A day's journal as the "Journal" section of that day's daily note, so it
   *  is filed into the wiki with the rest of the day. Orb rewrites the section
   *  each time (it is Orb's). A past day whose note was already rolled over
   *  goes to raw/sources/YYYY-MM-DD - Journal.md once, for Ingest. */
  async writeJournal(day: string, body: string) {
    const section = body.trim().replace(/^## /gm, "### ");
    const run = this.logChain.then(async () => {
      const text = await this.dailyText(day, day === today());
      if (text !== null) {
        await this.putDaily(day, setSection(text, "Journal", section));
        return { path: `daily/${day}.md`, created: false };
      }
      const path = `raw/sources/${day} - Journal.md`;
      const old = await call(this.url(path), { headers: this.h({ Accept: "text/markdown" }) });
      if (old.ok) return { path, created: false, alreadyFiled: true };
      const d = today();
      const src = `---\ntitle: "${day} - Journal"\ntype: source\ntags: [source]\ncreated: ${d}\nupdated: ${d}\nstatus: unprocessed\n---\n\n# Journal - ${day}\n\n${section}\n`;
      const w = await call(this.url(path, "new-source"), { method: "PUT", headers: this.h({ "Content-Type": "text/markdown" }), body: src });
      if (!w.ok) throw new HttpError(502, `The wiki refused the journal source (${w.status}).`);
      return { path, created: true };
    });
    this.logChain = run.catch(() => {});
    return run;
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
const DAILY_TEMPLATE = "schema/templates/DAILY.md";

/** The DAILY template with its {{date}} / {{title}} placeholders filled. */
export function fillTemplate(text: string, day: string) {
  return text.replace(/\{\{\s*(date|title)(:[^}]*)?\s*\}\}/g, day);
}

/** Add one bullet at the end of a "## heading" section (an empty "- " placeholder is filled instead),
 *  or a new section at the end. Same rule as the vault's own memory_log tool. */
export function insertUnderHeading(text: string, heading: string, line: string) {
  const lines = text.split("\n"), bullet = `- ${line}`;
  const start = lines.findIndex(l => /^#{1,6}\s/.test(l) && l.replace(/^#{1,6}\s+/, "").trim() === heading);
  if (start === -1) return `${text.replace(/\s*$/, "")}\n\n## ${heading}\n\n${bullet}\n`;
  const level = lines[start].match(/^#+/)![0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) { const m = lines[i].match(/^(#+)\s/); if (m && m[1].length <= level) { end = i; break; } }
  for (let i = start + 1; i < end; i++) if (/^-\s*$/.test(lines[i])) { lines[i] = bullet; return lines.join("\n"); }
  let last = end - 1;
  while (last > start && !lines[last].trim()) last--;
  lines.splice(last + 1, 0, ...(last === start ? ["", bullet] : [bullet]));
  return lines.join("\n");
}

/** Replace the body of a "## heading" section, or add the section at the end. */
export function setSection(text: string, heading: string, body: string) {
  const lines = text.split("\n");
  const start = lines.findIndex(l => /^##\s/.test(l) && l.replace(/^##\s+/, "").trim() === heading);
  if (start === -1) return `${text.replace(/\s*$/, "")}\n\n## ${heading}\n\n${body}\n`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^#{1,2}\s/.test(lines[i])) { end = i; break; }
  return [...lines.slice(0, start + 1), "", body, "", ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
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
/** A vault path the API may read, or (write) edit: a .md under wiki/, never raw/ (Orb's own daily/ writes don't come through here). */
export function notePath(p: unknown, write = false) {
  const s = String(p || "");
  if (!s.endsWith(".md") || s.split("/").some(x => x === ".." || x === "." || !x) || s.startsWith("/") || /[\\\x00-\x1f]/.test(s)) throw new HttpError(400, "That isn't a note path.");
  if (write && (s.startsWith("raw/") || !s.startsWith("wiki/"))) throw new HttpError(403, "Orb only edits notes under wiki/, never raw/.");
  return s;
}
