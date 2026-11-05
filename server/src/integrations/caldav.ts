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
  private abs(href: string) { return new URL(href, trimSlash(this.url()) + "/").toString(); }
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
  private async collections(url: string): Promise<Collection[]> {
    const body = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>`;
    const r = await call(url, { method: "PROPFIND", headers: { Depth: "1", "Content-Type": "application/xml", ...this.auth() }, body });
    if (r.status === 401) throw new HttpError(502, "CalDAV refused the user name or password.");
    if (r.status !== 207) throw new HttpError(502, `CalDAV answered ${r.status} when listing task lists.`);
    return responses(String(r.body)).filter(x => /<(?:[a-z0-9]+:)?calendar\b/i.test(x.xml) && (/<[^>]*comp[^>]*name="VTODO"/i.test(x.xml) || !/supported-calendar-component-set/i.test(x.xml)))
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
    return responses(String(r.body)).map(x => ({ href: x.href, etag: tag(x.xml, "getetag"), ics: decodeXml(tag(x.xml, "calendar-data")) })).filter(x => x.ics.includes("VTODO"));
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
    const r = await call(this.abs(href), { method: "DELETE", headers: { ...(etag ? { "If-Match": etag } : {}), ...this.auth() } });
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
const decodeXml = (s: string) => s.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#13;/g, "\r").replace(/&amp;/g, "&");
