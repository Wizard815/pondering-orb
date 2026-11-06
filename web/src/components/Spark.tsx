/** A small price line. Colour follows the move over the period. */
export function Spark({ data, w = 96, h = 26, mark }: { data: number[]; w?: number; h?: number; mark?: number }) {
  const d = data.filter(x => Number.isFinite(x));
  if (d.length < 2) return null;
  const lo = Math.min(...d, mark ?? Infinity), hi = Math.max(...d, mark ?? -Infinity), span = hi - lo || 1;
  const x = (i: number) => (i / (d.length - 1)) * (w - 2) + 1, y = (v: number) => h - 1 - ((v - lo) / span) * (h - 2);
  const up = d.at(-1)! >= d[0];
  return <svg className={"spark " + (up ? "up" : "down")} width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${up ? "Up" : "Down"} ${pct(((d.at(-1)! / d[0]) - 1) * 100)} over the period`}>
    {mark !== undefined && <line x1={0} x2={w} y1={y(mark)} y2={y(mark)} className="spark-mark" />}
    <polyline points={d.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")} fill="none" strokeWidth={1.5} strokeLinejoin="round" />
  </svg>;
}
export const pct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;
export const money = (n: number) => (Number.isFinite(n) ? n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: n >= 1000 ? 0 : 2 }) : "—");
