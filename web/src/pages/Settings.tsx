import { useEffect, useState } from "react";
import type { PageDef } from "./types";
import { put, saveSettings, useColl, useSettings } from "../lib/store";
import { useUi } from "../lib/ui";
import { get, post } from "../lib/api";
import { PRESETS, EDITABLE } from "../lib/theme";
import { parseApps, DEFAULT_APPS } from "../lib/apps";
import { getZone, listOf } from "../lib/util";
import { OutboxPanel } from "../components/Outbox";

const CONNS: { id: string; name: string; fields: [string, string][]; note?: string }[] = [
  { id: "upstream", name: "UpstreamManager", fields: [["baseUrl", "Base URL (on its own computer, e.g. http://192.168.1.20:5000)"]], note: "Start it there with HOST=0.0.0.0 and allow only this server in its firewall." },
  { id: "uptime", name: "Uptime Kuma", fields: [["baseUrl", "Base URL"], ["statusPage", "Status page slug"]] },
  { id: "caldav", name: "CalDAV tasks", fields: [["url", "CalDAV URL"], ["userEnv", "User variable"], ["passwordEnv", "Password variable"], ["choresList", "List that holds chores"]] },
  { id: "wiki", name: "LLMWIKI", fields: [["baseUrl", "REST API URL"], ["tokenEnv", "API key variable"], ["vault", "Vault folder in the container (read only)"]] },
  { id: "allglance", name: "ALLGlance gateway", fields: [["baseUrl", "Base URL (e.g. http://allglance-gateway:8090)"], ["tokenEnv", "Token variable (same value as GATEWAY_TOKEN)"]], note: "Brings in dayGLANCE's day plan and inbox, lastGLANCE chores and lifeGLANCE milestones. vikunja tasks still come over CalDAV." },
  { id: "hermes", name: "Hermes Studio", fields: [["baseUrl", "Base URL"], ["userEnv", "User variable"], ["passwordEnv", "Password variable"]] },
];

function Connections() {
  const ui = useUi(), s = useSettings(), [eff, setEff] = useState<any>(null), [res, setRes] = useState<Record<string, { ok: boolean; detail: string }>>({});
  useEffect(() => { get("/api/config").then(setEff).catch(() => {}); }, [JSON.stringify(s.connections)]);
  const val = (id: string, f: string) => s.connections?.[id]?.[f] ?? eff?.[id]?.[f] ?? "";
  return <><p className="hint" style={{ margin: 0 }}>Addresses as this server sees them. Keys and passwords stay in environment variables; only their names are saved.</p>
    <div className="conns">{CONNS.map(c => <form key={c.id} className="conn" onSubmit={async e => { e.preventDefault(); const v = Object.fromEntries(new FormData(e.currentTarget).entries());
        try { await saveSettings({ connections: { ...(s.connections || {}), [c.id]: v } }); setRes({ ...res, [c.id]: { ok: true, detail: "Saved. Test checks the saved values." } }); } catch (x) { ui.error(x); } }}>
      <h4 className="group-name">{c.name}</h4>
      {c.fields.map(([f, l]) => <label key={f} className="small">{l}<input type="text" name={f} defaultValue={val(c.id, f)} key={val(c.id, f)} /></label>)}
      {c.note && <div className="hint">{c.note}</div>}
      <div className="row"><button className="btn primary" type="submit">Save</button><button className="btn" type="button" onClick={async () => { setRes({ ...res, [c.id]: { ok: true, detail: "Testing…" } }); try { setRes({ ...res, [c.id]: await post(`/api/connections/test/${c.id}`) }); } catch (x: any) { setRes({ ...res, [c.id]: { ok: false, detail: x.message } }); } }}>Test</button></div>
      {res[c.id] && <div className={res[c.id].ok ? "okmsg" : "err-inline"}>{res[c.id].detail}</div>}
    </form>)}</div></>;
}

