import { useEffect, useRef, useState } from "react";
import { post } from "../lib/api";
import { Markdown } from "../lib/markdown";

type M = { role: "user" | "assistant"; content: string; did?: string[] };
const load = (): M[] => { try { const v = JSON.parse(localStorage.getItem("orb.golem") || "[]"); return Array.isArray(v) ? v.slice(-30) : []; } catch { return []; } };
const CHIPS = ["What should I work on next?", "Log: fixed the Argos watcher tests", "What chores are overdue?", "Summarize this week's logs"];

/** Golem: the dashboard assistant. The server runs the model and its tools. */
export function Golem() {
  const [msgs, setMsgs] = useState<M[]>(load), [text, setText] = useState(""), [busy, setBusy] = useState(false);
  const chat = useRef<HTMLDivElement>(null);
  useEffect(() => { try { localStorage.setItem("orb.golem", JSON.stringify(msgs.slice(-30))); } catch { /* private window */ } chat.current?.scrollTo({ top: 1e9 }); }, [msgs, busy]);
  const send = async (q: string) => {
    q = q.trim(); if (!q || busy) return;
    const next: M[] = [...msgs, { role: "user", content: q }]; setMsgs(next); setText(""); setBusy(true);
    try { const r = await post<{ text: string; did: string[] }>("/api/golem", { messages: next.map(m => ({ role: m.role, content: m.content })) }); setMsgs([...next, { role: "assistant", content: r.text || "…", did: r.did }]); }
    catch (e: any) { setMsgs([...next, { role: "assistant", content: `Something cracked: ${e.message}` }]); }
    finally { setBusy(false); }
  };
  return <div className="golem" style={{ height: "100%" }}>
    <div className="golem-head"><span className={"golem-face" + (busy ? " busy" : "")} aria-hidden="true" /><div className="grow hint">{busy ? "The Golem stirs…" : ""}</div>
      {msgs.length > 0 && <button className="btn" onClick={() => setMsgs([])}>Clear</button>}<a className="btn" href="#config">Settings</a></div>
    <div className="chat" ref={chat} aria-live="polite" style={{ flex: 1, maxHeight: "none", minHeight: 80 }}>
      {msgs.length ? msgs.map((m, i) => <div key={i} className={"msg " + (m.role === "user" ? "user" : "golem")}>{m.role === "user" ? m.content : <Markdown text={m.content} />}
        {m.did && m.did.length > 0 && <span className="did">{m.did.join(" · ")}</span>}</div>)
        : <div className="msg golem">Golem stands ready. Ask what to work on, or tell me what you did and I will log it.</div>}
      {busy && <div className="msg golem">…</div>}
    </div>
    {!msgs.length && <div className="chips">{CHIPS.map(c => <button key={c} onClick={() => send(c)}>{c}</button>)}</div>}
    <form onSubmit={e => { e.preventDefault(); send(text); }}><textarea rows={1} value={text} onChange={e => setText(e.target.value)} placeholder="Speak to the Golem" aria-label="Message to Golem"
      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }} /><button className="btn primary" type="submit" disabled={busy}>Send</button></form>
  </div>;
}
