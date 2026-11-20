import { useEffect, useState } from "react";
import type { PageDef } from "./types";
import { put, saveSettings, useColl, useSettings } from "../lib/store";
import { useUi } from "../lib/ui";
import { get, post } from "../lib/api";
import { PRESETS, EDITABLE } from "../lib/theme";
import { parseApps, DEFAULT_APPS } from "../lib/apps";
import { getZone, listOf } from "../lib/util";
import { OutboxPanel } from "../components/Outbox";
import { useFetch } from "../lib/useFetch";
import { useAllPages, usePageSetup, pageMode } from "./index";

const CONNS: { id: string; name: string; fields: [string, string][]; note?: string }[] = [
  { id: "upstream", name: "UpstreamManager", fields: [["baseUrl", "Base URL (on its own computer, e.g. http://192.168.1.20:5000)"]], note: "Start it there with HOST=0.0.0.0 and allow only this server in its firewall." },
  { id: "uptime", name: "Uptime Kuma", fields: [["baseUrl", "Base URL"], ["statusPage", "Status page slug"], ["userEnv", "Admin user variable (for Scripts)"], ["passwordEnv", "Admin password variable (for Scripts)"]], note: "Orb reads the published status page. The admin login is only used by the Watch new sites script." },
  { id: "caldav", name: "CalDAV tasks", fields: [["url", "CalDAV URL (empty: the ALLGlance gateway's /dav/)"], ["userEnv", "User variable"], ["passwordEnv", "Password variable"], ["choresList", "List that holds chores"]] },
  { id: "wiki", name: "LLMWIKI", fields: [["baseUrl", "REST API URL"], ["tokenEnv", "API key variable"], ["vault", "Vault folder in the container (read only)"]] },
  { id: "allglance", name: "ALLGlance gateway", fields: [["baseUrl", "Base URL (e.g. http://allglance-gateway:8090)"], ["tokenEnv", "Token variable (same value as GATEWAY_TOKEN)"]], note: "Brings in dayGLANCE's day plan and inbox, lastGLANCE chores and lifeGLANCE milestones. vikunja tasks still come over CalDAV." },
  { id: "npm", name: "Nginx Proxy Manager", fields: [["baseUrl", "Admin address (e.g. http://192.168.20.5:81)"], ["emailEnv", "Login email variable"], ["passwordEnv", "Password variable"]], note: "Read only: its proxy hosts give app links their names (https://sonarr.example.com) instead of a port on the server." },
  { id: "nginx", name: "nginx / SWAG configs", fields: [["domain", "Your domain, for SWAG's app.* names (e.g. thefellashub.com)"]], note: "Mount the config folder read only and set NGINX_CONF_DIR in .env (e.g. /nginx). Orb reads server_name and proxy_pass (or SWAG's $upstream_app / $upstream_port)." },
  { id: "technitium", name: "Technitium DNS", fields: [["baseUrl", "Address (e.g. http://192.168.20.5:5380)"], ["tokenEnv", "API token variable"]], note: "Read only: a record named after an app (plex.home.lan) that points at the server becomes that app's link." },
  { id: "milaclone", name: "Milaclone (Ideas)", fields: [["url", "Address in your browser (e.g. http://tower:4321)"]], note: "The Ideas tab shows Milaclone: boards, mind maps and drawings." },
  { id: "unraid", name: "Unraid Management Agent", fields: [["baseUrl", "Agent address (e.g. http://192.168.20.5:8043)"], ["tokenEnv", "Token variable (the agent's API token)"], ["linkHost", "Server's LAN address for app links (empty: found from the agent, e.g. 192.168.20.5)"]], note: "Lists every container with its ports for the Links page. Unraid's WebUI and icon for each container come from Docker labels, through the socket proxy." },
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

type ScriptRow = { id: string; name: string; description: string; options: { key: string; label: string; placeholder?: string }[]; on: boolean; cron: string; defaultCron: string; values: Record<string, string>;
  cronOk: boolean; next: string | null; running: boolean; runs: { at: string; ok: boolean; by: string; summary: string; details: string[]; ms: number }[] };
const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Built-in jobs: run now, or turn on and give a cron schedule. */
function ScriptsSettings() {
  const ui = useUi(), s = useSettings(), { data, error, reload } = useFetch<ScriptRow[]>("/api/scripts", 30000), [busy, setBusy] = useState("");
  if (error) return <div className="err-inline small">{error}</div>;
  if (!data) return <div className="hint">Loading scripts…</div>;
  const save = (id: string, v: Record<string, any>) => saveSettings({ scripts: { ...(s.scripts || {}), [id]: { ...(s.scripts?.[id] || {}), ...v } } }).then(reload);
  return <><p className="hint" style={{ margin: 0 }}>Jobs built into Orb. Run one now, or turn it on to run on its schedule. Schedules are cron: minute hour day month weekday, in the {getZone() || "server's"} time zone (<code>*/15 * * * *</code> is every 15 minutes, <code>0 6 * * 1-5</code> is 6:00 on weekdays).</p>
    {data.map(x => <form key={x.id + JSON.stringify(s.scripts?.[x.id] || {})} className="editor" style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }} onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget);
        const cron = String(f.get("cron") || "").trim() || x.defaultCron;
        save(x.id, { on: !!f.get("on"), cron, options: Object.fromEntries(x.options.map(o => [o.key, String(f.get("opt_" + o.key) || "").trim()])) }).then(() => ui.status(`${x.name} saved.`)).catch(ui.error); }}>
      <h4 className="group-name" style={{ margin: 0 }}>{x.name}</h4>
      <div className="hint">{x.description}</div>
      <div className="row"><label className="small row" style={{ gap: 4 }}><input type="checkbox" name="on" defaultChecked={x.on} /> Run on schedule</label>
        <input type="text" name="cron" className="mono" defaultValue={x.cron} placeholder={x.defaultCron} aria-label="Cron schedule" style={{ width: "11em" }} />
        {!x.cronOk ? <span className="err-inline">That schedule isn't valid cron.</span> : x.next && <span className="hint">next {when(x.next)}</span>}</div>
      {x.options.map(o => <label key={o.key} className="small">{o.label}<input type="text" name={"opt_" + o.key} defaultValue={x.values[o.key] || ""} placeholder={o.placeholder} /></label>)}
      <div className="row"><button className="btn primary" type="submit">Save</button>
        <button className="btn" type="button" disabled={x.running || busy === x.id} onClick={async () => { setBusy(x.id); try { const r = await post<ScriptRow["runs"][number]>(`/api/scripts/${x.id}/run`); (r.ok ? ui.status : ui.error)(r.summary); } catch (e) { ui.error(e); } finally { setBusy(""); reload(); } }}>{x.running || busy === x.id ? "Running…" : "Run now"}</button></div>
      {x.runs.length > 0 && <ul className="list small">{x.runs.slice(0, 5).map((r, i) => <li key={i}><span className={"pill " + (r.ok ? "ok" : "bad")}><i />{r.ok ? "ok" : "failed"}</span>
        <div className="grow"><span className="hint">{when(r.at)} · {r.by === "cron" ? "on schedule" : "by you"}</span> {r.summary}
          {r.details.length > 0 && <details><summary className="hint">{r.details.length} changes</summary><ul className="mono small">{r.details.map((d, j) => <li key={j}>{d}</li>)}</ul></details>}</div></li>)}</ul>}
    </form>)}</>;
}

