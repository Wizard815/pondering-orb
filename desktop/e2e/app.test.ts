import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../../server/src/app.js";
import { loadConfig } from "../../server/src/config.js";

// The real app (Electron) against a real Orb server with the built web page.
// Needs a display: on Linux run it under xvfb-run. Build the web page first (npm run build at the root).
const require = createRequire(import.meta.url);
const { _electron } = require("playwright");
const SHOTS = process.env.ORB_DESKTOP_SHOTS;

let orb: Awaited<ReturnType<typeof buildApp>>, url = "", app: any, page: any;
before(async () => {
  orb = await buildApp({ config: { ...loadConfig("/nonexistent.yaml", {}) }, password: "correct horse", webDir: resolve(import.meta.dirname, "../../web/dist") });
  url = await orb.app.listen({ port: 0, host: "127.0.0.1" });
  app = await _electron.launch({
    executablePath: require("electron") as unknown as string,
    args: [resolve(import.meta.dirname, ".."), "--no-sandbox"],
    env: { ...process.env, ORB_DESKTOP_DATA: mkdtempSync(join(tmpdir(), "orb-desktop-e2e-")), ORB_DESKTOP_TEST: "1", ORB_DESKTOP_SHOW: "1", ORB_DESKTOP_POLL_MS: "1500" },
  });
  page = await app.firstWindow();
});
after(async () => { await app?.close(); await orb?.app.close(); });
const shot = async (p: any, name: string) => { if (SHOTS) await p.screenshot({ path: join(SHOTS, `${name}.png`) }); };

test("TestDesktop_SignInOpensOrbSignedIn", async () => {
  await page.getByLabel("Orb's address").fill(url);
  await page.getByLabel("Orb's password").fill("wrong");
  await page.getByLabel("Name for this computer").fill("Test PC");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByText("That password isn't right.").waitFor();
  await shot(page, "1-sign-in-wrong");
  await page.getByLabel("Orb's password").fill("correct horse");
  await page.getByRole("button", { name: "Sign in" }).click();
  // The window goes to Orb itself, already signed in with the session the key bought.
  await page.waitForURL((u: URL) => u.toString().startsWith(url));
  assert.equal(await page.evaluate(() => fetch("/api/me").then(r => r.status)), 200);
  const devices = orb.auth.devices.list();
  assert.deepEqual(devices.map(d => [d.name, d.platform]), [["Test PC", process.platform === "linux" ? "linux" : devices[0].platform]]);
  await page.waitForTimeout(1500);
  await shot(page, "2-orb-in-the-app");
});

test("TestDesktop_MiniViewTicksOffATask", async () => {
  const t: any = orb.records.create("tasks", { title: "Renew the domain", priority: 2, done: false });
  await page.goto("file://" + resolve(import.meta.dirname, "../dist/pages/settings.html"));
  const [mini] = await Promise.all([app.waitForEvent("window"), page.getByRole("button", { name: "Orb at a glance" }).click()]);
  await mini.getByText("Renew the domain").waitFor({ timeout: 10000 });
  await shot(mini, "3-mini-view");
  await mini.getByRole("button", { name: "Tick off: Renew the domain" }).click();
  for (let i = 0; i < 50 && !(orb.records.get("tasks", t.id) as any)?.done; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal((orb.records.get("tasks", t.id) as any).done, true);
});

test("TestDesktop_RemovedDeviceSignsOut", async () => {
  const [d] = orb.auth.devices.list();
  orb.auth.devices.remove(d.id);
  await page.getByText("This computer was signed out of Orb").waitFor({ timeout: 10000 });
  await page.getByLabel("Orb's password").waitFor();
});
