import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PageDef } from "./types";
import { api, ApiError } from "../lib/api";
import { useUi } from "../lib/ui";
import { useFetch } from "../lib/useFetch";
import { Markdown } from "../lib/markdown";
import { ago, todayISO } from "../lib/util";
import { InkCanvas, InkTools, PAGE_W, PAGE_H, paint, strokesOf, forgetInk, type InkPage, type InkActions, type ActiveInk, type Tool } from "../components/Ink";

/** The Journal: one page per day. Orb's log of the day (money, what got done,
 *  commits, agents, Omi, alerts), your typed notes, and pages to write or
 *  draw on with a pen, a drawing pad or a mouse, on blank paper or over an
 *  image or PDF you bring in. Days load one at a time. */

type Doc = { id?: string; version?: number; date: string; text: string; pages: InkPage[]; auto?: any };
const shift = (iso: string, n: number) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const longDay = (iso: string) => new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const usd = (n: number, cur = "") => n.toLocaleString(undefined, { style: "currency", currency: cur || "USD" });
const newId = (day: string) => `${day}-${Math.random().toString(36).slice(2, 10)}`;

/** Journal records by day: loaded one day at a time, saved in small pieces.
 *  Every save names its day, so a save that finishes after you moved to
 *  another day still lands on (and only changes) the day it was made on. */
type Patch = Partial<Doc> | ((cur: Doc) => Partial<Doc>);
function useJournal(day: string) {
  const ui = useUi(), docs = useRef(new Map<string, Doc>()), seq = useRef(new Map<string, number>()), shown = useRef(day);
  const [, bump] = useState(0); shown.current = day;
  const set = (d: string, v: Doc) => { docs.current.set(d, v); if (d === shown.current) bump(x => x + 1); };
  useEffect(() => { let live = true;
    if (docs.current.has(day)) return;
    api<Doc>("GET", `/api/c/journal/${day}`).catch(e => { if (e instanceof ApiError && e.status === 404) return { date: day, text: "", pages: [] }; throw e; })
      .then(d => { if (live && !docs.current.has(day)) set(day, { ...d, text: d.text || "", pages: d.pages || [] }); }, ui.error);
    return () => { live = false; }; }, [day]);
  const save = useCallback(async (forDay: string, p: Patch) => {
    const cur = docs.current.get(forDay) || { date: forDay, text: "", pages: [] }, part = typeof p === "function" ? p(cur) : p;
    set(forDay, { ...cur, ...part });
    const n = (seq.current.get(forDay) || 0) + 1; seq.current.set(forDay, n);
    // PATCH changes only what was sent; a day with no record yet is created.
    const url = `/api/c/journal/${forDay}`;
    const d = await api<Doc>("PATCH", url, part).catch(e => { if (e instanceof ApiError && e.status === 404) return api<Doc>("PUT", url, { date: forDay, text: "", pages: [], ...part }); throw e; });
    // Only the latest save's answer counts (an older one may arrive last).
    if (seq.current.get(forDay) === n) set(forDay, { ...(docs.current.get(forDay) as Doc), version: d.version, id: d.id });
  }, []);
  return { doc: docs.current.get(day) || null, save };
}

