/** Calendar days in the server's own time zone (set TZ in the container).
 *  toISOString() would give UTC days, which roll over at the wrong hour. */
export function localDay(d: Date | number = new Date()): string {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}
export const today = () => localDay();
export const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T12:00:00Z")) && new Date(s + "T12:00:00Z").toISOString().startsWith(s);
