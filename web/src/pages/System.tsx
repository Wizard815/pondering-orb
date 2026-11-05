import type { PageDef } from "./types";
import type { PanelDef } from "../components/PanelGrid";
import { useFetch } from "../lib/useFetch";

type Host = {
  name: string; cpu: number; cores: number[]; cpuHistory: number[]; mem: number; memTotalGiB?: number;
  disks: { mount: string; pct: number }[]; uptimeDays: number; containers: { name: string; state: string; status: string; image: string }[]; dockerError?: string;
};

const heat = (v: number) => (v >= 90 ? "var(--bad)" : v >= 70 ? "var(--warn)" : "var(--ok)");
function Cells({ v, n = 20 }: { v: number; n?: number }) {
  const f = Math.round(Math.min(100, Math.max(0, +v || 0)) / 100 * n);
  return <span className="cells">{Array.from({ length: n }, (_, i) => <i key={i} style={{ background: i < f ? heat((i + 1) / n * 100) : "var(--line)" }} />)}</span>;
}
function Spark({ vals }: { vals: number[] }) {
  if (!Array.isArray(vals) || vals.length < 2) return null;
  const w = 200, h = 38, p = 3;
  const pts = vals.map((v, i) => [p + i * (w - 2 * p) / (vals.length - 1), h - p - (Math.min(+v || 0, 100) / 100) * (h - 2 * p)]);
  const line = pts.map(q => q.map(n => n.toFixed(1)).join(",")).join(" "), [ex, ey] = pts[pts.length - 1];
  return <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="CPU over the last few minutes">
    <line x1={p} x2={w - p} y1={h / 2} y2={h / 2} stroke="var(--line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    <polygon points={`${p},${h - p} ${line} ${w - p},${h - p}`} fill="var(--arcane-soft)" />
    <polyline points={line} fill="none" stroke="var(--arcane)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    <circle cx={ex} cy={ey} r={2.5} fill="var(--arcane)" />
  </svg>;
}
const Row = ({ label, title, v }: { label: string; title?: string; v: number }) =>
  <div className="core"><span className="mono" title={title}>{label}</span><Cells v={v} /><span className="mono">{v}%</span></div>;

const Cpu = ({ h }: { h: Host }) => <div className="btop1">
  <Spark vals={h.cpuHistory} />
  <div className="row small mono muted"><span>{h.cores.length} cores</span><span>load {h.cpu}%</span></div>
  <div className="cores">{h.cores.map((c, i) => <div key={i} className="core"><span className="mono">C{i}</span><Cells v={c} n={12} /><span className="mono">{c}%</span></div>)}</div>
</div>;

const Mem = ({ h }: { h: Host }) => <div className="btop1">
  <Row label="ram" title={h.memTotalGiB ? `${h.memTotalGiB} GiB` : undefined} v={h.mem} />
  {(h.disks || []).map(d => <Row key={d.mount} label={d.mount.length > 6 ? d.mount.slice(0, 5) + "…" : d.mount} title={d.mount} v={d.pct} />)}
  {h.memTotalGiB ? <div className="hint">{h.memTotalGiB} GiB memory</div> : null}
</div>;

function Containers({ h }: { h: Host }) {
  const cs = h.containers || [];
  return <div className="btop1">
    {h.dockerError && <div className="err-inline">Docker: {h.dockerError}</div>}
    {cs.length ? <div style={{ overflowX: "auto" }}><table className="ctab"><thead><tr><th>name</th><th>state</th><th>status</th><th>image</th></tr></thead>
      <tbody>{cs.map(c => <tr key={c.name}><td>{c.name}</td><td className={c.state === "running" ? "st-active" : "st-blocked"}>{c.state}</td><td className="small">{c.status}</td><td className="small muted">{c.image}</td></tr>)}</tbody></table></div>
      : !h.dockerError && <div className="empty small">No containers reported. Set DOCKER_HOST to a read-only Docker socket proxy to list them.</div>}
  </div>;
}

/** Grid rows for the CPU panel: about six cores per line at full width. */
const cpuRows = (n: number) => Math.max(4, Math.ceil((120 + Math.ceil(n / 6) * 16) / 56) + 1);

export const SystemPage: PageDef = {
  id: "system", label: "System", title: "Engine Room", flavor: "Cores, memory, disks and containers, btop style.",
  usePanels: () => {
    const { data, error } = useFetch<{ hosts: Host[] }>("/api/system", 3000);
    const hosts = data?.hosts || [];
    if (!hosts.length) return { panels: [{ key: "none", title: "Hosts", node: <div className="empty">{error || "Reading…"}</div>, w: 12, h: 4 }] };
    const panels: PanelDef[] = [];
    hosts.forEach(h => {
      panels.push({ key: "mem:" + h.name, title: `${h.name} · memory and disks`, node: <Mem h={h} />, w: 5, h: 5 });
      panels.push({ key: "ctr:" + h.name, title: `${h.name} · containers`, node: <Containers h={h} />, w: 7, h: 5 });
    });
    hosts.forEach(h => panels.push({ key: "cpu:" + h.name, title: `${h.name} · cpu ${h.cpu}% · up ${h.uptimeDays}d`, node: <Cpu h={h} />, w: 12, h: cpuRows(h.cores.length) }));
    return { panels, extra: error ? <span className="pill bad" title={error}><i />Last read failed</span> : undefined };
  },
};