/** Containers on the server that look like apps Orb connects to, for connections that are still empty. */
function Suggested() {
  const ui = useUi(), s = useSettings(), { data, error, reload } = useFetch<{ conn: string; field: string; label: string; container: string; url: string; running: boolean }[]>(`/api/links/suggest?host=${encodeURIComponent(location.hostname)}`);
  if (error) return <div className="empty small">{error}</div>;
  if (!data) return <div className="hint">Looking at the server's containers…</div>;
  if (!data.length) return <div className="empty small">Nothing to suggest: every connection Orb could match to a container is set, or the server's containers aren't listed yet (connect the Unraid Management Agent or the Docker socket proxy).</div>;
  const use = async (x: (typeof data)[number]) => {
    try { await (x.conn === "golem" ? saveSettings({ golem: { ...(s.golem || {}), baseUrl: x.url } }) : saveSettings({ connections: { ...(s.connections || {}), [x.conn]: { ...(s.connections?.[x.conn] || {}), [x.field]: x.url } } }));
      ui.status(`${x.label} now uses ${x.url}. Press Test under Connections to check it.`); reload(); } catch (e) { ui.error(e); }
  };
  return <ul className="list">{data.map(x => <li key={x.conn}><div className="grow"><b>{x.label}</b> <span className="hint">from {x.container}{x.running ? "" : " (stopped)"}</span><div className="mono small">{x.url}</div></div><button className="btn" onClick={() => use(x)}>Use</button></li>)}</ul>;
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

/** Which tabs show. Auto shows a page once its app is set up. */
function PagesSetting() {
  const ui = useUi(), s = useSettings(), all = useAllPages(), setup = usePageSetup();
  const rows = all.filter(p => p.id !== "main" && p.id !== "config");
  const set = (id: string, v: string) => { const next = { ...(s.pages || {}) }; if (v === "auto") delete next[id]; else next[id] = v; saveSettings({ pages: next }).catch(ui.error); };
  return <><p className="hint" style={{ margin: 0 }}>Auto shows a page when what it needs is set up: Agents (Hermes Studio), Wiki (the vault or its REST key), Upkeep (UpstreamManager or chores), Uptime (Uptime Kuma), Picks (stock picks turned on), Ideas (Milaclone).</p>
    <ul className="list">{rows.map(p => { const st = setup[p.id], shown = pageMode(s, p.id) === "show" || (pageMode(s, p.id) === "auto" && (!(p.id in setup) || st === true));
      return <li key={p.id}><div className="grow"><label htmlFor={"pg-" + p.id}>{p.label}</label><div className="hint">{p.id in setup ? (st === undefined ? "checking…" : st ? "set up" : "not set up") : "always available"} · {shown ? "shown" : "hidden"}</div></div>
        <select id={"pg-" + p.id} value={pageMode(s, p.id)} onChange={e => set(p.id, e.target.value)}><option value="auto">Auto</option><option value="show">Always show</option><option value="hide">Hide</option></select></li>; })}</ul></>;
}

function MainLists() {
  const s = useSettings(), tasks = useColl("tasks"), lists = [...new Set(tasks.map(listOf))].sort(), sel: string[] = s.mainLists || [];
  return <><div className="cfg">{lists.map(l => <li key={l}><label><input type="checkbox" checked={sel.includes(l)} onChange={e => saveSettings({ mainLists: e.target.checked ? [...sel, l] : sel.filter(x => x !== l) })} /> {l}</label></li>)}</div>
    {!sel.length && <div className="hint">None ticked: Open tasks shows every list.</div>}</>;
}

export const SettingsPage: PageDef = {
  id: "config", label: "Settings", title: "Sanctum", flavor: "Golem, connections, scripts, appearance, logs and apps.",
  usePanels: () => {
    const s = useSettings(), ui = useUi();
    return { panels: [
      { key: "golem", title: "Golem", node: <GolemSettings />, w: 6, h: 11 },
      { key: "appearance", title: "Appearance", node: <Appearance />, w: 6, h: 11 },
      { key: "pages", title: "Pages", node: <PagesSetting />, w: 6, h: 17 },
      { key: "connections", title: "Connections", node: <Connections />, w: 12, h: 12 },
      { key: "suggested", title: "Found on your server", node: <Suggested />, w: 6, h: 8 },
      { key: "scripts", title: "Scripts", node: <ScriptsSettings />, w: 6, h: 12 },
      { key: "logs", title: "Logs", node: <form className="setting" onSubmit={e => { e.preventDefault(); const v = Number(new FormData(e.currentTarget).get("logmax")); saveSettings({ logMax: Math.max(20, Math.min(200, v || 50)) }).then(() => ui.status("Log length saved.")).catch(ui.error); }}>
          <div><label htmlFor="logmax">Log entry length</label><div className="d">Most characters in one entry, for you, Golem and agents. 20 to 200.</div></div>
          <div className="row"><input type="number" id="logmax" name="logmax" min={20} max={200} defaultValue={s.logMax || 50} key={s.logMax} /><button className="btn" type="submit">Save</button></div>
          <div className="hint" style={{ gridColumn: "1/-1" }}>Days follow the <b>{getZone() || "server's"}</b> time zone. Change it with <code>TZ</code> in <code>.env</code> and restart the stack.</div></form>, w: 6, h: 5 },
      { key: "digest", title: "Daily digest in the wiki", node: <>
          <div className="setting"><div><div>Note my log activity in the wiki</div><div className="d">The wiki's daily log always lists Orb's edits to wiki notes. Turn this on to also add one line each day for the day before, such as “Orb, 2026-11-04: 4 log entries (3 on [[Pondering Orb]], 1 on [[Argos]])”. The text of your entries isn't copied.</div></div>
            <input type="checkbox" checked={!!s.wikiDigest} onChange={e => saveSettings({ wikiDigest: e.target.checked }).catch(ui.error)} aria-label="Note my log activity in the wiki" /></div>
          <div className="row"><button className="btn" onClick={async () => { try { const r = await post<{ written: string }>("/api/wiki/digest", {}); ui.status(r.written ? `Wrote the digest for ${r.written}.` : "Nothing to write."); } catch (x) { ui.error(x); } }}>Write yesterday's digest now</button></div></>, w: 6, h: 5 },
      { key: "daily", title: "Daily page", node: <DailySettingsForm />, w: 6, h: 12 },
      { key: "market", title: "Stock picks", node: <MarketSettingsForm />, w: 6, h: 22 },
      { key: "journal", title: "Journal", node: <JournalSettingsForm />, w: 6, h: 10 },
      { key: "robinhood", title: "Robinhood", node: <RobinhoodSettings />, w: 6, h: 14 },
      { key: "btop", title: "btop terminal", node: <form className="setting" onSubmit={e => { e.preventDefault(); (() => { const u = String(new FormData(e.currentTarget).get("btop") || "").trim(); if (u && !/^https?:\/\//i.test(u)) return Promise.reject(new Error("The btop address must start with http:// or https://.")); return saveSettings({ btopUrl: u }); })().then(() => ui.status("Saved. The System tab shows btop when this is set.")).catch(ui.error); }}>
          <div><label htmlFor="btopurl">btop address</label><div className="d">The ttyd sidecar from the compose file (profile btop), e.g. http://your-server:7681. Leave empty to hide it.</div></div>
          <div className="row"><input type="url" id="btopurl" name="btop" defaultValue={s.btopUrl || ""} key={s.btopUrl} placeholder="http://your-server:7681" /><button className="btn" type="submit">Save</button></div></form>, w: 6, h: 4 },
      { key: "lists", title: "Task lists on Main", node: <MainLists />, w: 6, h: 5 },
      { key: "outbox", title: "Waiting to sync", node: <OutboxPanel />, w: 6, h: 6 },
      { key: "apps", title: "Apps", node: <AppsYaml />, w: 12, h: 11 },
    ] };
  },
};

const lines = (v: FormDataEntryValue | null) => String(v || "").split(/[\n,]+/).map(x => x.trim()).filter(Boolean);

function DailySettingsForm() {
  const ui = useUi(), d = useSettings().daily || {};
  const feeds: string[] = d.feeds || ["https://feeds.npr.org/1001/rss.xml", "https://feeds.bbci.co.uk/news/world/rss.xml", "https://www.cnbc.com/id/100003114/device/rss/rss.html"];
  return <form className="editor" key={JSON.stringify(d)} onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget);
    // Keep what this form doesn't show (the favourite feed), and only change the rest.
    saveSettings({ daily: { ...d, location: String(f.get("location") || "").trim(), places: lines(f.get("places")), units: f.get("units") === "C" ? "C" : "F", feeds: lines(f.get("feeds")), watchlist: lines(f.get("watchlist")).map(x => x.toUpperCase()),
      briefOn: !!f.get("briefOn"), briefHour: Number(f.get("briefHour")) || 7,
      coverage: { on: !!f.get("covOn"), label: String(f.get("covLabel") || "").trim() || "Ground News", template: String(f.get("covTemplate") || "").trim() || "https://ground.news/search?query={q}" } } }).then(() => ui.status("Daily page saved.")).catch(ui.error); }}>
    <div className="row"><label className="small" style={{ flex: 1 }}>Favourite place (weather, the brief)<input type="text" name="location" defaultValue={d.location || ""} placeholder="Chicago, US  or  41.88,-87.63" /></label>
      <label className="small">Units<select name="units" defaultValue={d.units || "F"}><option value="F">°F</option><option value="C">°C</option></select></label></div>
    <label className="small">Other places (one per line; pick them on the Weather panel)<textarea name="places" rows={2} defaultValue={(d.places || []).join("\n")} /></label>
    <label className="small">News feeds (RSS or Atom, one per line; any feed works, e.g. weather alerts for a region)<textarea name="feeds" rows={4} defaultValue={feeds.join("\n")} /></label>
    <div className="row"><label className="small row" style={{ gap: 4 }}><input type="checkbox" name="covOn" defaultChecked={d.coverage?.on !== false} /> Link each headline to its coverage on</label>
      <input type="text" name="covLabel" defaultValue={d.coverage?.label || "Ground News"} aria-label="Coverage site name" style={{ width: "10em" }} /></div>
    <label className="small">Coverage link ({"{q}"} is the headline)<input type="text" name="covTemplate" defaultValue={d.coverage?.template || "https://ground.news/search?query={q}"} /></label>
    <label className="small">Watchlist (tickers, comma or line separated)<input type="text" name="watchlist" defaultValue={(d.watchlist || ["SPY", "QQQ", "DIA"]).join(", ")} /></label>
    <div className="row"><label className="small row" style={{ gap: 4 }}><input type="checkbox" name="briefOn" defaultChecked={d.briefOn !== false} /> Write the morning brief each day after</label>
      <input type="number" name="briefHour" min={0} max={23} defaultValue={d.briefHour ?? 7} aria-label="Hour" style={{ width: 64 }} /><span className="small">:00 ({getZone() || "server time"})</span></div>
    <div className="hint">The brief is written by Golem's model (Settings → Golem) from the weather, news, prices, your tasks, chores and every CalDAV calendar. Weather from Open-Meteo and prices from Yahoo/Stooq need no keys.</div>
    <div className="row"><button className="btn primary" type="submit">Save</button></div>
  </form>;
}

/** The Journal: which vision model reads handwriting, and whether each day goes to the wiki. */
function JournalSettingsForm() {
  const ui = useUi(), j = useSettings().journal || {}, o = j.ocr || {};
  return <form className="editor" key={JSON.stringify(j)} onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget);
    saveSettings({ journal: { ...j, wiki: !!f.get("wiki"), wikiOmi: !!f.get("wikiOmi"), ocr: { baseUrl: String(f.get("obase") || "").trim(), model: String(f.get("omodel") || "").trim(), keyEnv: String(f.get("okey") || "").trim() } } }).then(() => ui.status("Journal saved.")).catch(ui.error); }}>
    <div className="row"><label className="small" style={{ flex: 1 }}>Vision model address (OpenAI-compatible /v1)<input type="url" name="obase" defaultValue={o.baseUrl || ""} placeholder="empty = Golem's endpoint · http://argos:8080/v1" /></label></div>
    <div className="row"><label className="small" style={{ flex: 1 }}>Model<input type="text" name="omodel" defaultValue={o.model || ""} placeholder="empty = Golem's model · e.g. qwen2.5-vl-7b" /></label>
      <label className="small" style={{ flex: 1 }}>Key variable (optional)<input type="text" name="okey" defaultValue={o.keyEnv || ""} /></label></div>
    <div className="hint">Reads handwritten pages (BOOX exports, photos of paper). It must accept images: Qwen2.5-VL, Llama 3.2 Vision or MiniCPM-V on llama-server, Ollama or Argos work. Pages you correct are kept in <code>data/handwriting/</code> (images and <code>manifest.jsonl</code>) to train a model on your handwriting later.</div>
    <label className="small row" style={{ gap: 4 }}><input type="checkbox" name="wiki" defaultChecked={j.wiki === true} /> Send each finished day to the wiki (the Journal section of daily/date.md)</label>
    <label className="small row" style={{ gap: 4 }}><input type="checkbox" name="wikiOmi" defaultChecked={j.wikiOmi !== false} /> Include Omi's recap in it (turn off when Omi sends its approved days to the wiki itself, so they aren't filed twice)</label>
    <div className="row"><button className="btn primary" type="submit">Save</button></div>
  </form>;
}

