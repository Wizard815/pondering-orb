/** The zone every "today" uses: TZ from .env (passed by compose), else the
 *  system's. An unknown TZ falls back to UTC, and the server says so. */
export const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
export const badTimeZone = () => !!process.env.TZ && !Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Calendar days in the server's own time zone (set TZ in the container).
 *  toISOString() would give UTC days, which roll over at the wrong hour. */
export function localDay(d: Date | number = new Date()): string {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}
export const today = () => localDay();
/** "HH:MM" of an event start in the server's zone. A UTC instant ("…Z", as
 *  CalDAV gives) is converted; a floating local time is kept as written. */
export function localClock(start: string): string {
  if (!/T\d{2}:\d{2}/.test(start)) return "";
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(start)) return start.slice(11, 16);
  const x = new Date(start); if (Number.isNaN(x.getTime())) return start.slice(11, 16);
  return `${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}`;
}
export const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T12:00:00Z")) && new Date(s + "T12:00:00Z").toISOString().startsWith(s);
