import type { PageDef } from "./types";
import { useFetch } from "../lib/useFetch";
import { baseOf, useOrbConfig } from "./upkeep/config";
import { saveSettings, useSettings } from "../lib/store";
import { useUi } from "../lib/ui";

type Monitor = { id: number; name: string; group?: string; status: "up" | "down" | "pending"; uptime24: number | null; ping: number | null; beats?: number[]; ignored?: boolean };

function Monitors() {
  const { data, error, reload } = useFetch<{ monitors: Monitor[] }>("/api/uptime", 60000), s = useSettings(), ui = useUi();
  const ignored: string[] = s.uptimeIgnore || [];
  const toggle = (m: Monitor) => { const on = ignored.some(n => n.toLowerCase() === m.name.toLowerCase());
    saveSettings({ uptimeIgnore: on ? ignored.filter(n => n.toLowerCase() !== m.name.toLowerCase()) : [...ignored, m.name] })
      .then(() => { ui.status(on ? `${m.name} counts again.` : `${m.name} is ignored: still checked, never counted as down or alerted.`); reload(); }).catch(ui.error); };
  if (error && !data) return <div className="empty">{error}</div>;
  if (!data) return <div className="empty">Asking Uptime Kuma…</div>;
  const all = data.monitors || [], ms = all.filter(m => !m.ignored), off = all.filter(m => m.ignored);
  if (!all.length) return <div className="empty">No monitors on the status page yet.</div>;
  const up = ms.filter(m => m.status === "up").length, down = ms.filter(m => m.status === "down").length, pend = ms.length - up - down;
  const groups = [...new Set(ms.map(m => m.group || "Services"))];
  return <>
    {error && <div className="err-inline">{error}</div>}
    <div className="row"><span className="pill ok"><i />{up} up</span>{down > 0 && <span className="pill bad"><i />{down} down</span>}{pend > 0 && <span className="pill warn"><i />{pend} pending</span>}{off.length > 0 && <span className="pill"><i />{off.length} ignored</span>}</div>
    {groups.map(g => <div key={g}><h4 className="group-name">{g}</h4><div className="mons">
      {ms.filter(m => (m.group || "Services") === g).map(m => <div key={m.id} className={"mon " + m.status} title={`${m.name}: ${m.status}`}>
        <span className="dot" /><span className="grow">{m.name}</span>
        <span className="beats" aria-label="Recent heartbeats">{(m.beats || []).slice(-40).map((b, i) => <i key={i} className={b ? "u" : "d"} />)}</span>
        <span className="mono small">{m.uptime24 != null ? m.uptime24 + "%" : ""}</span>
        <span className="mono small muted">{m.ping != null ? m.ping + " ms" : ""}</span>
        <button className="btn small" onClick={() => toggle(m)} title="Stop counting this one as down or alerting on it">Ignore</button>
      </div>)}
    </div></div>)}
    {off.length > 0 && <div><h4 className="group-name">Ignored</h4><div className="hint">Still checked by Uptime Kuma; never counted as down or alerted.</div><div className="mons" style={{ opacity: .55 }}>
      {off.map(m => <div key={m.id} className={"mon " + m.status} title={`${m.name}: ${m.status} (ignored)`}>
        <span className="dot" /><span className="grow">{m.name}</span><span className="mono small">{m.status}</span>
        <button className="btn small" onClick={() => toggle(m)}>Watch again</button>
      </div>)}</div></div>}
  </>;
}

export const UptimePage: PageDef = {
  id: "uptime", label: "Uptime", title: "Watchtower", flavor: "Every service, as Uptime Kuma sees it.",
  usePanels: () => {
    const cfg = useOrbConfig(), base = baseOf(cfg?.uptime?.baseUrl);
    return {
      extra: <>{base && <a className="btn" href={base} target="_blank" rel="noopener">Open Uptime Kuma</a>}<a className="btn" href="#config">Connection settings</a></>,
      panels: [{ key: "monitors", title: "Monitors", node: <Monitors />, w: 12, h: 12 }],
    };
  },
};