function MarketSettingsForm() {
  const ui = useUi(), m = useSettings().market || {}, { data: st } = useFetch<any>("/api/market/status", 0);
  const strategy = m.strategy || "Long-only US stocks for a personal account. Prefer liquid, well-known companies with a clear, recent, verifiable catalyst. Avoid penny stocks, leveraged ETFs and anything that needs a story to be true.";
  return <form className="editor" key={JSON.stringify(m)} onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget);
    saveSettings({ market: { ...m, on: !!f.get("on"), hour: Number(f.get("hour")) || 8, weekdaysOnly: !!f.get("weekdaysOnly"), maxPicks: Number(f.get("maxPicks")) || 5, notional: Number(f.get("notional")) || 100,
      index: String(f.get("index") || "SPY").trim().toUpperCase(), avoid: lines(f.get("avoid")).map(x => x.toUpperCase()), strategy: String(f.get("strategy") || "").trim(),
      decider: { kind: f.get("dkind") === "jev" ? "jev" : "openai", baseUrl: String(f.get("dbase") || "").trim(), model: String(f.get("dmodel") || "").trim(), keyEnv: String(f.get("dkey") || "").trim() },
      reviews: { on: !!f.get("rvOn"), times: String(f.get("rvTimes") || "").split(/[\s,]+/).filter(Boolean), weekdaysOnly: !!f.get("rvWeekdays"), include: String(f.get("rvInclude") || "both"), max: Number(f.get("rvMax")) || 12 } } }).then(() => ui.status("Stock picks saved.")).catch(ui.error); }}>
    <div className="row"><label className="small row" style={{ gap: 4 }}><input type="checkbox" name="on" defaultChecked={!!m.on} /> Run the research each day after</label>
      <input type="number" name="hour" min={0} max={23} defaultValue={m.hour ?? 8} aria-label="Hour" style={{ width: 64 }} /><span className="small">:00</span>
      <label className="small row" style={{ gap: 4 }}><input type="checkbox" name="weekdaysOnly" defaultChecked={m.weekdaysOnly !== false} /> weekdays only</label></div>
    <div className="row"><label className="small">Picks per day<input type="number" name="maxPicks" min={1} max={10} defaultValue={m.maxPicks ?? 5} style={{ width: 70 }} /></label>
      <label className="small">Default amount ($)<input type="number" name="notional" min={1} defaultValue={m.notional ?? 100} style={{ width: 90 }} /></label>
      <label className="small">Compare with<input type="text" name="index" defaultValue={m.index || "SPY"} style={{ width: 80 }} /></label></div>
    <label className="small">Never pick (tickers)<input type="text" name="avoid" defaultValue={(m.avoid || []).join(", ")} /></label>
    <label className="small">Strategy (goes into every research pass and verdict)<textarea name="strategy" rows={3} defaultValue={strategy} /></label>
    <fieldset className="editor" style={{ border: "1px solid var(--line)", borderRadius: 6, padding: 8 }}><legend className="small">Decision model (self-hosted)</legend>
      <div className="row"><label className="small">Kind<select name="dkind" defaultValue={m.decider?.kind || "openai"}><option value="openai">OpenAI-compatible model</option><option value="jev">Jev-format service</option></select></label>
        <label className="small" style={{ flex: 1 }}>Address<input type="url" name="dbase" defaultValue={m.decider?.baseUrl || ""} placeholder="empty = Golem's endpoint · http://argos:8080/v1 · http://jev:8000/v1/systemone" /></label></div>
      <div className="row"><label className="small" style={{ flex: 1 }}>Model<input type="text" name="dmodel" defaultValue={m.decider?.model || ""} placeholder="model name" /></label>
        <label className="small" style={{ flex: 1 }}>Key variable (optional)<input type="text" name="dkey" defaultValue={m.decider?.keyEnv || ""} placeholder="e.g. DECIDER_KEY" /></label></div>
      <div className="hint">{st?.decider?.usesGolem ? "Using Golem's endpoint." : st?.decider?.kind === "jev" ? "Sends Jev's request format (state + typed questions) to your server." : "Asks your model the same fixed-choice questions as strict JSON."}</div>
    </fieldset>
    <div className="hint">Research uses Golem's model with news search and page reading (public sites only).</div>
    <fieldset className="editor" style={{ border: "1px solid var(--line)", borderRadius: 6, padding: 8 }}><legend className="small">Stock reviews (decision ideas)</legend>
      <div className="row"><label className="small row" style={{ gap: 4 }}><input type="checkbox" name="rvOn" defaultChecked={!!m.reviews?.on} /> Review at</label>
        <input type="text" name="rvTimes" defaultValue={(m.reviews?.times || ["08:45", "12:30", "15:45"]).join(", ")} aria-label="Times (HH:MM)" style={{ width: "14em" }} />
        <label className="small row" style={{ gap: 4 }}><input type="checkbox" name="rvWeekdays" defaultChecked={m.reviews?.weekdaysOnly !== false} /> weekdays only</label></div>
      <div className="row"><label className="small">Review<select name="rvInclude" defaultValue={m.reviews?.include || "both"}><option value="both">What I hold and my watchlist</option><option value="holdings">Only what I hold</option><option value="watchlist">Only my watchlist</option></select></label>
        <label className="small">At most<input type="number" name="rvMax" min={1} max={30} defaultValue={m.reviews?.max ?? 12} style={{ width: 70 }} /></label></div>
      <div className="hint">Golem's model reads and rates each stock's news; the decision model above decides: add, hold, trim or sell for what you hold (from Coinpile), buy, watch or skip for the rest. Ideas only: nothing trades.</div>
    </fieldset>
    <div className="row"><button className="btn primary" type="submit">Save</button></div>
  </form>;
}

