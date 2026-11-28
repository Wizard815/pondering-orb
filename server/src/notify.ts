import type { Store } from "./db.js";
import { newId } from "./db.js";
import type { OrbConfig } from "./config.js";
import { uptime } from "./integrations/uptime.js";
import { ntfySend, ntfyReady, ntfyEvents, scrub, type Note, type NtfyEvent } from "./integrations/ntfy.js";

/** An alert as Orb's apps read it from /api/alerts (the same words ntfy gets). */
export type Alert = { id: string; at: number; event: string; title: string; message: string; priority: number; tags: string[] };
const KEEP_ALERTS = 100;

/** Sends Orb's alerts to ntfy when Settings → Connections → ntfy is set up,
 *  and keeps the last 100 for Orb's own apps (desktop and Android), which
 *  check /api/alerts. A failed send is logged and kept as lastError; it never
 *  breaks the thing that triggered it. */
export class Notifier {
  lastError = ""; lastSent = 0;
  constructor(private cfg: () => OrbConfig, private store: Store, private log: (msg: string, extra?: any) => void = () => {}, private devices: () => number = () => 0) {}
  get ready() { return ntfyReady(this.cfg().ntfy); }
  /** That kind of alert is on in Settings → Connections → ntfy (all of them when the list is empty). */
  wanted(event: NtfyEvent) { return event === "test" || ntfyEvents(this.cfg().ntfy).has(event); }
  /** Someone will get it: ntfy is set up, or an Orb app is signed in. */
  on(event: NtfyEvent) { return this.wanted(event) && (this.ready || this.devices() > 0); }

  /** Send now and report (the Settings test button). */
  async sendNow(note: Note) { await ntfySend(this.cfg().ntfy, note); this.lastSent = Date.now(); this.lastError = ""; }
  /** Keep it for the apps, and send it to ntfy in the background, if that kind of notification is on. */
  send(event: NtfyEvent, note: Note): Promise<void> {
    if (!this.wanted(event)) return Promise.resolve();
    this.keep(event, note);
    if (!this.ready) return Promise.resolve();
    return this.sendNow(note).catch((e: any) => { this.lastError = e?.message || String(e); this.log("ntfy send failed", { err: this.lastError }); });
  }

  private keep(event: string, note: Note) {
    const a = { at: Date.now(), event, title: scrub(note.title, 120), message: scrub(note.message, 300), priority: note.priority ?? 3, tags: note.tags ?? [] };
    this.store.set("alerts", newId(), a);
    const all = this.store.list("alerts");
    for (const old of all.slice(0, Math.max(0, all.length - KEEP_ALERTS))) this.store.delete("alerts", old.id);
  }
  /** Alerts after a time (ms), oldest first, at most 50. */
  alerts(since = 0): Alert[] {
    return (this.store.list("alerts") as any[]).filter(a => Number(a.at) > since).slice(-50)
      .map(a => ({ id: a.id, at: a.at, event: a.event, title: a.title, message: a.message, priority: a.priority, tags: a.tags }));
  }

  private state(): any { return this.store.get("settings", "notify") || {}; }
  private save(patch: any) { const { id: _i, version: _v, ...rest } = this.state(); this.store.set("settings", "notify", { ...rest, ...patch }); }

  /** Called every couple of minutes with the media widgets' data (see mediaAlerts). */
  async mediaTick(look: () => Promise<MediaLook[]>) {
    if (!this.on("media")) return { sent: 0 };
    const looks = await look();
    if (!looks.length) return { sent: 0 };
    const { notes, state } = mediaAlerts(this.state().media || {}, looks);
    this.save({ media: state });
    for (const n of notes) await this.send("media", n);
    return { sent: notes.length };
  }