function GolemSettings() {
  const ui = useUi(), s = useSettings(), [eff, setEff] = useState<any>(null), [test, setTest] = useState("");
  useEffect(() => { get("/api/config").then(c => setEff(c.golem)).catch(() => {}); }, [JSON.stringify(s.golem)]);
  const g = { ...(eff || {}), ...(s.golem || {}) };
  return <>
    <div className="setting"><div><div>Chat text size</div></div><select value={s.golemFont || "m"} onChange={e => saveSettings({ golemFont: e.target.value })}>{[["s", "Small"], ["m", "Normal"], ["l", "Large"], ["xl", "Extra large"]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
    <form className="editor" key={JSON.stringify(g)} onSubmit={async e => { e.preventDefault(); const v = Object.fromEntries(new FormData(e.currentTarget).entries()) as any;
        try { await saveSettings({ golem: { baseUrl: v.baseUrl.trim(), model: v.model.trim(), keyEnv: v.keyEnv.trim(), canWrite: !!v.canWrite } }); ui.status("Golem settings saved."); } catch (x) { ui.error(x); } }}>
      <label className="small">Model endpoint (OpenAI-compatible /v1)<input type="url" name="baseUrl" defaultValue={g.baseUrl || ""} placeholder="http://argos:8080/v1" /></label>
      <div className="hint">Local: Argos, llama-server or Ollama. Frontier: https://openrouter.ai/api/v1 or https://api.anthropic.com/v1/.</div>
      <div className="row"><label className="small" style={{ flex: 1 }}>Model<input type="text" name="model" defaultValue={g.model || ""} placeholder="model name" /></label>
        <label className="small" style={{ flex: 1 }}>API key variable<input type="text" name="keyEnv" defaultValue={g.keyEnv || ""} placeholder="OPENROUTER_API_KEY" /></label></div>
      {eff && g.keyEnv && <div className="hint">{eff.keySet ? "The key variable is set on the server." : "That variable isn't set on the server."}</div>}
      <label className="small row"><input type="checkbox" name="canWrite" defaultChecked={g.canWrite !== false} /> Golem may write logs, tasks and chores, and move project cards</label>
      <div className="row"><button className="btn primary" type="submit">Save</button><button className="btn" type="button" onClick={async () => { setTest("Testing…"); try { const r = await post("/api/connections/test/golem"); setTest(r.detail); } catch (x: any) { setTest(x.message); } }}>Test</button><span className="hint">{test}</span></div>
    </form></>;
}

function Appearance() {
  const ui = useUi(), s = useSettings(), th = { mode: "auto", preset: "night", custom: {} as Record<string, string>, ...(s.theme || {}) }, base = PRESETS[th.preset] || PRESETS.night, vals = { ...base.t, ...th.custom };
  const sw = (p: any) => <span className="sw">{["bg", "panel", "gold", "arcane", "ink"].map(k => <i key={k} style={{ background: p.t[k] }} />)}</span>;
  return <>
    <div className="setting"><div><div>Page width</div><div className="d">Fit window grows with the browser window.</div></div>
      <select value={s.pageWidth || "fit"} onChange={e => saveSettings({ pageWidth: e.target.value })}><option value="fit">Fit window</option><option value="wide">Wide (1680 px)</option><option value="comfortable">Comfortable (1240 px)</option></select></div>
    <div className="presets">
      <button className={"preset" + (th.mode === "auto" ? " on" : "")} onClick={() => saveSettings({ theme: { ...th, mode: "auto" } })}><span className="sw"><i style={{ background: PRESETS.night.t.bg }} /><i style={{ background: PRESETS.parchment.t.bg }} /></span>Follow device</button>
      {Object.entries(PRESETS).map(([id, p]) => <button key={id} className={"preset" + (th.mode === "preset" && th.preset === id ? " on" : "")} onClick={() => saveSettings({ theme: { ...th, mode: "preset", preset: id, custom: {} } })}>{sw(p)}{p.name}</button>)}
    </div>
    <details open={th.mode === "custom"}><summary className="small">Customize colours</summary>
      <form className="colors" key={JSON.stringify(vals)} onSubmit={e => { e.preventDefault(); saveSettings({ theme: { ...th, mode: "custom", custom: Object.fromEntries(new FormData(e.currentTarget).entries()) } }).catch(ui.error); }}>
        {EDITABLE.map(([k, l]) => <label key={k}><input type="color" name={k} defaultValue={/^#/.test(vals[k]) ? vals[k] : "#888888"} /> {l}</label>)}
        <div className="row" style={{ gridColumn: "1/-1" }}><button className="btn primary" type="submit">Use these colours</button></div></form></details></>;
}

function AppsYaml() {
  const ui = useUi(), doc = useColl("settings").find(d => d.id === "apps"), [text, setText] = useState<string | null>(null);
  const cur = text ?? doc?.yaml ?? DEFAULT_APPS, { error } = parseApps(cur);
  return <><p className="hint" style={{ margin: 0 }}>Groups hold apps (name, url, description, rune, links). Each app and group can be a panel on Main.</p>
    <textarea className="yaml" value={cur} onChange={e => setText(e.target.value)} spellCheck={false} aria-label="Apps YAML" />
    <div className="row"><button className="btn primary" disabled={!!error} onClick={() => put("settings", "apps", { yaml: cur }).then(() => { setText(null); ui.status("Apps saved."); }).catch(ui.error)}>Save YAML</button>
      <button className="btn" onClick={() => setText(null)}>Discard changes</button></div>{error && <div className="err">{error}</div>}</>;
}

function MainLists() {
  const s = useSettings(), tasks = useColl("tasks"), lists = [...new Set(tasks.map(listOf))].sort(), sel: string[] = s.mainLists || [];
  return <><div className="cfg">{lists.map(l => <li key={l}><label><input type="checkbox" checked={sel.includes(l)} onChange={e => saveSettings({ mainLists: e.target.checked ? [...sel, l] : sel.filter(x => x !== l) })} /> {l}</label></li>)}</div>
    {!sel.length && <div className="hint">None ticked: Open tasks shows every list.</div>}</>;
}

export const SettingsPage: PageDef = {
  id: "config", label: "Settings", title: "Sanctum", flavor: "Golem, connections, appearance, logs and apps.",
  usePanels: () => {
    const s = useSettings(), ui = useUi();
    return { panels: [
      { key: "golem", title: "Golem", node: <GolemSettings />, w: 6, h: 11 },
      { key: "appearance", title: "Appearance", node: <Appearance />, w: 6, h: 11 },
      { key: "connections", title: "Connections", node: <Connections />, w: 12, h: 12 },
      { key: "logs", title: "Logs", node: <form className="setting" onSubmit={e => { e.preventDefault(); const v = Number(new FormData(e.currentTarget).get("logmax")); saveSettings({ logMax: Math.max(20, Math.min(200, v || 50)) }).then(() => ui.status("Log length saved.")).catch(ui.error); }}>
          <div><label htmlFor="logmax">Log entry length</label><div className="d">Most characters in one entry, for you, Golem and agents. 20 to 200.</div></div>
          <div className="row"><input type="number" id="logmax" name="logmax" min={20} max={200} defaultValue={s.logMax || 50} key={s.logMax} /><button className="btn" type="submit">Save</button></div>
          <div className="hint" style={{ gridColumn: "1/-1" }}>Days follow the <b>{getZone() || "server's"}</b> time zone. Change it with <code>TZ</code> in <code>.env</code> and restart the stack.</div></form>, w: 6, h: 5 },
      { key: "digest", title: "Daily digest in the wiki", node: <>
          <div className="setting"><div><div>Note my log activity in the wiki</div><div className="d">The wiki's daily log always lists Orb's edits to wiki notes. Turn this on to also add one line each day for the day before, such as “Orb, 2026-11-04: 4 log entries (3 on [[Pondering Orb]], 1 on [[Argos]])”. The text of your entries isn't copied.</div></div>
            <input type="checkbox" checked={!!s.wikiDigest} onChange={e => saveSettings({ wikiDigest: e.target.checked }).catch(ui.error)} aria-label="Note my log activity in the wiki" /></div>
          <div className="row"><button className="btn" onClick={async () => { try { const r = await post<{ written: string }>("/api/wiki/digest", {}); ui.status(r.written ? `Wrote the digest for ${r.written}.` : "Nothing to write."); } catch (x) { ui.error(x); } }}>Write yesterday's digest now</button></div></>, w: 6, h: 5 },
      { key: "btop", title: "btop terminal", node: <form className="setting" onSubmit={e => { e.preventDefault(); (() => { const u = String(new FormData(e.currentTarget).get("btop") || "").trim(); if (u && !/^https?:\/\//i.test(u)) return Promise.reject(new Error("The btop address must start with http:// or https://.")); return saveSettings({ btopUrl: u }); })().then(() => ui.status("Saved. The System tab shows btop when this is set.")).catch(ui.error); }}>
          <div><label htmlFor="btopurl">btop address</label><div className="d">The ttyd sidecar from the compose file (profile btop), e.g. http://your-server:7681. Leave empty to hide it.</div></div>
          <div className="row"><input type="url" id="btopurl" name="btop" defaultValue={s.btopUrl || ""} key={s.btopUrl} placeholder="http://your-server:7681" /><button className="btn" type="submit">Save</button></div></form>, w: 6, h: 4 },
      { key: "lists", title: "Task lists on Main", node: <MainLists />, w: 6, h: 5 },
      { key: "outbox", title: "Waiting to sync", node: <OutboxPanel />, w: 6, h: 6 },
      { key: "apps", title: "Apps", node: <AppsYaml />, w: 12, h: 11 },
    ] };
  },
};
