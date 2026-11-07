import { useMemo, useState } from "react";
import type { PageDef } from "./types";
import type { PanelDef } from "../components/PanelGrid";
import { useColl } from "../lib/store";
import { useUi } from "../lib/ui";
import { post } from "../lib/api";
import { useFetch } from "../lib/useFetch";
import { clip, listOf } from "../lib/util";
import { AgentBadge } from "../components/Common";

/** Coding agents running in herdr, read through Hermes Studio, and a way to
 *  hand an Orb task, plan or project to a new agent. Studio starts the agent
 *  in herdr with Studio's models, MCP and skills; the agent can read the Orb
 *  back through Studio's MCP tools. */
type Agent = { paneId: string; space: string; agent: string; status: string; title: string; cwd: string; chatId: string | null };
type Agents = { enabled: boolean; connected: boolean; studioUrl: string; agents: Agent[] };
type Kind = { id: string; name: string };

// The same glyphs herdr and Studio use for agent state.
const GLYPH: Record<string, string> = { working: "◐", blocked: "×", done: "✓", idle: "○", unknown: "·" };
const ST_CLASS: Record<string, string> = { working: "st-active", blocked: "st-blocked", done: "st-paused", idle: "muted", unknown: "muted" };
const RANK: Record<string, number> = { blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 };

function AgentList({ data, error }: { data: Agents | null; error: string }) {
  if (error) return <div className="empty">{error}</div>;
  if (!data) return <div className="empty">Asking Hermes Studio…</div>;
  if (!data.enabled) return <div className="empty">herdr is off in Hermes Studio. Turn it on in Studio's herdr settings.</div>;
  const list = [...data.agents].sort((a, b) => (RANK[a.status] ?? 4) - (RANK[b.status] ?? 4));
  if (!list.length) return <div className="empty">No agents are running in herdr.</div>;
  return <ul className="list">{list.map(a => <li key={a.paneId}>
    <span className={ST_CLASS[a.status] || "muted"} title={a.status} aria-label={a.status} style={{ width: 16, textAlign: "center" }}><span className="glyph">{GLYPH[a.status] || "·"}</span></span>
    <div className="grow"><b>{a.title}</b> <span className="small muted">{a.agent} · {a.space}</span>
      {a.cwd && <div className="small muted mono">{clip(a.cwd, 60)}</div>}</div>
    {data.studioUrl && <a className="btn" href={`${data.studioUrl}/mission/?pane=${encodeURIComponent(a.paneId)}`} target="_blank" rel="noopener">Watch</a>}
    {data.studioUrl && a.chatId && <a className="btn" href={`${data.studioUrl}/#/hermes/session/${encodeURIComponent(a.chatId)}`} target="_blank" rel="noopener">Chat</a>}
  </li>)}</ul>;
}

