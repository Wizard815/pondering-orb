import { call, trimSlash } from "./http.js";
import { secret } from "../config.js";
import { HttpError } from "../records.js";
import type { Companion } from "./companions.js";

/** Coinpile (the friendly view over Firefly III, formerly Goblin-Bank), read
 *  only. A Coinpile API token with the `orb` scope reads
 *  `GET /api/v1/summary`: exactly what you ticked to share with the Orb in
 *  Coinpile → Settings → Home Assistant & API, never transactions.
 *
 *  Firefly III already gives Orb accounts, bills, budgets and piggy banks;
 *  Coinpile adds what Firefly has no place for: savings set aside vs free,
 *  goals, alerts (CD maturities, a bank that needs signing in again,
 *  accounts running short), the spending forecast and Robinhood. */
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isDay = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ""));
const SEV = ["critical", "warning", "info"] as const;

export type CpBill = { date: string; name: string; amount: number; category: string };
/** `date` is set when the alert is about a day (a CD maturing, a bill due). */
export type CpAlert = { severity: "critical" | "warning" | "info"; kind: string; title: string; detail: string; date: string };
export type CpSummary = {
  name: string; netWorth: number | null; subscriptionsMonthly: number | null;
  bills: { next7d: number | null; next30d: number | null; next: { name: string; date: string; amount: number | null } | null } | null;
  alerts: { total: number; critical: number; warning: number } | null;
  savings: { total: number | null; free: number | null; earmarked: number | null } | null;
  /** pct is 0–1 (Coinpile's own scale). */
  goals: { name: string; target: number | null; allocated: number | null; pct: number | null }[] | null;
  /** pctOfIncome is worked out here (projected / average income, 0–1+). */
  spending: { soFar: number | null; projected: number | null; incomeAvg: number | null; leftAfter: number | null; pctOfIncome: number | null } | null;
  robinhoodMain: { value: number | null; asOf: string } | null; robinhoodAgent: { value: number | null; asOf: string } | null;
  billList: CpBill[] | null; alertList: CpAlert[] | null;
  /** CDs and bonds nearing or past maturity (from the alert list), soonest first. */
  maturities: CpAlert[]; at: number;
};

async function get(c: Companion, path: string) {
  const base = trimSlash(c.url); if (!base) throw new HttpError(400, `${c.name} has no url in the apps YAML.`);
  const key = secret(c.keyEnv);
  const r = await call(`${base}${path}`, { method: "GET", headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) } });
  if (r.status === 401) throw new HttpError(502, `${c.name} refused the token${c.keyEnv ? ` in ${c.keyEnv}` : ""}.`);
  if (r.status === 403) throw new HttpError(502, `${c.name}'s token needs the "orb" scope (Coinpile → Settings → Home Assistant & API).`);
  if (r.status === 429) throw new HttpError(502, `${c.name} says Orb asks too often; it will try again shortly.`);
  if (!r.ok) throw new HttpError(502, `${c.name} answered ${r.status}.`);
  return r.body;
}

const cache = new Map<string, { at: number; v: CpSummary }>();
export const clearCoinpileCache = () => cache.clear();

export async function cpSummary(c: Companion): Promise<CpSummary> {
  const hit = cache.get(c.url); if (hit && Date.now() - hit.at < 5 * 60000) return hit.v;
  const body = await get(c, "/api/v1/summary");
  // The token belongs to one person: the answer holds just them.
  const [name, g]: [string, any] = Object.entries(body?.goblins || {})[0] as any || ["me", {}];
  const rh = (x: any) => (x && typeof x === "object" ? { value: num(x.value), asOf: String(x.as_of || "") } : null);
  const alertList: CpAlert[] | null = Array.isArray(g.alert_list) ? g.alert_list.slice(0, 50).map((a: any) => ({
    severity: (SEV.includes(a?.severity) ? a.severity : "info") as CpAlert["severity"], kind: String(a?.kind || ""), title: String(a?.title || ""), detail: String(a?.detail || ""), date: isDay(a?.date) ? String(a.date) : "",
  })).filter((a: CpAlert) => a.title).sort((x: CpAlert, y: CpAlert) => SEV.indexOf(x.severity) - SEV.indexOf(y.severity)) : null;
  const sp = g.spending && typeof g.spending === "object" ? g.spending : null;
  const v: CpSummary = {
    name, netWorth: num(g.net_worth), subscriptionsMonthly: num(g.subscriptions_monthly),
    bills: g.bills && typeof g.bills === "object" ? { next7d: num(g.bills.next_7d), next30d: num(g.bills.next_30d),
      next: g.bills.next && typeof g.bills.next === "object" ? { name: String(g.bills.next.name || ""), date: String(g.bills.next.date || ""), amount: num(g.bills.next.amount) } : null } : null,
    alerts: g.alerts && typeof g.alerts === "object" ? { total: Number(g.alerts.total) || 0, critical: Number(g.alerts.critical) || 0, warning: Number(g.alerts.warning) || 0 } : null,
    savings: g.savings && typeof g.savings === "object" ? { total: num(g.savings.total), free: num(g.savings.free), earmarked: num(g.savings.earmarked) } : null,
    goals: Array.isArray(g.goals) ? g.goals.slice(0, 20).map((x: any) => ({ name: String(x?.name || ""), target: num(x?.target), allocated: num(x?.allocated), pct: num(x?.pct) })).filter((x: any) => x.name) : null,
    spending: sp ? { soFar: num(sp.so_far), projected: num(sp.projected), incomeAvg: num(sp.income_avg), leftAfter: num(sp.left_after),
      pctOfIncome: num(sp.projected) !== null && num(sp.income_avg) ? +(sp.projected / sp.income_avg).toFixed(3) : null } : null,
    robinhoodMain: rh(g.robinhood_main), robinhoodAgent: rh(g.robinhood_agent),
    billList: Array.isArray(g.bill_list) ? g.bill_list.slice(0, 200).map((b: any) => ({ date: String(b?.date || ""), name: String(b?.name || ""), amount: Number(b?.amount) || 0, category: String(b?.category || "") })).filter((b: CpBill) => b.name && isDay(b.date)).sort((x: CpBill, y: CpBill) => x.date.localeCompare(y.date)) : null,
    alertList, maturities: (alertList || []).filter(a => (a.kind === "maturing" || a.kind === "matured_idle") && a.date).sort((x, y) => x.date.localeCompare(y.date)),
    at: Date.now(),
  };
  cache.set(c.url, { at: Date.now(), v }); return v;
}
