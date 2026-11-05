import { useEffect, useRef, useState } from "react";
import { Markdown } from "../lib/markdown";

type M = { role: "user" | "assistant"; content: string; did?: string[] };
const load = (): M[] => { try { const v = JSON.parse(localStorage.getItem("orb.golem") || "[]"); return Array.isArray(v) ? v.slice(-30) : []; } catch { return []; } };
const CHIPS = ["What should I work on next?", "Log: fixed the Argos watcher tests", "What chores are overdue?", "Summarize this week's logs"];

/** Golem: the dashboard assistant. The server runs the model and its tools. */
export function Golem() {
  const [msgs, setMsgs] = useState<M[]>(load), [text, setText] = useState(""), [busy, setBusy] = useState(false);
  const [live, setLive] = useState(""), [tool, setTool] = useState(""), stop = useRef<AbortController | null>(null);
  const chat = useRef<HTMLDivElement>(null);
  // gen changes on Clear, so a reply that finishes afterwards is dropped.
  // A reply that finishes after the panel unmounted (another tab) is still
  // saved to the stored history, so it's there when you come back.
  const gen = useRef(0), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const finish = (g: number, next: M[], reply: M) => {
    if (g !== gen.current) return;
    if (mounted.current) setMsgs([...next, reply]);
    else try { localStorage.setItem("orb.golem", JSON.stringify([...next, reply].slice(-30))); } catch { /* private window */ }
  };
  useEffect(() => { try { localStorage.setItem("orb.golem", JSON.stringify(msgs.slice(-30))); } catch { /* private window */ } chat.current?.scrollTo({ top: 1e9 }); }, [msgs, busy, live]);
  /** Streams the reply from /api/golem/stream (Server-Sent Events over a POST). */
  const send = async (q: string) => {
    q = q.trim(); if (!q || busy) return;
    const next: M[] = [...msgs, { role: "user", content: q }]; setMsgs(next); setText(""); setBusy(true); setLive(""); setTool("");
    const ctl = new AbortController(); stop.current = ctl; let textSoFar = ""; const g = gen.current;
    try {
      const res = await fetch("/api/golem/stream", { method: "POST", credentials: "same-origin", signal: ctl.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.map(m => ({ role: m.role, content: m.content })) }) });
      if (!res.ok || !res.body) { const t = await res.text(); let e = t; try { e = JSON.parse(t).error || t; } catch { /* plain text */ } throw new Error(e || `The server answered ${res.status}.`); }
      const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "", final: { text: string; did: string[] } | null = null;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(chunk)?.[1], data = /^data: (.*)$/m.exec(chunk)?.[1]; if (!ev || data == null) continue;
          const d = JSON.parse(data);
          if (ev === "text") { textSoFar += d.delta; setLive(textSoFar); setTool(""); }
          else if (ev === "tool") setTool(d.name);
          else if (ev === "done") final = d;
          else if (ev === "error") throw new Error(d.error);
        }
      }
      finish(g, next, { role: "assistant", content: (final?.text || textSoFar || "…").trim(), did: final?.did });
    } catch (e: any) {
      if (e?.name === "AbortError") finish(g, next, { role: "assistant", content: (textSoFar ? textSoFar + "\n\n" : "") + "_Stopped._" });
      else finish(g, next, { role: "assistant", content: `${textSoFar ? textSoFar + "\n\n" : ""}Something cracked: ${e.message}` });
    } finally { if (mounted.current) { setBusy(false); setLive(""); setTool(""); } stop.current = null; }
  };
  return <div className="golem" style={{ height: "100%" }}>
    <div className="golem-head"><span className={"golem-face" + (busy ? " busy" : "")} aria-hidden="true" /><div className="grow hint">{busy ? (tool ? `Consulting ${tool.replace(/_/g, " ")}…` : "The Golem stirs…") : ""}</div>{busy && <button className="btn" onClick={() => stop.current?.abort()}>Stop</button>}
      {msgs.length > 0 && <button className="btn" onClick={() => { gen.current++; stop.current?.abort(); setMsgs([]); }}>Clear</button>}<a className="btn" href="#config">Settings</a></div>
    <div className="chat" ref={chat} aria-live="polite" style={{ flex: 1, maxHeight: "none", minHeight: 80 }}>
      {msgs.length ? msgs.map((m, i) => <div key={i} className={"msg " + (m.role === "user" ? "user" : "golem")}>{m.role === "user" ? m.content : <Markdown text={m.content} />}
        {m.did && m.did.length > 0 && <span className="did">{m.did.join(" · ")}</span>}</div>)
        : <div className="msg golem">Golem stands ready. Ask what to work on, or tell me what you did and I will log it.</div>}
      {busy && <div className="msg golem">{live ? <Markdown text={live} /> : "…"}{tool && <span className="did">using {tool.replace(/_/g, " ")}…</span>}</div>}
    </div>
    {!msgs.length && <div className="chips">{CHIPS.map(c => <button key={c} onClick={() => send(c)}>{c}</button>)}</div>}
    <form onSubmit={e => { e.preventDefault(); send(text); }}><textarea rows={1} value={text} onChange={e => setText(e.target.value)} placeholder="Speak to the Golem" aria-label="Message to Golem"
      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }} /><button className="btn primary" type="submit" disabled={busy}>Send</button></form>
  </div>;
}
