import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./demo.css";
import "./app.css";
import { App } from "./App";
import { UiProvider } from "./lib/ui";
import { startStore } from "./lib/store";
import { api, ApiError } from "./lib/api";

function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState(""), [err, setErr] = useState("");
  return <form className="login" onSubmit={async e => { e.preventDefault(); try { await api("POST", "/api/login", { password: pw }); onDone(); } catch (x: any) { setErr(x.message); } }}>
    <h1>Pondering Orb</h1>
    <label className="small">Password<input type="password" value={pw} onChange={e => setPw(e.target.value)} autoFocus style={{ width: "100%" }} /></label>
    {err && <div className="err-inline">{err}</div>}
    <button className="btn primary" type="submit">Sign in</button>
  </form>;
}

function Root() {
  const [state, setState] = useState<"loading" | "login" | "ready" | "error">("loading"), [err, setErr] = useState("");
  const boot = () => startStore().then(() => setState("ready")).catch(e => { if (e instanceof ApiError && e.status === 401) setState("login"); else { setErr(e.message); setState("error"); } });
  useEffect(() => { boot(); }, []);
  if (state === "login") return <Login onDone={() => { setState("loading"); boot(); }} />;
  if (state === "error") return <div className="login"><h1>Pondering Orb</h1><div className="err-inline">Couldn't load: {err}</div><button className="btn" onClick={() => { setState("loading"); boot(); }}>Try again</button></div>;
  if (state === "loading") return <div className="login"><h1>Pondering Orb</h1><div className="hint">Gazing…</div></div>;
  return <UiProvider><App /></UiProvider>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