  /** Called every couple of minutes: a message when a monitor goes down or
   *  comes back (ignored monitors never), and when Uptime Kuma itself can't be read. */
  async uptimeTick() {
    const c = this.cfg();
    if (!this.on("uptime") || !c.uptime.baseUrl) return { sent: 0 };
    const st = this.state(), wasDown = new Set<string>(Array.isArray(st.down) ? st.down : []);
    let monitors;
    try { ({ monitors } = await uptime(c.uptime.baseUrl, c.uptime.statusPage, c.uptime.ignore)); }
    catch (e: any) {
      if (!st.kumaDown) { this.save({ kumaDown: true }); await this.send("uptime", { title: "Orb can't read Uptime Kuma", message: `${e.message} Down alerts are paused until it answers.`, tags: ["warning"], priority: 4 }); return { sent: 1 }; }
      return { sent: 0 };
    }
    const down = monitors.filter(m => !m.ignored && m.status === "down").map(m => m.name);
    const up = new Set(monitors.filter(m => !m.ignored && m.status === "up").map(m => m.name));
    const fresh = down.filter(n => !wasDown.has(n)), back = [...wasDown].filter(n => up.has(n));
    // A monitor that's pending or gone stays in the down list until it is seen up.
    const keep = [...new Set([...down, ...[...wasDown].filter(n => !up.has(n) && monitors.some(m => m.name === n && !m.ignored))])];
    this.save({ down: keep, kumaDown: false });
    let sent = 0;
    if (st.kumaDown) { await this.send("uptime", { title: "Uptime Kuma answers again", message: "Down alerts are back on.", tags: ["white_check_mark"] }); sent++; }
    if (fresh.length) { await this.send("uptime", { title: fresh.length === 1 ? `${fresh[0]} is down` : `${fresh.length} services are down`, message: `Uptime Kuma: ${fresh.join(", ")} ${fresh.length === 1 ? "is" : "are"} down.`, tags: ["rotating_light"], priority: 4 }); sent++; }
    if (back.length) { await this.send("uptime", { title: back.length === 1 ? `${back[0]} is back up` : `${back.length} services are back up`, message: `Uptime Kuma: ${back.join(", ")} ${back.length === 1 ? "is" : "are"} up again.`, tags: ["white_check_mark"] }); sent++; }
    return { sent };
  }
}

/** Media alerts from the widgets in the apps YAML: new Seerr requests waiting,
 *  Sonarr/Radarr downloads that finished, and ones that got stuck. The first
 *  look only remembers what's there, so nothing old is announced. */
export type MediaLook = { name: string; type: string; data: any };
export function mediaAlerts(prev: Record<string, any>, looks: MediaLook[]): { notes: Note[]; state: Record<string, any> } {
  const notes: Note[] = [], state: Record<string, any> = { ...prev };
  for (const { name, type, data } of looks) {
    const was = prev[name];
    if (type === "seerr" || type === "jellyseerr" || type === "overseerr") {
      const pending = Number(data?.pending) || 0;
      state[name] = { pending };
      if (was && pending > (Number(was.pending) || 0)) {
        const n = pending - (Number(was.pending) || 0);
        notes.push({ title: n === 1 ? `A new request on ${name}` : `${n} new requests on ${name}`, message: `${pending} ${pending === 1 ? "request is" : "requests are"} waiting for approval.`, tags: ["clapper"], priority: 3 });
      }
    } else if (type === "sonarr" || type === "radarr") {
      const queue: any[] = Array.isArray(data?.queue) ? data.queue : [];
      const total = Number(data?.queueTotal) || queue.length;
      const titles = queue.map(q => String(q.title)), stuck = queue.filter(q => q.warning).map(q => String(q.title));
      state[name] = { titles, stuck, total };
      if (!was) continue;
      // Only as many as the queue shrank by: an item can also drop off the end of the short list.
      const gone = (was.titles as string[]).filter(t => !titles.includes(t) && !(was.stuck as string[]).includes(t)).slice(0, Math.max(0, (Number(was.total) || 0) - total));
      if (gone.length) notes.push({ title: gone.length === 1 ? `Downloaded: ${gone[0]}` : `${gone.length} downloads finished`, message: `${name}: ${gone.join(", ")}.`, tags: ["inbox_tray"], priority: 2 });
      const fresh = stuck.filter(t => !(was.stuck as string[]).includes(t));
      if (fresh.length) notes.push({ title: fresh.length === 1 ? `${fresh[0]} is stuck` : `${fresh.length} downloads are stuck`, message: `${name} shows a warning for ${fresh.join(", ")}. Open ${name} to see why.`, tags: ["warning"], priority: 3 });
    }
  }
  return { notes, state };
}
