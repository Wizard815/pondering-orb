import { createServer, Server, IncomingMessage, ServerResponse } from "node:http";
export const SRC = "../src";
export const wait = (ms = 60) => new Promise(r => setTimeout(r, ms));
export type Hit = { method: string; url: string; headers: any; body: string };
export function fake(handler: (req: IncomingMessage, body: string, res: ServerResponse, hits: Hit[]) => void): Promise<{ url: string; server: Server; hits: Hit[] }> {
  const hits: Hit[] = [];
  return new Promise(res => {
    const server = createServer((req, resp) => {
      let body = ""; req.on("data", d => (body += d)); req.on("end", () => { hits.push({ method: req.method!, url: req.url!, headers: req.headers, body }); handler(req, body, resp, hits); });
    }).listen(0, "127.0.0.1", () => res({ url: `http://127.0.0.1:${(server.address() as any).port}`, server, hits }));
  });
}
export const ics = (uid: string, extra: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:${uid}\r\n${extra}\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`;
/** CalDAV fake copied from server/test/sync.test.ts, plus If-Match on DELETE. */
export function fakeDav() {
  const files = new Map<string, { ics: string; etag: string }>(); let n = 0; const puts: any[] = []; const dels: any[] = [];
  files.set("/dav/homelab/a.ics", { ics: ics("a", "SUMMARY:Release notes\r\nPRIORITY:1\r\nDUE;VALUE=DATE:20261110\r\nSTATUS:NEEDS-ACTION"), etag: '"1"' });
  files.set("/dav/chores/b.ics", { ics: ics("b", "SUMMARY:Check backups\r\nRRULE:FREQ=WEEKLY;INTERVAL=1\r\nDUE;VALUE=DATE:20261108"), etag: '"2"' });
  return new Promise<{ url: string; server: Server; files: typeof files; puts: any[]; dels: any[] }>(res => {
    const server = createServer((req, resp) => {
      let body = ""; req.on("data", d => (body += d)); req.on("end", () => {
        const u = req.url!;
        if (req.method === "PROPFIND") {
          const r = (href: string, name: string) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:displayname>${name}</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response>`;
          resp.writeHead(207, { "Content-Type": "application/xml" }); return resp.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>${r("/dav/homelab/", "Homelab")}${r("/dav/chores/", "Chores")}</d:multistatus>`);
        }
        if (req.method === "REPORT") {
          const items = [...files].filter(([h]) => h.startsWith(u)).map(([h, f]) => `<d:response><d:href>${h}</d:href><d:propstat><d:prop><d:getetag>${f.etag}</d:getetag><c:calendar-data>${f.ics.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</c:calendar-data></d:prop></d:propstat></d:response>`).join("");
          resp.writeHead(207, { "Content-Type": "application/xml" }); return resp.end(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${items}</d:multistatus>`);
        }
        if (req.method === "PUT") {
          const cur = files.get(u); puts.push({ url: u, ifMatch: req.headers["if-match"], ifNone: req.headers["if-none-match"], body });
          if (req.headers["if-match"] && cur?.etag !== req.headers["if-match"]) { resp.writeHead(412); return resp.end(); }
          if (req.headers["if-none-match"] === "*" && cur) { resp.writeHead(412); return resp.end(); }
          const etag = `"e${++n}"`; files.set(u, { ics: body, etag }); resp.writeHead(cur ? 204 : 201, { ETag: etag }); return resp.end();
        }
        if (req.method === "DELETE") { const cur = files.get(u); dels.push({ url: u, ifMatch: req.headers["if-match"] });
          if (req.headers["if-match"] && cur && cur.etag !== req.headers["if-match"]) { resp.writeHead(412); return resp.end(); }
          files.delete(u); resp.writeHead(204); return resp.end(); }
        resp.writeHead(405); resp.end();
      });
    }).listen(0, "127.0.0.1", () => res({ url: `http://127.0.0.1:${(server.address() as any).port}/dav/`, server, files, puts, dels }));
  });
}
