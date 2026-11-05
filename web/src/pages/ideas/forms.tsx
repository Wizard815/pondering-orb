import { Doc } from "../../lib/store";
import { MC_PH, MC_TYPES, STAGES, STAGE_LABEL, typeOf } from "./model";

/** The card edit popup (demo: mcEdit + the mc-edit submit handler). onSave gets only the fields the form shows. */
export function EditForm({ i, lists, onSave, onCancel }: { i: Doc; lists: string[]; onSave: (up: Record<string, any>) => void; onCancel: () => void }) {
  const t = typeOf(i);
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>, up: Record<string, any> = {};
    if ("title" in v) up.title = v.title.trim();
    if ("text" in v) up.text = v.text;
    if ("url" in v) up.url = v.url.trim();
    if ("stage" in v) up.stage = v.stage;
    if ("list" in v) up.list = v.list.trim();
    if ("items" in v) up.items = v.items.split("\n").map(l => l.trim()).filter(Boolean).map(l => ({ t: l.replace(/^\[x\]\s*/i, ""), done: /^\[x\]/i.test(l) }));
    onSave(up);
  };
  return <form className="pop-form" style={{ minWidth: "min(320px,86vw)" }} onSubmit={submit}>
    <div className="mh" style={{ padding: 0 }}>{MC_TYPES[t].label}</div>
    {t !== "comment" && <label className="small">Title<input type="text" name="title" defaultValue={i.title || ""} placeholder={MC_PH[t] || "Title"} /></label>}
    {(t === "note" || t === "idea" || t === "comment") && <label className="small">{t === "idea" ? "Why it matters" : "Text"}
      <textarea name="text" rows={4} defaultValue={i.text || ""} placeholder={t === "idea" ? "One line on why" : "Write something"} /></label>}
    {t === "link" && <label className="small">URL<input type="url" name="url" defaultValue={i.url || ""} placeholder="https://" /></label>}
    {t === "todo" && <label className="small">Items, one per line (start with [x] when done)
      <textarea name="items" rows={5} defaultValue={(i.items || []).map((x: any) => (x.done ? "[x] " : "") + x.t).join("\n")} placeholder={"First thing\nSecond thing"} /></label>}
    {t === "tasks" && <label className="small">Task list<input type="text" name="list" list="mc-lists" defaultValue={i.list || ""} placeholder="Choose or type a list" />
      <datalist id="mc-lists">{lists.map(l => <option key={l} value={l} />)}</datalist></label>}
    {t === "idea" && <label className="small">Stage<select name="stage" defaultValue={i.stage || "thought"}>{STAGES.map(s => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}</select></label>}
    <div className="row"><button className="btn primary" type="submit">Save</button><button className="btn" type="button" onClick={onCancel}>Cancel</button></div>
  </form>;
}

export function EdgeLabelForm({ label, onSave, onCancel }: { label: string; onSave: (l: string) => void; onCancel: () => void }) {
  return <form className="pop-form" onSubmit={e => { e.preventDefault(); onSave(String(new FormData(e.currentTarget).get("label") || "").trim()); }}>
    <label className="small">Label<input type="text" name="label" defaultValue={label} /></label>
    <div className="row"><button className="btn primary" type="submit">Save</button><button className="btn" type="button" onClick={onCancel}>Cancel</button></div>
  </form>;
}