function RobinhoodSettings() {
  const ui = useUi(), r = useSettings().robinhood || {}, { data: st, reload, error } = useFetch<any>("/api/robinhood/status", 0);
  const { data: tl, error: tlErr } = useFetch<any>(st?.connected ? "/api/robinhood/tools" : null, 0);
  const connect = async () => { try { const x = await post<{ url: string }>("/api/robinhood/connect"); location.href = x.url; } catch (e) { ui.error(e); } };
  const tools: any[] = tl?.tools || [];
  return <form className="editor" key={JSON.stringify(r) + (tl ? "t" : "")} onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget);
    saveSettings({ robinhood: { ...r, tradingOn: !!f.get("tradingOn"), maxOrder: Number(f.get("maxOrder")) || 100, maxDay: Number(f.get("maxDay")) || 300,
      orderTool: String(f.get("orderTool") || ""), accountTool: String(f.get("accountTool") || "") } }).then(() => { ui.status("Robinhood settings saved."); reload(); }).catch(ui.error); }}>
    {error && <div className="err-inline small">{error}</div>}
    <div className="row"><span className={"pill " + (st?.connected ? "ok" : "")}><i />{st?.connected ? "Connected to your agentic account" : "Not connected"}</span>
      {st?.connected ? <button type="button" className="btn" onClick={e => ui.confirm(e.currentTarget, "Disconnect Robinhood? Orb forgets its sign-in.", "Disconnect", () => post("/api/robinhood/disconnect").then(reload))}>Disconnect</button>
        : <button type="button" className="btn primary" onClick={connect}>Connect Robinhood</button>}</div>
    {st?.lastError && <div className="err-inline small">{st.lastError}</div>}
    <div className="hint">Signs in to Robinhood's Trading MCP with OAuth; you approve it on Robinhood and open the separate agentic account there. Orb comes back to this address, so behind a tunnel open Orb by its https address before connecting.</div>
    {st?.connected && <>
      {tlErr && <div className="err-inline small">{tlErr}</div>}
      <div className="row"><label className="small" style={{ flex: 1 }}>Order tool<select name="orderTool" defaultValue={r.orderTool || tl?.guess?.orderTool || ""}><option value="">(none)</option>{tools.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}</select></label>
        <label className="small" style={{ flex: 1 }}>Account tool (read only)<select name="accountTool" defaultValue={r.accountTool || tl?.guess?.accountTool || ""}><option value="">(none)</option>{tools.filter(t => t.readOnly || /account|portfolio|position|power/i.test(t.name)).map(t => <option key={t.name} value={t.name}>{t.name}</option>)}</select></label></div>
      {tools.length > 0 && <details><summary className="small">{tools.length} tools Robinhood offers</summary><ul className="list small">{tools.map(t => <li key={t.name}><b className="mono">{t.name}</b><div className="grow hint">{t.description}</div>{t.readOnly && <span className="tag">read only</span>}</li>)}</ul></details>}
    </>}
    <div className="row"><label className="small">Most per order ($)<input type="number" name="maxOrder" min={1} defaultValue={r.maxOrder ?? 100} style={{ width: 90 }} /></label>
      <label className="small">Most per day ($)<input type="number" name="maxDay" min={1} defaultValue={r.maxDay ?? 300} style={{ width: 90 }} /></label>
      {st && <span className="hint">sent today: ${Number(st.spentToday || 0).toFixed(2)}</span>}</div>
    <label className="small row" style={{ gap: 4 }}><input type="checkbox" name="tradingOn" defaultChecked={r.tradingOn === true} /> Let Orb place orders (each one still needs your confirmation)</label>
    <div className="hint">Orders are only for picks you said “I'm buying” to: that ticker, a buy, within these caps. Golem and agents never get these tools. Turn on Robinhood's own “Trade approvals” too for a second check. You carry the risk of every order.</div>
    <div className="row"><button className="btn primary" type="submit">Save</button></div>
  </form>;
}