function SendPlan({ kinds, agents, onSent }: { kinds: Kind[]; agents: Agents | null; onSent: () => void }) {
  const ui = useUi();
  const tasks = useColl("tasks"), projects = useColl("projects");
  const [agentId, setAgentId] = useState(""), [folder, setFolder] = useState(""), [busy, setBusy] = useState("");
  const agent = agentId || kinds[0]?.id || "";
  const open = useMemo(() => tasks.filter((t: any) => !t.done).slice(0, 40), [tasks]);
  const live = useMemo(() => projects.filter((p: any) => !p.archived && p.status !== "shipped"), [projects]);
  const send = async (key: string, title: string, prompt: string, project?: string, orb?: { task?: { title: string; list: string }; project?: string }) => {
    if (!agent) return;
    setBusy(key); ui.status(`Starting ${agent} on “${clip(title, 40)}”…`);
    try {
      await post("/api/hermes/launch", { agentId: agent, title, prompt, workspace: folder.trim() || undefined, project, orb });
      ui.status(`Started ${agent} in herdr.`); onSent();
    } catch (e) { ui.error(e); } finally { setBusy(""); }
  };
  // An agent already on this plan (Studio names the pane after the title): watch it instead of starting another.
  const running = (title: string) => agents?.agents.find(a => a.title === title.slice(0, 48));
  const action = (key: string, title: string, start: () => void) => {
    const a = running(title);
    if (a && agents?.studioUrl) return <a className="btn" href={`${agents.studioUrl}/mission/?pane=${encodeURIComponent(a.paneId)}`} target="_blank" rel="noopener">Watch</a>;
    return <button className="btn" disabled={!!busy} onClick={start}>{busy === key ? "Starting…" : "Send to herdr"}</button>;
  };
  if (!kinds.length) return <div className="empty">No herdr-ready coding agents are installed in Hermes Studio.</div>;
  const taskPrompt = (t: any) => `Task from my Pondering Orb plans (list: ${listOf(t)}): ${t.title}${t.due ? `\nDue: ${t.due}.` : ""}\nWhen it is done, mark it complete with the ekko_studio_use_orb_update tool (action complete_task).`;
  const projectPrompt = (p: any) => `Work on my project "${p.name}" from Pondering Orb.${p.next ? `\nNext step: ${p.next}` : ""}\nRead its open tasks with the ekko_studio_use_orb_read tool (kind tasks, list set to the project name), and log progress with ekko_studio_use_orb_update (action add_log).`;
  return <>
    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
      <label className="small">Agent <select value={agent} onChange={e => setAgentId(e.target.value)}>{kinds.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}</select></label>
      <label className="small grow">Folder <input value={folder} onChange={e => setFolder(e.target.value)} placeholder="/home/me/code/project (optional)" style={{ width: "100%" }} /></label>
    </div>
    <p className="hint" style={{ margin: 0 }}>The agent starts in herdr with your Studio models, MCP servers and skills, and gets the plan as its first message.</p>
    <h4 className="small muted" style={{ margin: "8px 0 4px" }}>Projects</h4>
    {live.length ? <ul className="list">{live.map((p: any) => <li key={p.id}><div className="grow"><b>{p.name}</b>{p.next && <span className="small muted"> · {clip(p.next, 60)}</span>}{p.agent?.status && <> <AgentBadge status={p.agent.status} name={p.agent.name} /></>}</div>
      {action(`p:${p.id}`, p.name, () => send(`p:${p.id}`, p.name, projectPrompt(p), p.name, { project: p.name }))}</li>)}</ul>
      : <div className="empty">No active projects.</div>}
    <h4 className="small muted" style={{ margin: "8px 0 4px" }}>Open tasks and plans</h4>
    {open.length ? <ul className="list">{open.map((t: any) => <li key={t.id}><div className="grow">{t.title} <span className="small muted">{listOf(t)}</span>{t.agent?.status ? <> <AgentBadge status={t.agent.status} name={t.agent.name} /></> : t.started && <span className="small st-active"> · in progress</span>}</div>
      {action(`t:${t.id}`, t.title, () => send(`t:${t.id}`, t.title, taskPrompt(t), projects.some((p: any) => p.name === listOf(t)) ? listOf(t) : undefined, { task: { title: t.title, list: listOf(t) } }))}</li>)}</ul>
      : <div className="empty">No open tasks.</div>}
  </>;
}

function How() {
  return <div className="small">
    <p style={{ marginTop: 0 }}>Orb reads herdr through <b>Hermes Studio</b> (Settings → Connections → Hermes Studio, with a Studio admin's sign-in). Studio holds the herdr connection, so this works through Studio's tunnel too.</p>
    <p>Going the other way, connect this Orb in Studio's herdr Mission view (Control) with a token from <code>ORB_API_TOKENS</code>. Agents in Studio and herdr can then read your tasks, projects and ideas and add tasks and logs.</p>
  </div>;
}

export const AgentsPage: PageDef = {
  id: "agents", label: "Agents", title: "Familiars", flavor: "Coding agents at work in herdr, and plans to hand them.",
  usePanels: () => {
    const agents = useFetch<Agents>("/api/hermes/agents", 5000);
    const kinds = useFetch<Kind[]>("/api/hermes/agent-kinds", 0);
    const counts = (agents.data?.agents || []).reduce<Record<string, number>>((m, a) => ({ ...m, [a.status]: (m[a.status] || 0) + 1 }), {});
    const extra = <>
      <span className={"pill " + (agents.error ? "bad" : agents.data?.connected ? "ok" : "")} title={agents.error || ""}><i />{agents.error ? clip(agents.error, 70) : agents.data?.connected ? "Live from herdr" : "Reaching Hermes Studio…"}</span>
      {["blocked", "working", "done", "idle"].map(s => counts[s] ? <span key={s} className={"pill " + (s === "blocked" ? "bad" : s === "working" ? "ok" : "")}>{GLYPH[s]} {counts[s]} {s}</span> : null)}
      {agents.data?.studioUrl && <a className="btn" href={`${agents.data.studioUrl}/mission/`} target="_blank" rel="noopener">Open herdr Mission</a>}
    </>;
    const panels: PanelDef[] = [
      { key: "agents", title: "Agents", node: <AgentList data={agents.data} error={agents.error} />, w: 7, h: 12 },
      { key: "send", title: "Send a plan to herdr", node: <SendPlan kinds={kinds.data || []} agents={agents.data} onSent={agents.reload} />, w: 5, h: 12 },
      { key: "how", title: "How this connects", node: <How />, w: 12, h: 5 },
    ];
    return { panels, extra };
  },
};
