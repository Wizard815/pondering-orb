/** Talks to the Orb server for the desktop app: sign-in, the web view's
 *  session, the glance (tray, mini view, offline view) and alerts. Every
 *  request carries the Cloudflare Access service token when one is set. */
export class OrbError extends Error {}
export class SignedOut extends OrbError {}

export type Access = { clientId?: string; clientSecret?: string; cookie?: string };
export type Glance = {
  at: number; day: string;
  uptime: { total: number; down: string[] } | null;
  events: { time: string; title: string; calendar?: string }[];
  tasks: { id: string; title: string; due: string; overdue: boolean; list?: string }[];
  chores: { id: string; name: string; due: string }[];
  brief: { day: string; headline: string } | null;
  media: { name: string; type: string; line: string }[];
  alerts: number; errors: string[];
};
export type Alert = { id: string; at: number; event: string; title: string; message: string; priority: number; tags: string[] };

/** "orb.example.com" → "https://orb.example.com"; keeps a path (Orb behind /orb), drops the rest. */
export function cleanUrl(input: string): string {
  let s = String(input || "").trim();
  if (!s) throw new OrbError("Type Orb's address, like https://orb.thefellashub.com.");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u: URL;
  try { u = new URL(s); } catch { throw new OrbError(`"${input}" isn't an address. Type it like https://orb.thefellashub.com.`); }
  if (u.username || u.password) throw new OrbError("Leave the user name and password out of the address.");
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

export function accessHeaders(a: Access): Record<string, string> {
  const h: Record<string, string> = {};
  if (a.clientId && a.clientSecret) { h["CF-Access-Client-Id"] = a.clientId; h["CF-Access-Client-Secret"] = a.clientSecret; }
  if (a.cookie) h.Cookie = `CF_Authorization=${a.cookie}`;
  return h;
}

export class Orb {
  constructor(public base: string, public token = "", public access: () => Access = () => ({}), private fetcher: typeof fetch = fetch) {}

  private async call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    let r: Response;
    try {
      r = await this.fetcher(this.base + path, {
        method, redirect: "manual", signal: AbortSignal.timeout(20000),
        headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...accessHeaders(this.access()), ...(auth && this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e: any) {
      throw new OrbError(`Orb isn't answering at ${this.base} (${e?.cause?.code || e?.name || e?.message}). Check the address, your internet and that the tunnel is up.`);
    }
    // Cloudflare Access sends people to its sign-in page; the app can't follow that in the background.
    if (r.status >= 300 && r.status < 400 || /cloudflareaccess\.com/.test(r.headers.get("location") || "")) {
      throw new OrbError("Cloudflare Access is asking for a sign-in. Open Orb's window and sign in there, or add a service token in Settings.");
    }
    const text = await r.text();
    let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (r.status === 401 && auth && this.token) throw new SignedOut("This computer was signed out of Orb (removed in Settings → Devices, or Orb was reset). Sign in again.");
    if (r.status === 403 && !data) throw new OrbError("Cloudflare refused the request. Check the service token in Settings.");
    if (!r.ok) throw new OrbError(data?.error || `Orb answered ${r.status}.`);
    if (data === null && text) throw new OrbError("That address answered with a web page, not Orb. Check the address.");
    return data as T;
  }

  async signIn(password: string, name: string, platform: string) {
    return this.call<{ id: string; name: string; token: string }>("POST", "/api/devices", { password, name, platform }, false);
  }
  /** A fresh session cookie for the window, bought with this computer's key. */
  session() { return this.call<{ session: string; maxAge: number }>("POST", "/api/devices/session"); }
  glance() { return this.call<Glance>("GET", "/api/glance"); }
  alerts(since: number) { return this.call<{ now: number; alerts: Alert[] }>("GET", `/api/alerts?since=${since}`); }
  done(taskId: string) { return this.call<{ ok: boolean }>("POST", `/api/glance/tasks/${encodeURIComponent(taskId)}/done`, {}); }
  signOut(id: string) { return this.call<void>("DELETE", `/api/devices/${encodeURIComponent(id)}`); }
}

/** The tray's tooltip and the first menu line. */
export function trayLine(g: Glance | undefined, error = ""): string {
  if (error) return `Orb: ${error.split(".")[0]}`;
  if (!g) return "Pondering Orb";
  if (g.uptime?.down.length) return g.uptime.down.length === 1 ? `Orb: ${g.uptime.down[0]} is down` : `Orb: ${g.uptime.down.length} services down`;
  return g.uptime ? `Orb: all ${g.uptime.total} up` : "Pondering Orb";
}

/** Which new alerts get a notification: the last three, so a backlog doesn't flood the screen. */
export function toNotify(alerts: Alert[], max = 3): { show: Alert[]; more: number } {
  return { show: alerts.slice(-max), more: Math.max(0, alerts.length - max) };
}
