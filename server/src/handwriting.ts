import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Records } from "./records.js";
import { HttpError } from "./records.js";
import type { OrbConfig } from "./config.js";
import { secret, okEnvName } from "./config.js";
import { call, trimSlash } from "./integrations/http.js";
import { isDay } from "./dates.js";

/** Handwritten notes: a page from the BOOX (exported as an image; the
 *  browser turns PDF pages into images) or a photo of paper. A vision model
 *  on your own endpoint reads the handwriting; you correct the text and it
 *  goes into the day's notes. Every page you correct is kept with its text
 *  in <data>/handwriting/ (images plus manifest.jsonl), ready for training a
 *  model on your handwriting later; until then, words you often correct are
 *  passed to the model as hints. */

export type OcrSettings = { baseUrl: string; model: string; keyEnv: string };
export const ocrSettings = (records: Records, cfg: () => OrbConfig): OcrSettings => {
  const o: any = ((records.get("settings", "app") as any)?.journal || {}).ocr || {}, g = cfg().golem;
  // Empty means Golem's endpoint and model (which must then be able to read images).
  return { baseUrl: /^https?:\/\//.test(o.baseUrl || "") ? String(o.baseUrl) : g.baseUrl, model: String(o.model || "").trim() || g.model, keyEnv: okEnvName(o.keyEnv) ? o.keyEnv : o.baseUrl ? "" : g.keyEnv };
};

const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
const ID = /^[a-f0-9]{32}$/;
export function sniff(b: Buffer): "png" | "jpg" | "webp" | null {
  if (b.length > 8 && b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return "png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

type Sample = { id: string; image: string; text: string; ocr: string; day: string; model: string; at: number };
/** Words you wrote that the model read differently: the most frequent become hints. */
export function hintWords(samples: Sample[], max = 40) {
  const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}'-]{3,}/gu) || []);
  const count = new Map<string, number>();
  for (const s of samples) { if (s.text === s.ocr) continue; const seen = new Set(words(s.ocr)); for (const w of new Set(words(s.text))) if (!seen.has(w)) count.set(w, (count.get(w) || 0) + 1); }
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([w]) => w);
}

export function handwritingApi(app: FastifyInstance, deps: { records: Records; cfg: () => OrbConfig; guard: any; who: (req: any) => string; dir: string }) {
  const { records, cfg, guard, dir } = deps;
  const you = (req: any) => { if (deps.who(req) !== "you") throw new HttpError(403, "Only a signed-in person can add handwritten notes."); };
  const manifest = join(dir, "manifest.jsonl");
  const samples = async (): Promise<Sample[]> => (await readFile(manifest, "utf8").catch(() => "")).split("\n").filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });

  async function read(img: Buffer, type: string) {
    const o = ocrSettings(records, cfg), base = trimSlash(o.baseUrl);
    if (!base) throw new HttpError(503, "Set a vision model in Settings → Journal (or Golem's endpoint).");
    const hints = hintWords(await samples());
    const r = await call(`${base}/chat/completions`, { method: "POST", timeoutMs: 180000,
      headers: { "Content-Type": "application/json", ...(secret(o.keyEnv) ? { Authorization: `Bearer ${secret(o.keyEnv)}` } : {}) },
      body: JSON.stringify({ model: o.model || undefined, temperature: 0, messages: [
        { role: "system", content: "You transcribe handwritten notes exactly. Keep the writer's words, order and line breaks. Use Markdown only where the page shows it: '- ' for bullets, '- [ ] ' / '- [x] ' for checkboxes, '#' for a clearly larger heading. Write [illegible] for anything you can't read; never guess whole sentences. Ignore ruled lines, page borders and doodles. Output only the transcription." },
        { role: "user", content: [
          { type: "text", text: `Transcribe this handwritten page.${hints.length ? ` Words this writer often uses: ${hints.join(", ")}.` : ""}` },
          { type: "image_url", image_url: { url: `data:${type};base64,${img.toString("base64")}` } }] }] }) });
    if (!r.ok) throw new HttpError(502, `The vision model answered ${r.status}: ${typeof r.body === "string" ? r.body.slice(0, 160) : r.body?.error?.message || ""}. It must accept images (e.g. Qwen2.5-VL, Llama 3.2 Vision, MiniCPM-V).`);
    return { text: String(r.body?.choices?.[0]?.message?.content || "").trim(), model: o.model };
  }

  // Page images: their own body parser on this route only, read after sign-in.
  app.register(async scope => {
    scope.addContentTypeParser(/^image\/(png|jpeg|webp)$/, { parseAs: "buffer", bodyLimit: 15 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    scope.post("/api/handwriting", { onRequest: [guard, async (req: any) => you(req)], bodyLimit: 15 * 1024 * 1024 }, async (req: any) => {
      const b = req.body; if (!Buffer.isBuffer(b) || !b.length) throw new HttpError(400, "Send the page image (PNG, JPEG or WebP) as the request body.");
      const ext = sniff(b); if (!ext) throw new HttpError(415, "That isn't a PNG, JPEG or WebP image.");
      await mkdir(dir, { recursive: true });
      const id = randomUUID().replace(/-/g, ""); await writeFile(join(dir, `${id}.${ext}`), b);
      // A failed reading still keeps the page: you can type it, and it still trains.
      try { const r = await read(b, TYPES[ext]); await writeFile(join(dir, `${id}.ocr.txt`), r.text); return { id, text: r.text, model: r.model, error: "" }; }
      catch (e: any) { return { id, text: "", model: "", error: e.message }; }
    });
  });
  /** Your corrected text for a page: kept as a training sample. */
  app.post("/api/handwriting/:id/text", { preHandler: guard }, async (req: any) => {
    you(req);
    const id = String(req.params.id); if (!ID.test(id)) throw new HttpError(404, "No such page.");
    const files = await Promise.all((["png", "jpg", "webp"] as const).map(async e => ((await readFile(join(dir, `${id}.${e}`)).then(() => e, () => null)))));
    const image = files.find(Boolean); if (!image) throw new HttpError(404, "No such page.");
    const text = String(req.body?.text ?? "").slice(0, 50000), day = isDay(req.body?.day) ? req.body.day : "";
    if (!text.trim()) throw new HttpError(422, "The page needs its text.");
    const ocr = await readFile(join(dir, `${id}.ocr.txt`), "utf8").catch(() => "");
    // The text it had before (for replacing it in the notes); a fix is a new manifest line, and the latest one counts.
    const previous = await readFile(join(dir, `${id}.txt`), "utf8").catch(() => "");
    const earlier = (await samples()).filter(x => x.id === id).at(-1);
    await writeFile(join(dir, `${id}.txt`), text);
    const sample: Sample = { id, image: `${id}.${image}`, text, ocr, day: day || earlier?.day || "", model: earlier?.model || ocrSettings(records, cfg).model, at: Date.now() };
    await appendFile(manifest, JSON.stringify(sample) + "\n");
    return { saved: true, previous };
  });
  /** Pages added on a day (the latest text of each), to look at or fix later. */
  app.get("/api/handwriting", { preHandler: guard }, async (req: any) => {
    const day = String(req.query.day || ""); if (!isDay(day)) throw new HttpError(400, "The day is YYYY-MM-DD.");
    const latest = new Map<string, Sample>(); for (const s of await samples()) latest.set(s.id, s);
    return [...latest.values()].filter(s => s.day === day).sort((a, b) => a.at - b.at).map(s => ({ id: s.id, text: s.text, ocr: s.ocr, at: s.at, image: `/api/handwriting/${s.id}/image` }));
  });
  app.get("/api/handwriting/:id/image", { preHandler: guard }, async (req: any, reply) => {
    const id = String(req.params.id); if (!ID.test(id)) throw new HttpError(404, "No such page.");
    for (const e of ["png", "jpg", "webp"] as const) {
      const b = await readFile(join(dir, `${id}.${e}`)).catch(() => null);
      if (b) { reply.header("Content-Type", TYPES[e]).header("X-Content-Type-Options", "nosniff").header("Content-Security-Policy", "default-src 'none'").header("Cache-Control", "private, max-age=86400"); return reply.send(b); }
    }
    throw new HttpError(404, "No such page.");
  });
  app.get("/api/handwriting/stats", { preHandler: guard }, async () => {
    const s = await samples(), latest = new Map(s.map(x => [x.id, x]));
    const all = [...latest.values()];
    return { samples: all.length, corrected: all.filter(x => x.text !== x.ocr).length, hints: hintWords(all, 20), folder: "data/handwriting", model: ocrSettings(records, cfg).model };
  });
}
