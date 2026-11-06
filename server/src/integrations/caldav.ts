import { call, trimSlash } from "./http.js";
import { HttpError } from "../records.js";

export type Collection = { href: string; name: string };
export type Item = { href: string; etag: string; ics: string };

/** A plain CalDAV client: works with vikunja, Radicale, Nextcloud or any server
 *  that speaks the standard. `url` is the calendar home (the folder that
 *  holds task lists). */
export class CalDav {
  constructor(private url: () => string, private creds: () => { user: string; pass: string }) {}
  private auth(): Record<string, string> { const { user, pass } = this.creds(); return user ? { Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") } : {}; }
  /** An href from the server, made absolute. It must stay on the configured
   *  server: the login is sent with every request. */
  private abs(href: string) {
    const base = new URL(trimSlash(this.url()) + "/"), u = new URL(href, base);
    if (u.origin !== base.origin) throw new HttpError(502, `CalDAV pointed at another server (${u.host}); Orb only talks to ${base.host}.`);
    return u.toString();
  }
  get configured() { return !!this.url(); }

  private home = ""; private homeFor = "";
  /** Collections that hold VTODOs. The URL can be the calendar home, the
   *  principal, or just the server's DAV root: when it holds no task lists,
   *  Orb follows current-user-principal → calendar-home-set (RFC 6638 / 4791). */
  async lists(): Promise<Collection[]> {
    if (!this.url()) throw new HttpError(503, "CalDAV isn't set up. Add its URL in Settings → Connections.");
    if (this.homeFor !== this.url()) { this.home = ""; this.homeFor = this.url(); }
    if (this.home) return this.collections(this.home);
    const direct = await this.collections(trimSlash(this.url()) + "/");
    if (direct.length) { this.home = trimSlash(this.url()) + "/"; return direct; }
    const found = await this.discoverHome();
    if (!found) return [];
    this.home = found; return this.collections(found);
  }
  /** Calendars that hold events (VEVENT), for the Daily page and Calendar. */
  async eventLists(): Promise<Collection[]> {
    await this.lists(); // finds the calendar home
    if (!this.home) return [];
    return this.collections(this.home, "VEVENT");
  }
  /** Events between two instants, with recurring ones expanded by the server
   *  (RFC 4791 calendar-data expand), so a weekly meeting shows each week. */
  async events(list: Collection, from: Date, to: Date): Promise<string[]> {
    const t = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const body = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data><c:expand start="${t(from)}" end="${t(to)}"/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${t(from)}" end="${t(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const r = await call(this.abs(list.href), { method: "REPORT", headers: { Depth: "1", "Content-Type": "application/xml", ...this.auth() }, body, timeoutMs: 30000 });
    if (r.status !== 207) throw new HttpError(502, `CalDAV answered ${r.status} for ${list.name}.`);
    return responses(String(r.body)).map(x => decodeXml(tag(x.xml, "calendar-data"))).filter(x => x.includes("VEVENT"));
  }
  private async collections(url: string, comp = "VTODO"): Promise<Collection[]> {
    const body = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>`;
    const r = await call(url, { method: "PROPFIND", headers: { Depth: "1", "Content-Type": "application/xml", ...this.auth() }, body });
    if (r.status === 401) throw new HttpError(502, "CalDAV refused the user name or password.");
    if (r.status !== 207) throw new HttpError(502, `CalDAV answered ${r.status} when listing task lists.`);
    return responses(String(r.body)).filter(x => /<(?:[a-z0-9]+:)?calendar\b/i.test(x.xml) && (new RegExp(`<[^>]*comp[^>]*name="${comp}"`, "i").test(x.xml) || !/supported-calendar-component-set/i.test(x.xml)))
      .map(x => ({ href: x.href, name: tag(x.xml, "displayname") || decodeURIComponent(x.href.replace(/\/$/, "").split("/").pop() || "Tasks") }));
  }
  /** current-user-principal, then its calendar-home-set. */
  private async discoverHome(): Promise<string> {
    const ask = async (url: string, prop: string) => {
      const r = await call(url, { method: "PROPFIND", headers: { Depth: "0", "Content-Type": "application/xml", ...this.auth() },
        body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>${prop}</d:prop></d:propfind>` });
      return r.status === 207 ? String(r.body) : "";
    };
    const root = trimSlash(this.url()) + "/";
    const p = tag(tag(await ask(root, "<d:current-user-principal/>"), "current-user-principal"), "href");
    const principal = p ? this.abs(decodeXml(p)) : root;
    const h = tag(tag(await ask(principal, "<c:calendar-home-set/>"), "calendar-home-set"), "href");
    return h ? this.abs(decodeXml(h)) : "";
  }
  /** Every VTODO in one list, with href and etag. */
  async todos(list: Collection): Promise<Item[]> {
    const body = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter></c:calendar-query>`;
    const r = await call(this.abs(list.href), { method: "REPORT", headers: { Depth: "1", "Content-Type": "application/xml", ...this.auth() }, body, timeoutMs: 30000 });
    if (r.status !== 207) throw new HttpError(502, `CalDAV answered ${r.status} for ${list.name}.`);
    return responses(String(r.body)).map(x => ({ href: x.href, etag: decodeXml(tag(x.xml, "getetag")), ics: decodeXml(tag(x.xml, "calendar-data")) })).filter(x => x.ics.includes("VTODO"));
  }
  /** Write a VTODO. With etag: only if unchanged (412 means someone else
   *  changed it). Without: only if it doesn't exist yet. */
  async put(href: string, ics: string, etag?: string) {
    const r = await call(this.abs(href), { method: "PUT", headers: { "Content-Type": "text/calendar; charset=utf-8", ...(etag ? { "If-Match": etag } : { "If-None-Match": "*" }), ...this.auth() }, body: ics });
    if (r.status === 412) throw new HttpError(409, "The task changed on the CalDAV server. Sync and try again.");
    if (r.status >= 300) throw new HttpError(502, `CalDAV answered ${r.status} when saving.`);
    return { etag: r.headers.get("etag") || undefined };
  }
  async del(href: string, etag?: string) {
    let r = await call(this.abs(href), { method: "DELETE", headers: { ...(etag ? { "If-Match": etag } : {}), ...this.auth() } });
    // Changed on the server since Orb last saw it: it was still deleted in Orb, so delete it anyway.
    if (r.status === 412 && etag) r = await call(this.abs(href), { method: "DELETE", headers: this.auth() });
    if (r.status >= 300 && r.status !== 404) throw new HttpError(502, `CalDAV answered ${r.status} when deleting.`);
  }
}

function responses(xml: string) {
  const out: { href: string; xml: string }[] = [];
  const re = /<(?:[a-z0-9]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9]+:)?response>/gi; let m;
  while ((m = re.exec(xml))) { const href = tag(m[1], "href"); if (href) out.push({ href: decodeXml(href), xml: m[1] }); }
  return out;
}
function tag(xml: string, name: string) { const m = new RegExp(`<(?:[a-z0-9]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[a-z0-9]+:)?${name}>`, "i").exec(xml); return m ? m[1].trim() : ""; }
/** XML text → string: CDATA, the five named entities and every numeric one
 *  (sabre/dav writes &quot; in ETags, Go's encoder writes &#34; and &#xA;). */
const NAMED: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
const decodeXml = (s: string) => {
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(s); if (cdata) return cdata[1];
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : NAMED[e] ?? m);
};