// ---------------- the day's log ----------------
function Section({ title, n, children }: { title: string; n?: number; children: React.ReactNode }) {
  return <section className="jl-sec"><h4 className="group-name">{title}{n ? <span className="hint"> · {n}</span> : null}</h4>{children}</section>;
}
function DayLog({ day, log }: { day: string; log: ReturnType<typeof useFetch<any>> }) {
  const a = log.data?.day === day ? log.data : null;
  if (log.error && !a) return <div className="empty">{log.error}</div>;
  if (!a) return <div className="hint">Gathering the day…</div>;
  const empty = !a.events.length && !a.tasksDone.length && !a.choresDone.length && !a.logs.length && !a.commits.length && !a.requests.length && !a.agents.length && !a.omi && !a.omiConversations.length && !a.picks.length && !a.alerts.length;
  return <div className="jl">
    <div className="row small"><span className="hint">{a.final ? `Saved when the day ended (${ago(a.at)}).` : `As of ${ago(a.at) || "just now"}.`}</span>
      <button className="btn" onClick={() => api("GET", `/api/journal/${day}/auto?refresh=1`).then(() => log.reload())}>Refresh</button></div>
    {empty && <div className="empty">Nothing recorded for this day yet.</div>}
    {a.alerts.length > 0 && <Section title="Alerts" n={a.alerts.length}><ul className="list">{a.alerts.map((x: any, k: number) => <li key={k}><span className={"chip " + (x.severity === "critical" ? "bad" : "warn")}>{x.source}</span><div className="grow">{x.title}{x.detail && <div className="hint">{x.detail}</div>}</div></li>)}</ul></Section>}
    {a.events.length > 0 && <Section title="Calendar" n={a.events.length}><ul className="list">{a.events.map((e: any, k: number) => <li key={k}><span className="date">{e.time}</span><div className="grow">{e.title}</div>{e.calendar && <span className="tag">{e.calendar}</span>}</li>)}</ul></Section>}
    {(a.tasksDone.length > 0 || a.choresDone.length > 0) && <Section title="Done" n={a.tasksDone.length + a.choresDone.length}><ul className="list">
      {a.tasksDone.map((t: any, k: number) => <li key={"t" + k}><span className="chip ok">done</span><div className="grow">{t.title}<div className="hint">{t.list}{t.by && t.by !== "you" ? ` · by ${t.by}` : ""}</div></div></li>)}
      {a.choresDone.map((c: any, k: number) => <li key={"c" + k}><span className="chip ok">chore</span><div className="grow">{c.name}</div></li>)}</ul></Section>}
    {a.logs.length > 0 && <Section title="Log" n={a.logs.length}><ul className="list">{a.logs.map((l: any, k: number) => <li key={k}><span className="date">{l.time}</span><div className="grow"><b>{l.project}</b> {l.text}{l.by && <span className="hint"> · {l.by}</span>}</div></li>)}</ul></Section>}
    {(a.commits.length > 0 || a.requests.length > 0) && <Section title="Code (UpstreamManager)" n={a.commits.length}><ul className="list">
      {a.commits.map((c: any, k: number) => <li key={"c" + k}><span className="date">{c.time}</span><div className="grow">{c.subject}<div className="hint mono">{c.repo} · {c.sha}</div></div></li>)}
      {a.requests.map((r: any, k: number) => <li key={"r" + k}><span className="chip">{r.what}</span><div className="grow">{r.repo}: {r.type} request{r.what === "decided" ? `, ${r.status}` : ""}{r.comment && <div className="hint">{r.comment}</div>}</div></li>)}</ul></Section>}
    {a.agents.length > 0 && <Section title="Agents (Hermes Studio)" n={a.agents.length}><ul className="list">{a.agents.map((g: any, k: number) => <li key={k}><span className="date">{g.time}</span><div className="grow">
      <b>{g.title}</b> <span className="tag">{g.agent}</span> <span className={"chip " + (g.status === "done" ? "ok" : g.status === "needs_you" ? "warn" : "")}>{String(g.status).replace(/_/g, " ")}</span>
      {(g.task || g.project) && <div className="hint">{[g.project, g.task].filter(Boolean).join(" · ")}</div>}{g.last && <div className="small jl-quote">{g.last}</div>}</div></li>)}</ul></Section>}
    {(a.omi || a.omiConversations.length > 0 || a.omiTasks.length > 0) && <Section title="Omi">
      {a.omi && <div className="jl-omi"><b>{a.omi.headline}</b><p className="small">{a.omi.overview}</p>
        {a.omi.decisions.length > 0 && <div className="small"><b>Decided:</b> {a.omi.decisions.join("; ")}</div>}
        {a.omi.questions.length > 0 && <div className="small"><b>Still open:</b> {a.omi.questions.join("; ")}</div>}
        {a.omi.highlights.length > 0 && <ul className="small">{a.omi.highlights.map((h: any, k: number) => <li key={k}><b>{h.topic}</b> {h.summary}</li>)}</ul>}</div>}
      {a.omiConversations.length > 0 && <ul className="list">{a.omiConversations.map((c: any, k: number) => <li key={k}><span className="date">{c.time}</span><div className="grow">{c.title}{c.overview && <div className="hint">{c.overview}</div>}</div></li>)}</ul>}
      {a.omiTasks.length > 0 && <div className="small"><b>Omi's action items:</b> {a.omiTasks.map((t: any) => (t.done ? `✓ ${t.title}` : t.title)).join(" · ")}</div>}
    </Section>}
    {a.picks.length > 0 && <Section title="Stock picks" n={a.picks.length}><ul className="list">{a.picks.map((p: any, k: number) => <li key={k}><b>{p.symbol}</b><div className="grow small">model said {p.action || "?"}</div><span className="tag">{p.decision === "yes" ? `bought ${usd(p.amount)}` : "passed"}</span></li>)}</ul></Section>}
    {a.notes.length > 0 && <div className="hint">Couldn't read: {a.notes.join("; ")}</div>}
  </div>;
}

function Money({ day, log }: { day: string; log: ReturnType<typeof useFetch<any>> }) {
  const a = log.data?.day === day ? log.data : null, m = a?.money;
  if (!a) return <div className="hint">{log.error || "Counting…"}</div>;
  if (!m) return <div className="empty">Add Firefly III (or Coinpile with daily totals) in Settings → Apps to see each day's spending and income. {a.notes.find((n: string) => n.startsWith("Money"))}</div>;
  return <>
    <div className="jl-money">
      <div><div className="hint">Spent</div><div className="big down">{usd(m.spent, m.currency)}</div></div>
      <div><div className="hint">Income</div><div className="big up">{usd(m.income, m.currency)}</div></div>
      <div><div className="hint">Net</div><div className={"big " + (m.income - m.spent >= 0 ? "up" : "down")}>{usd(m.income - m.spent, m.currency)}</div></div>
    </div>
    {m.items.length > 0 ? <ul className="list">{m.items.map((t: any, k: number) => <li key={k}><div className="grow">{t.description}<div className="hint">{[t.category, t.account].filter(Boolean).join(" · ")}</div></div><span className={"num " + (t.amount < 0 ? "down" : "up")}>{usd(t.amount, m.currency)}</span></li>)}</ul>
      : <div className="empty small">No transactions{m.source === "coinpile" ? " listed (Coinpile shares totals only)" : ""}.</div>}
    <div className="hint">From {m.source === "firefly" ? "Firefly III" : "Coinpile"}, read only. Transfers between your own accounts don't count.</div>
  </>;
}

// ---------------- typed notes ----------------
function Notes({ day, j }: { day: string; j: ReturnType<typeof useJournal> }) {
  const ui = useUi(), [text, setText] = useState<string | null>(null), [preview, setPreview] = useState(false), t = useRef(0), [saved, setSaved] = useState(0);
  const pending = useRef<{ day: string; text: string } | null>(null);
  const flush = () => { clearTimeout(t.current); const p = pending.current; pending.current = null; if (p) j.save(p.day, { text: p.text }).then(() => setSaved(Date.now()), ui.error); };
  // Moving to another day (or leaving the page) saves what was typed, on the day it was typed on.
  useEffect(() => { setText(null); setPreview(false); return flush; }, [day]);
  if (!j.doc) return <div className="hint">Opening the day…</div>;
  const val = text ?? j.doc.text;
  const change = (v: string) => { setText(v); pending.current = { day, text: v }; clearTimeout(t.current); t.current = window.setTimeout(flush, 800); };
  return <div className="jn">
    <div className="row small"><button className={"btn" + (!preview ? " on" : "")} onClick={() => setPreview(false)}>Write</button><button className={"btn" + (preview ? " on" : "")} onClick={() => setPreview(true)}>Read</button>
      <span className="hint">{saved ? `Saved ${ago(saved)}` : "Saves as you type. Markdown works."}</span></div>
    {preview ? (val.trim() ? <Markdown text={val} /> : <div className="empty">Nothing written yet.</div>)
      : <textarea className="jn-text" value={val} onChange={e => change(e.target.value)} placeholder={`What happened on ${longDay(day)}?`} aria-label="Your notes for the day" />}
  </div>;
}

// ---------------- drawing pages ----------------
async function upload(blob: Blob): Promise<string> {
  const r = await fetch("/api/journal/files", { method: "POST", credentials: "same-origin", headers: { "Content-Type": blob.type }, body: blob });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `Upload failed (${r.status}).`); return d.id;
}
const toBlob = (c: HTMLCanvasElement, type = "image/png", q?: number) => new Promise<Blob>((ok, no) => c.toBlob(b => (b ? ok(b) : no(new Error("Couldn't make the image."))), type, q));
/** An image becomes a page its own shape; big ones are scaled down first. */
async function imagePage(file: Blob, day: string): Promise<InkPage> {
  const bmp = await createImageBitmap(file), k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  let blob = file;
  if (k < 1 || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d")!.drawImage(bmp, 0, 0, w, h); blob = await toBlob(c, "image/jpeg", 0.9); }
  return { id: newId(day), w, h, bg: await upload(blob) };
}
/** Each PDF page becomes a drawing page (rendered here in the browser). */
async function pdfPages(file: File, day: string, onStep: (n: number, of: number) => void): Promise<InkPage[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise, out: InkPage[] = [], n = Math.min(doc.numPages, 40);
  for (let i = 1; i <= n; i++) {
    onStep(i, n);
    const page = await doc.getPage(i), v1 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: 1600 / v1.width });
    const c = document.createElement("canvas"); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await page.render({ canvasContext: c.getContext("2d")!, viewport: vp }).promise;
    out.push({ id: newId(day), w: c.width, h: c.height, bg: await upload(await toBlob(c)) });
  }
  return out;
}

