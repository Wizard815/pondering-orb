import { ago, drawGlance } from "./glance";
declare const orb: any;
const why = document.getElementById("why")!, when = document.getElementById("when")!;
async function draw() {
  const s = await orb.state();
  why.textContent = s.lastError || "Orb didn't answer.";
  when.textContent = s.glance ? ` (${ago(s.glance.at)})` : "";
  drawGlance(document.getElementById("glance")!, s.glance);
}
document.getElementById("retry")!.addEventListener("click", async (e) => { const b = e.currentTarget as HTMLButtonElement; b.disabled = true; b.textContent = "Trying…"; try { await orb.retry(); } finally { b.disabled = false; b.textContent = "Try again"; void draw(); } });
document.getElementById("settings")!.addEventListener("click", () => { location.href = "./settings.html"; });
orb.onStatus(() => void draw());
void draw();
