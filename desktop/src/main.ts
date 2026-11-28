import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, Notification, safeStorage, session, shell, Tray, type MenuItemConstructorOptions } from "electron";
import { hostname } from "node:os";
import { join } from "node:path";
import { cleanUrl, Orb, OrbError, SignedOut, toNotify, trayLine, type Access, type Glance } from "./orb.js";
import { NO_KEYCHAIN, Store, type Settings } from "./store.js";
import { linuxAutostart } from "./autostart.js";

// ORB_DESKTOP_DATA: a separate profile (tests, or a second Orb on one computer account).
if (process.env.ORB_DESKTOP_DATA) app.setPath("userData", process.env.ORB_DESKTOP_DATA);
const TESTING = !!process.env.ORB_DESKTOP_TEST;
const POLL_MS = Number(process.env.ORB_DESKTOP_POLL_MS) || 60_000;
if (!TESTING && !app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId("com.ponderingorb.desktop");   // Windows: notifications carry Orb's name and icon

const ROOT = join(__dirname, "..");
const icon = (name: string) => nativeImage.createFromPath(join(ROOT, "build", name));
const page = (name: string) => join(ROOT, "dist", "pages", `${name}.html`);
const PLATFORM = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : process.platform === "linux" ? "linux" : "other";

let store: Store, orb: Orb | undefined, win: BrowserWindow | undefined, mini: BrowserWindow | undefined, tray: Tray | undefined;
let quitting = false, lastError = "", cfCookie = "", poller: NodeJS.Timeout | undefined, offline = false;

const access = (): Access => ({ clientId: store.settings.cfClientId, clientSecret: store.secrets.cfSecret, cookie: cfCookie });
const origin = () => { try { return new URL(store.settings.url || "").origin; } catch { return ""; } };
const signedIn = () => !!orb?.token;
const glance = () => store.settings.glance;

// ---------- windows ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 420, minHeight: 500, show: false,
    title: "Pondering Orb", icon: icon("icon.png"), backgroundColor: "#0f1119", autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  const wc = win.webContents;
  // Orb's own pages, Cloudflare Access's sign-in and the app's local pages stay in the window; everything else opens in the browser.
  const inside = (url: string) => url.startsWith("file://") || (!!origin() && url.startsWith(origin() + "/")) || url === origin() || /^https:\/\/[^/]+\.cloudflareaccess\.com\//.test(url);
  wc.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); return { action: "deny" }; });
  wc.on("will-navigate", (e, url) => { if (!inside(url)) { e.preventDefault(); if (/^https?:\/\//.test(url)) void shell.openExternal(url); } });
  wc.on("did-fail-load", (_e, code, desc, url, mainFrame) => {
    if (!mainFrame || code === -3 || url.startsWith("file://")) return;   // -3: a navigation that was replaced
    lastError = `Can't reach Orb (${desc})`; showOffline();
  });
  wc.on("did-navigate", (_e, url) => { if (!url.startsWith("file://")) offline = false; });
  win.on("close", (e) => { if (!quitting && tray) { e.preventDefault(); win!.hide(); } });
  return win;
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); void load(); }
  win!.show(); win!.focus();
}
function toggleWindow() { if (win && win.isVisible() && win.isFocused()) win.hide(); else showWindow(); }

/** What the main window shows: Orb itself, the setup page, or the offline page. */
async function load() {
  if (!win || win.isDestroyed()) return;
  if (!signedIn()) { await win.loadFile(page("settings")); return; }
  try {
    await freshSession();
    offline = false;
    await win.loadURL(store.settings.url!);
  } catch (e) {
    if (e instanceof SignedOut) return signedOut(e.message);
    // A Cloudflare Access sign-in page: show it, and the window carries on to Orb after.
    if (e instanceof OrbError && /Cloudflare Access is asking/.test(e.message) && !store.settings.cfClientId) { await win.loadURL(store.settings.url!).catch(() => {}); return; }
    lastError = (e as Error).message; showOffline();
  }
}
function showOffline() { offline = true; void win?.loadFile(page("offline")); }

/** The window's session cookie, bought with this computer's key (so the page never asks for the password). */
async function freshSession() {
  await readCfCookie();
  const s = await orb!.session();
  const u = new URL(store.settings.url!);
  await session.defaultSession.cookies.set({ url: u.origin, name: "orb_session", value: s.session, path: "/", httpOnly: true, secure: u.protocol === "https:", sameSite: "strict", expirationDate: Math.floor(Date.now() / 1000) + s.maxAge });
}

/** Cloudflare Access: with a service token, every request to Orb from the window carries it;
 *  without one, the CF_Authorization cookie from signing in there is reused for the background checks. */
function accessHeaders() {
  const o = origin();
  session.defaultSession.webRequest.onBeforeSendHeaders(o ? { urls: [`${o}/*`] } : { urls: [] }, (d, cb) => {
    const a = access();
    if (a.clientId && a.clientSecret) { d.requestHeaders["CF-Access-Client-Id"] = a.clientId; d.requestHeaders["CF-Access-Client-Secret"] = a.clientSecret; }
    cb({ requestHeaders: d.requestHeaders });
  });
}
async function readCfCookie() {
  const o = origin(); if (!o) return;
  const c = await session.defaultSession.cookies.get({ url: o, name: "CF_Authorization" }).catch(() => []);
  cfCookie = c[0]?.value || "";
}

function openMini() {
  if (mini && !mini.isDestroyed()) { mini.show(); mini.focus(); return; }
  mini = new BrowserWindow({
    width: 360, height: 520, minWidth: 300, minHeight: 300, alwaysOnTop: true, skipTaskbar: true, show: !TESTING || !!process.env.ORB_DESKTOP_SHOW,
    title: "Orb at a glance", icon: icon("icon.png"), backgroundColor: "#0f1119", autoHideMenuBar: true, maximizable: false, fullscreenable: false,
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  mini.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mini.webContents.on("will-navigate", (e) => e.preventDefault());
  void mini.loadFile(page("mini"));
}
function toggleMini() { if (mini && !mini.isDestroyed() && mini.isVisible()) mini.hide(); else openMini(); }
const sendAll = (ch: string, ...a: unknown[]) => { for (const w of [win, mini]) if (w && !w.isDestroyed()) w.webContents.send(`orb:${ch}`, ...a); };

// ---------- tray ----------

function setTray() {
  if (!tray) return;
  const g = glance(), down = g?.uptime?.down || [], line = trayLine(signedIn() ? g : undefined, signedIn() ? lastError : "");
  tray.setImage(icon(down.length || lastError ? "tray-alert.png" : "tray.png"));
  tray.setToolTip(signedIn() ? line : "Pondering Orb: not signed in");
  const items: MenuItemConstructorOptions[] = [{ label: signedIn() ? line : "Not signed in", enabled: false }];
  for (const d of down.slice(0, 6)) items.push({ label: `   ⚠ ${d}`, enabled: false });
  items.push({ type: "separator" }, { label: "Open Orb", accelerator: store.settings.shortcut || undefined, click: showWindow });
  if (signedIn()) {
    items.push({ label: "Orb at a glance", accelerator: store.settings.miniShortcut || undefined, click: openMini });
    if (g?.tasks.length) items.push({ label: "Tick off a task", submenu: g.tasks.slice(0, 8).map(t => ({ label: `${t.overdue ? "⚠ " : ""}${t.title}${t.due ? `  (${t.due})` : ""}`.slice(0, 80), click: () => void tick(t.id, t.title) })) });
    if (g?.events.length) items.push({ label: "Today", submenu: g.events.map(e => ({ label: `${e.time || "all day"}  ${e.title}`.slice(0, 80), enabled: false })) });
    for (const m of g?.media || []) items.push({ label: `${m.name}: ${m.line}`.slice(0, 80), enabled: false });
    items.push({ label: "Check now", click: () => void poll() });
  }
  items.push({ type: "separator" },
    { label: "Notifications", type: "checkbox", checked: store.settings.notifications, click: (i) => setSettings({ notifications: i.checked }) },
    { label: "Start when I sign in to this computer", type: "checkbox", checked: store.settings.startAtLogin, click: (i) => setSettings({ startAtLogin: i.checked }) },
    { label: "Settings…", click: () => { showWindow(); void win!.loadFile(page("settings")); } },
    { type: "separator" },
    { label: "Quit Orb", click: () => { quitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
  if (process.platform !== "darwin") app.setBadgeCount?.(down.length);
}

async function tick(id: string, title: string) {
  try {
    await orb!.done(id);
    const g = glance(); if (g) store.set({ glance: { ...g, tasks: g.tasks.filter(t => t.id !== id) } });
    setTray(); sendAll("glance", glance());
    notify("Done", title);
  } catch (e) { notify("Couldn't tick that off", (e as Error).message); }
}

function notify(title: string, body: string) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: icon("icon.png") });
  n.on("click", showWindow); n.show();
}

// ---------- background checks ----------

async function poll() {
  if (!orb?.token) return;
  await readCfCookie();
  try {
    const g = await orb.glance();
    store.set({ glance: g }); lastError = "";
    sendAll("glance", g);
    const seen = store.settings.alertsSeen;
    const a = await orb.alerts(seen ?? Date.now());
    // The first check only notes the time, so a new install doesn't replay old alerts.
    const newest = a.alerts.length ? a.alerts[a.alerts.length - 1].at : seen ?? a.now;
    store.set({ alertsSeen: newest });
    if (seen !== undefined && a.alerts.length && store.settings.notifications) {
      const { show, more } = toNotify(a.alerts);
      for (const x of show) notify(x.title, x.message);
      if (more) notify("Orb", `${more} more ${more === 1 ? "alert" : "alerts"} while you were away.`);
    }
    if (offline && win && !win.isDestroyed()) void load();   // back online: show Orb again
  } catch (e) {
    if (e instanceof SignedOut) return signedOut(e.message);
    lastError = (e as Error).message;
    sendAll("status", lastError);
  } finally { setTray(); }
}
function startPolling() { stopPolling(); void poll(); poller = setInterval(() => void poll(), POLL_MS); }
function stopPolling() { if (poller) clearInterval(poller); poller = undefined; }

function signedOut(message: string) {
  stopPolling(); store.forget(); orb = undefined; lastError = "";
  void session.defaultSession.cookies.remove(origin(), "orb_session").catch(() => {});
  setTray();
  mini?.close();
  if (win && !win.isDestroyed()) { void win.loadFile(page("settings")).then(() => win!.webContents.send("orb:status", message)); showWindow(); }
}

// ---------- settings ----------

function setShortcut(next: string, prev: string | undefined, run: () => void) {
  if (prev) globalShortcut.unregister(prev);
  if (!next) return true;
  try { return globalShortcut.register(next, run); } catch { return false; }
}
function setSettings(patch: Partial<Settings>) {
  const prev = { ...store.settings };
  store.set(patch);
  if (patch.startAtLogin !== undefined && !TESTING) {
    if (process.platform === "linux") linuxAutostart(patch.startAtLogin, process.env.APPIMAGE || process.execPath);
    else app.setLoginItemSettings({ openAtLogin: patch.startAtLogin, args: ["--hidden"] });
  }
  for (const [key, run] of [["shortcut", toggleWindow], ["miniShortcut", toggleMini]] as const) {
    if (patch[key] === undefined || patch[key] === prev[key]) continue;
    if (!setShortcut(patch[key]!, prev[key], run)) {
      store.set({ [key]: prev[key] }); setShortcut(prev[key], undefined, run);
      throw new OrbError(`"${patch[key]}" didn't work as a shortcut (another app may use it). The old one still works.`);
    }
  }
  setTray();
  return state();
}

const state = () => ({
  signedIn: signedIn(), url: store.settings.url || "", deviceName: store.settings.deviceName || defaultName(), cfClientId: store.settings.cfClientId || "",
  cfSecretSet: !!store.secrets.cfSecret, notifications: store.settings.notifications, startAtLogin: store.settings.startAtLogin,
  shortcut: store.settings.shortcut, miniShortcut: store.settings.miniShortcut, keyring: store.keeping, platform: process.platform, lastError, glance: glance(),
});
const defaultName = () => `${hostname().split(".")[0] || "Computer"} (${PLATFORM === "windows" ? "Windows" : PLATFORM === "linux" ? "Linux" : PLATFORM})`;

const handle = (ch: string, fn: (...a: any[]) => unknown) =>
  ipcMain.handle(`orb:${ch}`, async (e, ...a) => {
    // Only the app's own pages (files) may call in, never a web page in the window.
    if (!e.senderFrame?.url.startsWith("file://")) throw new Error("Not allowed.");
    try { return await fn(...a); } catch (x: any) { throw new Error(x instanceof OrbError ? x.message : x?.message || "Something went wrong."); }
  });

function registerIpc() {
  handle("state", () => state());
  handle("signIn", async (f: { url: string; password: string; name: string; cfClientId?: string; cfSecret?: string }) => {
    const url = cleanUrl(f.url);
    if (store.keeping === "none") throw new OrbError(NO_KEYCHAIN);   // before Orb makes a key this computer couldn't keep
    const cfId = String(f.cfClientId || "").trim(), cfSecret = String(f.cfSecret || "").trim();
    if (!!cfId !== !!(cfSecret || store.secrets.cfSecret)) throw new OrbError("A Cloudflare service token needs both its Client ID and its Client Secret.");
    const prevUrl = store.settings.url;
    store.set({ url, cfClientId: cfId || undefined });
    if (cfSecret) store.saveSecrets({ cfSecret });
    accessHeaders(); await readCfCookie();
    const o = new Orb(url, "", access);
    let d;
    try { d = await o.signIn(String(f.password || ""), String(f.name || "").trim() || defaultName(), PLATFORM); }
    catch (e) { if (prevUrl !== url && !signedIn()) store.set({ url: prevUrl }); throw e; }
    store.saveSecrets({ token: d.token });
    store.set({ deviceId: d.id, deviceName: d.name, alertsSeen: undefined, glance: undefined });
    orb = new Orb(url, d.token, access);
    startPolling(); setTray();
    void load();
    return state();
  });
  handle("signOut", async () => {
    try { if (orb && store.settings.deviceId) await orb.signOut(store.settings.deviceId); } catch (e) {
      if (!(e instanceof SignedOut)) throw new OrbError(`Couldn't remove this computer on Orb (${(e as Error).message}). Try again, or remove it in Orb's Settings → Devices.`);
    }
    signedOut("Signed out of this computer.");
    return state();
  });
  handle("setSettings", (p: Partial<Settings> & { cfSecret?: string }) => {
    const patch: Partial<Settings> = {};
    for (const k of ["notifications", "startAtLogin"] as const) if (typeof p[k] === "boolean") patch[k] = p[k];
    for (const k of ["shortcut", "miniShortcut", "cfClientId"] as const) if (typeof p[k] === "string") patch[k] = p[k]!.trim();
    if (p.cfSecret) store.saveSecrets({ cfSecret: p.cfSecret.trim() });
    if (patch.cfClientId === "") store.saveSecrets({ cfSecret: undefined });
    const s = setSettings(patch);
    accessHeaders();
    return s;
  });
  handle("openOrb", () => { showWindow(); void load(); });
  handle("retry", async () => { await poll(); await load(); return state(); });
  handle("glance", () => glance());
  handle("refresh", async () => { await poll(); return glance(); });
  handle("done", (id: string, title: string) => tick(String(id), String(title || "")));
  handle("closeMini", () => mini?.hide());
  handle("openMini", () => openMini());
}

// ---------- start ----------

app.on("second-instance", showWindow);
app.on("window-all-closed", () => { /* stay in the tray */ });
app.on("before-quit", () => { quitting = true; });

app.whenReady().then(() => {
  store = new Store(app.getPath("userData"), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
    plainOk: process.platform === "linux",
  });
  const token = store.secrets.token;
  if (token && store.settings.url) orb = new Orb(store.settings.url, token, access);
  // The window gets no camera, microphone, location or notifications of its own: the app notifies.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "clipboard-sanitized-write" || perm === "fullscreen"));
  accessHeaders();
  registerIpc();
  Menu.setApplicationMenu(null);
  tray = new Tray(icon("tray.png"));
  tray.on("click", toggleWindow);
  setShortcut(store.settings.shortcut, undefined, toggleWindow);
  setShortcut(store.settings.miniShortcut, undefined, toggleMini);
  createWindow();
  void load();
  // --hidden (start at sign-in): straight to the tray, unless there's nothing to show yet.
  if (!process.argv.includes("--hidden") || !signedIn()) { if (!TESTING || process.env.ORB_DESKTOP_SHOW) win!.show(); }
  if (signedIn()) startPolling();
  setTray();
});

app.on("will-quit", () => globalShortcut.unregisterAll());
