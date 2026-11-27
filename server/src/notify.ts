import type { Store } from "./db.js";
import type { OrbConfig } from "./config.js";
import { uptime } from "./integrations/uptime.js";
import { ntfySend, ntfyReady, ntfyEvents, type Note, type NtfyEvent } from "./integrations/ntfy.js";

/** Sends Orb's alerts to ntfy when Settings → Connections → ntfy is set up.
 *  A failed send is logged and kept as lastError; it never breaks the thing
 *  that triggered it. */
export class Notifier {
  lastError = ""; lastSent = 0;
  constructor(private cfg: () => OrbConfig, private store: Store, private log: (msg: string, extra?: any) => void = () => {}) {}
  get ready() { return ntfyReady(this.cfg().ntfy); }
  on(event: NtfyEvent) { return this.ready && (event === "test" || ntfyEvents(this.cfg().ntfy).has(event)); }

  /** Send now and report (the Settings test button). */
  async sendNow(note: Note) { await ntfySend(this.cfg().ntfy, note); this.lastSent = Date.now(); this.lastError = ""; }
  /** Send in the background if that kind of notification is on. */
  send(event: NtfyEvent, note: Note): Promise<void> {
    if (!this.on(event)) return Promise.resolve();
    return this.sendNow(note).catch((e: any) => { this.lastError = e?.message || String(e); this.log("ntfy send failed", { err: this.lastError }); });
  }

  private state(): any { return this.store.get("settings", "notify") || {}; }
  private save(patch: any) { const { id: _i, version: _v, ...rest } = this.state(); this.store.set("settings", "notify", { ...rest, ...patch }); }

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
