import { call, trimSlash } from "./http.js";
import { secret } from "../config.js";
import { HttpError } from "../records.js";
import { localDay } from "../dates.js";
import type { Companion } from "./companions.js";

/** Firefly III (your finances), read only, through its REST API with a
 *  Personal Access Token (Options → Profile → OAuth → Personal access tokens).
 *  Every request here is a GET. Amounts arrive as strings; spending is
 *  negative. Shapes from Firefly's own transformers (app/Transformers). */
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const day = (v: unknown) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? "")); return m ? m[1] : ""; };
const monthStart = (d = new Date()) => localDay(new Date(d.getFullYear(), d.getMonth(), 1));
const monthEnd = (d = new Date()) => localDay(new Date(d.getFullYear(), d.getMonth() + 1, 0));
const plusDays = (iso: string, k: number) => localDay(new Date(`${iso}T12:00:00`).getTime() + k * 864e5);

async function get(c: Companion, path: string, what: string) {
  const base = trimSlash(c.url); if (!base) throw new HttpError(400, `${c.name} has no url in the apps YAML.`);
  const key = secret(c.keyEnv);
  const r = await call(`${base}${path}`, { method: "GET", headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) } });
  if (r.status === 401 || r.status === 403) throw new HttpError(502, `${c.name} refused the token${c.keyEnv ? ` in ${c.keyEnv}` : ""} (${r.status}).`);
  if (!r.ok) throw new HttpError(502, `${c.name} answered ${r.status} for ${what}.`);
  return r.body;
}
/** Every page of a list endpoint (Firefly pages at 50 by default). */
async function all(c: Companion, path: string, what: string, max = 500) {
  const out: any[] = [];
  for (let page = 1; page <= 20 && out.length < max; page++) {
    const sep = path.includes("?") ? "&" : "?", b = await get(c, `${path}${sep}page=${page}&limit=100`, what);
    out.push(...(b?.data || []));
    const p = b?.meta?.pagination; if (!p || page >= (p.total_pages || 1)) break;
  }
  return out;
}

const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ms: number, f: () => Promise<T>): Promise<T> {
  const h = cache.get(key); if (h && Date.now() - h.at < ms) return h.v as T;
  const v = await f(); cache.set(key, { at: Date.now(), v }); return v;
}
export const clearFireflyCache = () => cache.clear();

export type FfSummary = { currency: string; netWorth: number | null; balance: number | null; spent: number | null; earned: number | null; leftToSpend: number | null; billsPaid: number | null; billsUnpaid: number | null; from: string; to: string };
/** This month's boxes from Firefly's dashboard (summary/basic), in your primary currency. */
export async function ffSummary(c: Companion, from = monthStart(), to = monthEnd()): Promise<FfSummary> {
  return cached(`ff:s:${c.url}:${from}:${to}`, 5 * 60000, async () => {
    const b = await get(c, `/api/v1/summary/basic?start=${from}&end=${to}`, "the summary") || {};
    // One entry per key and currency ("spent-in-USD"); use the currency that has a net worth (the primary one).
    const entries = Object.values(b) as any[], cur = String(entries.find(e => String(e?.key || "").startsWith("net-worth-in-"))?.currency_code || entries[0]?.currency_code || "USD");
    const v = (k: string) => n(b[`${k}-in-${cur}`]?.monetary_value);
    const abs = (x: number | null) => (x === null ? null : Math.abs(x));
    return { currency: cur, netWorth: v("net-worth"), balance: v("balance"), spent: abs(v("spent")), earned: v("earned"), leftToSpend: v("left-to-spend"), billsPaid: abs(v("bills-paid")), billsUnpaid: abs(v("bills-unpaid")), from, to };
  });
}

export type FfBill = { id: string; name: string; date: string; amount: number; currency: string; paid: boolean; repeat: string };
/** Bills due between two days: one row per expected pay date, marked paid when Firefly matched a payment. */
export async function ffBills(c: Companion, from = localDay(), to = plusDays(localDay(), 30)): Promise<FfBill[]> {
  return cached(`ff:b:${c.url}:${from}:${to}`, 10 * 60000, async () => {
    const rows: FfBill[] = [];
    for (const d of await all(c, `/api/v1/bills?start=${from}&end=${to}`, "bills")) {
      const a = d?.attributes || {}; if (a.active === false) continue;
      const amount = n(a.amount_avg) ?? ((n(a.amount_min) ?? 0) + (n(a.amount_max) ?? n(a.amount_min) ?? 0)) / 2;
      const paid = new Set((a.paid_dates || []).map((p: any) => day(p?.date)));
      for (const pd of a.pay_dates || []) { const dt = day(pd); if (dt >= from && dt <= to) rows.push({ id: String(d.id), name: String(a.name || "Bill"), date: dt, amount: +Math.abs(amount).toFixed(2), currency: String(a.currency_code || ""), paid: paid.has(dt), repeat: String(a.repeat_freq || "") }); }
    }
    return rows.sort((x, y) => x.date.localeCompare(y.date) || x.name.localeCompare(y.name));
  });
}

