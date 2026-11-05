import { useEffect } from "react";
import { useFetch } from "../lib/useFetch";

/** Reload when the server says the outbox changed (or another panel changed it). */
const useOutboxEvents = (reload: () => void) => useEffect(() => { addEventListener("orb:outbox", reload); return () => removeEventListener("orb:outbox", reload); }, [reload]);
const changed = () => dispatchEvent(new Event("orb:outbox"));
import { api, post } from "../lib/api";
import { useUi } from "../lib/ui";
import { ago } from "../lib/util";

type Item = { id: string; kind: string; label: string; tries: number; lastError: string; created: number; next: number };

/** Header pill: changes that couldn't reach CalDAV or the wiki yet. */
export function OutboxPill() {
  const { data, reload } = useFetch<Item[]>("/api/outbox", 30000); useOutboxEvents(reload);
  if (!data || !data.length) return null;
  return <a className="pill warn" href="#config" title={data.map(d => `${d.label}: ${d.lastError}`).join("\n")}><i />{data.length} change{data.length === 1 ? "" : "s"} waiting to sync</a>;
}

/** Settings panel: what's waiting, why, and Retry / Drop. */
export function OutboxPanel() {
  const ui = useUi(), { data, error, reload } = useFetch<Item[]>("/api/outbox", 15000); useOutboxEvents(reload);
  if (error) return <div className="err-inline">{error}</div>;
  const list = data || [];
  return <>
    <p className="hint" style={{ margin: 0 }}>Writes to CalDAV or the wiki that failed wait here and are retried automatically (after 2, 4, 8 … up to 60 minutes). Nothing is dropped unless you drop it.</p>
    {list.length ? <ul className="list">{list.map(it => <li key={it.id}><div className="grow"><b>{it.label}</b>
      <div className="small err-inline">{it.lastError}</div><div className="hint">{it.tries} retr{it.tries === 1 ? "y" : "ies"} · waiting since {ago(it.created)}</div></div>
      <button className="btn sm" onClick={e => ui.confirm(e.currentTarget, <>Drop <b>{it.label}</b>? The change stays in Orb but won't be sent.</>, "Drop", async () => { await api("DELETE", `/api/outbox/${encodeURIComponent(it.id)}`); changed(); })}>Drop</button></li>)}</ul>
      : <div className="empty">Nothing waiting. Every change has reached CalDAV and the wiki.</div>}
    {list.length > 0 && <div className="row"><button className="btn primary" onClick={async () => { try { const r = await post<{ done: number; failed: number }>("/api/outbox/retry"); ui.status(`Retried: ${r.done} sent, ${r.failed} still failing.`); changed(); } catch (x) { ui.error(x); } }}>Retry now</button></div>}
  </>;
}