const TOOL_KEY = "orb.inktool";
function loadTool(): Tool { try { return { kind: "pen", color: "#1b1b1b", width: 6, ...JSON.parse(localStorage.getItem(TOOL_KEY) || "{}") }; } catch { return { kind: "pen", color: "#1b1b1b", width: 6 }; } }

function Drawing({ day, j }: { day: string; j: ReturnType<typeof useJournal> }) {
  const ui = useUi(), [tool, setToolS] = useState<Tool>(loadTool), [penOnly, setPenOnly] = useState(() => localStorage.getItem("orb.penonly") === "1");
  const [full, setFull] = useState<number | null>(null), [busy, setBusy] = useState(""), file = useRef<HTMLInputElement>(null), active = useRef<ActiveInk | null>(null);
  const onActive = (a: ActiveInk) => { active.current = a; }, onGone = (a: ActiveInk) => { if (active.current === a) active.current = null; };
  const setTool = (t: Tool) => { setToolS(t); try { localStorage.setItem(TOOL_KEY, JSON.stringify(t)); } catch { /* storage blocked */ } };
  const pen = (v: boolean) => { setPenOnly(v); try { localStorage.setItem("orb.penonly", v ? "1" : "0"); } catch { /* storage blocked */ } };
  const onPen = () => { if (!penOnly && localStorage.getItem("orb.penonly") === null) pen(true); }; // first pen seen: ignore palms from now on
  useEffect(() => { setFull(null); active.current = null; }, [day]);
  useEffect(() => { if (full === null) return; const k = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(null); }; addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [full]);
  if (!j.doc) return <div className="hint">Opening the day…</div>;
  const pages = j.doc.pages;
  /** Pages are added to the day they were started on, even if you moved on meanwhile. */
  const addPages = (forDay: string, more: InkPage[]) => j.save(forDay, cur => ({ pages: [...cur.pages, ...more] }));
  const blank = () => addPages(day, [{ id: newId(day), w: PAGE_W, h: PAGE_H }]).then(() => true, e => { ui.error(e); return false; });
  const bring = async (files: FileList | null) => {
    if (!files?.length) return;
    const day0 = day;
    try {
      const made: InkPage[] = [];
      for (const f of Array.from(files)) {
        if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) made.push(...await pdfPages(f, day, (n, of) => setBusy(`Reading ${f.name}: page ${n} of ${of}…`)));
        else if (f.type.startsWith("image/")) { setBusy(`Bringing in ${f.name}…`); made.push(await imagePage(f, day)); }
        else throw new Error(`${f.name} isn't an image or a PDF.`);
      }
      await addPages(day0, made); ui.status(`Added ${made.length} page${made.length === 1 ? "" : "s"}${day0 !== day ? ` to ${longDay(day0)}` : ""}.`);
    } catch (e) { ui.error(e); } finally { setBusy(""); if (file.current) file.current.value = ""; }
  };
  const del = (anchor: Element, p: InkPage) => ui.confirm(anchor, "Delete this page and everything drawn on it?", "Delete page", async () => {
    await j.save(day, cur => ({ pages: cur.pages.filter(x => x.id !== p.id) }));
    forgetInk(p.id);
    await api("DELETE", `/api/c/ink/${encodeURIComponent(p.id)}`).catch(() => {});
    if (p.bg) await api("DELETE", `/api/journal/files/${encodeURIComponent(p.bg)}`).catch(() => {});
  });
  const save = async (p: InkPage, k: number) => {
    // What's on screen, including strokes not saved yet.
    const strokes = strokesOf(p.id) ?? (await api<any>("GET", `/api/c/ink/${encodeURIComponent(p.id)}`)).strokes ?? [], c = document.createElement("canvas"); c.width = p.w; c.height = p.h;
    let bg: HTMLImageElement | null = null;
    if (p.bg) { bg = new Image(); bg.src = `/api/journal/files/${encodeURIComponent(p.bg)}`; await bg.decode().catch(() => {}); }
    paint(c.getContext("2d")!, p, strokes, 1, bg);
    const a = document.createElement("a"); a.href = URL.createObjectURL(await toBlob(c)); a.download = `journal-${day}-${k + 1}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  const act = (k: keyof InkActions) => active.current?.current?.[k]();
  const tools = <InkTools tool={tool} setTool={setTool} penOnly={penOnly} setPenOnly={pen} act={act} />;
  const drop = (e: React.DragEvent) => { e.preventDefault(); bring(e.dataTransfer.files); };

  return <div className="ink" onDragOver={e => e.preventDefault()} onDrop={drop}>
    <div className="row ink-head">
      <button className="btn primary" onClick={blank}>New page</button>
      <button className="btn" onClick={() => file.current?.click()} disabled={!!busy}>Bring in an image or PDF</button>
      <input ref={file} type="file" accept="image/*,application/pdf" multiple hidden onChange={e => bring(e.target.files)} />
      {busy && <span className="hint">{busy}</span>}
    </div>
    {pages.length > 0 && tools}
    {!pages.length && <div className="empty">No pages yet. Start a blank page to write or draw on, or bring in a photo, a scan or a PDF (from your BOOX, say) and keep writing on it. You can also drop files here.</div>}
    {pages.map((p, k) => <figure key={p.id} className="ink-page">
      <InkCanvas page={p} day={day} tool={tool} penOnly={penOnly} onPen={onPen} onActive={onActive} onGone={onGone} />
      <figcaption className="row small"><span className="hint">Page {k + 1}{p.bg ? " · on an imported image" : ""}</span>
        <button className="btn" onClick={() => setFull(k)}>Full screen</button><button className="btn" onClick={() => save(p, k).catch(ui.error)}>Save as PNG</button><button className="btn" onClick={e => del(e.currentTarget, p)}>Delete</button></figcaption>
    </figure>)}
    {full !== null && pages[full] && createPortal(<div className="ink-full" role="dialog" aria-modal="true" aria-label={`Page ${full + 1}, full screen`}>
      <div className="ink-full-bar">{tools}<span className="ink-sep" />
        <button className="btn" disabled={full === 0} onClick={() => setFull(full - 1)}>‹ Page</button><span className="small">{full + 1} / {pages.length}</span>
        <button className="btn" onClick={() => (full === pages.length - 1 ? blank().then(ok => { if (ok) setFull(full + 1); }) : setFull(full + 1))}>{full === pages.length - 1 ? "New page ›" : "Page ›"}</button>
        <button className="btn primary" onClick={() => setFull(null)}>Done</button></div>
      <InkCanvas key={pages[full].id + "-big"} page={pages[full]} day={day} tool={tool} penOnly={penOnly} onPen={onPen} onActive={onActive} onGone={onGone} big />
    </div>, document.body)}
  </div>;
}

// ---------------- the page ----------------
function DayPicker({ day, setDay }: { day: string; setDay: (d: string) => void }) {
  const t = todayISO();
  return <div className="row jd"><button className="btn" onClick={() => setDay(shift(day, -1))} aria-label="Day before">‹</button>
    <input type="date" value={day} max={t} onChange={e => e.target.value && setDay(e.target.value > t ? t : e.target.value)} aria-label="Day" />
    <button className="btn" onClick={() => setDay(shift(day, 1))} disabled={day >= t} aria-label="Day after">›</button>
    {day !== t && <button className="btn" onClick={() => setDay(t)}>Today</button>}</div>;
}

export const JournalPage: PageDef = {
  id: "journal", label: "Journal", title: "Day Book", flavor: "The day as Orb saw it, what you wrote, and pages to write or draw on.",
  usePanels: () => {
    const [day, setDay] = useState(todayISO()), j = useJournal(day);
    const log = useFetch<any>(`/api/journal/${day}/auto`, day === todayISO() ? 5 * 60000 : 0);
    return {
      extra: <><span className="small jd-name">{longDay(day)}</span><DayPicker day={day} setDay={setDay} /></>,
      panels: [
        { key: "log", title: "The day's log", node: <DayLog day={day} log={log} />, w: 7, h: 22 },
        { key: "money", title: "Money", node: <Money day={day} log={log} />, w: 5, h: 9 },
        { key: "notes", title: "Notes", node: <Notes day={day} j={j} />, w: 5, h: 13 },
        { key: "ink", title: "Pages", node: <Drawing day={day} j={j} />, w: 12, h: 26 },
      ],
    };
  },
};