export type FfBudget = { name: string; amount: number; spent: number; currency: string; pct: number };
/** This month's budgets: limit, spent and how much of it is used (0–100+). */
export async function ffBudgets(c: Companion, from = monthStart(), to = monthEnd()): Promise<FfBudget[]> {
  return cached(`ff:bu:${c.url}:${from}:${to}`, 10 * 60000, async () => {
    const [limits, budgets] = await Promise.all([all(c, `/api/v1/budget-limits?start=${from}&end=${to}`, "budget limits"), all(c, "/api/v1/budgets", "budgets")]);
    const names = new Map(budgets.map((b: any) => [String(b.id), String(b.attributes?.name || "Budget")]));
    // `spent` is a negative amount (older versions: a list of {sum} per currency).
    const spentOf = (s: unknown) => Array.isArray(s) ? s.reduce((t: number, x: any) => t + Math.abs(n(x?.sum) ?? 0), 0) : Math.abs(n(s) ?? 0);
    return limits.map((l: any) => { const a = l.attributes || {}, amount = Math.abs(n(a.amount) ?? 0), spent = spentOf(a.spent);
      return { name: names.get(String(a.budget_id)) || "Budget", amount, spent: +spent.toFixed(2), currency: String(a.currency_code || ""), pct: amount ? Math.round((spent / amount) * 100) : 0 };
    }).sort((x, y) => y.pct - x.pct);
  });
}

export type FfPiggy = { name: string; saved: number; target: number | null; pct: number; targetDate: string; currency: string };
export async function ffPiggyBanks(c: Companion): Promise<FfPiggy[]> {
  return cached(`ff:p:${c.url}`, 10 * 60000, async () => (await all(c, "/api/v1/piggy-banks", "piggy banks")).filter((p: any) => p.attributes?.active !== false).map((p: any) => {
    const a = p.attributes || {};
    return { name: String(a.name || "Piggy bank"), saved: n(a.current_amount) ?? 0, target: n(a.target_amount), pct: Math.max(0, Math.min(100, Number(a.percentage) || 0)), targetDate: day(a.target_date), currency: String(a.currency_code || "") };
  }));
}

export type FfAccount = { name: string; type: string; balance: number; currency: string; inNetWorth: boolean };
export async function ffAccounts(c: Companion): Promise<FfAccount[]> {
  return cached(`ff:a:${c.url}`, 5 * 60000, async () => {
    const rows = [...await all(c, "/api/v1/accounts?type=asset", "accounts"), ...await all(c, "/api/v1/accounts?type=liabilities", "liabilities")];
    return rows.filter((r: any) => r.attributes?.active !== false).map((r: any) => { const a = r.attributes || {};
      return { name: String(a.name || "Account"), type: String(a.type || ""), balance: n(a.current_balance) ?? 0, currency: String(a.currency_code || ""), inNetWorth: a.include_net_worth !== false };
    });
  });
}

export type FfTx = { date: string; description: string; amount: number; type: string; category: string; budget: string; account: string; counterparty: string; currency: string };
const txRows = (groups: any[]): FfTx[] => groups.flatMap((g: any) => (g.attributes?.transactions || []).map((t: any) => {
  const type = String(t.type || ""), out = type === "withdrawal";
  return { date: day(t.date), description: String(t.description || ""), amount: +(Math.abs(n(t.amount) ?? 0) * (out ? -1 : 1)).toFixed(2), type, category: String(t.category_name || ""), budget: String(t.budget_name || ""),
    account: String(out ? t.source_name : t.destination_name || ""), counterparty: String(out ? t.destination_name : t.source_name || ""), currency: String(t.currency_code || "") };
}));
/** The most recent transactions (withdrawals, deposits and transfers). */
export async function ffRecent(c: Companion, limit = 20): Promise<FfTx[]> {
  return cached(`ff:t:${c.url}:${limit}`, 2 * 60000, async () => txRows((await get(c, `/api/v1/transactions?limit=${Math.max(1, Math.min(100, limit))}&page=1`, "transactions"))?.data || []).slice(0, limit));
}
/** Firefly's own search ("amazon", "category:Groceries", "date_after:2026-10-01"). */
export async function ffSearch(c: Companion, query: string, limit = 25): Promise<FfTx[]> {
  const q = query.trim().slice(0, 300); if (!q) throw new HttpError(400, "Search for something.");
  return txRows((await get(c, `/api/v1/search/transactions?query=${encodeURIComponent(q)}&limit=${Math.max(1, Math.min(100, limit))}`, "the search"))?.data || []).slice(0, limit);
}

/** Everything the Money page, the brief and the panel show, in one call. */
export async function ffOverview(c: Companion) {
  const [summary, bills, budgets, piggies] = await Promise.all([ffSummary(c), ffBills(c), ffBudgets(c).catch(() => []), ffPiggyBanks(c).catch(() => [])]);
  return { summary, bills, budgets, piggies, at: Date.now() };
}
