export {};
declare const orb: any;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status"), saved = $("saved");
const fail = (e: any) => { saved.textContent = ""; status.textContent = String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""); };

function show(s: any) {
  $("signin").hidden = s.signedIn; $("signedin").hidden = !s.signedIn;
  const f = $<HTMLFormElement>("signin");
  if (!s.signedIn) {
    (f.elements.namedItem("url") as HTMLInputElement).value ||= s.url;
    (f.elements.namedItem("name") as HTMLInputElement).value ||= s.deviceName;
    (f.elements.namedItem("cfClientId") as HTMLInputElement).value ||= s.cfClientId;
  } else {
    $("where").textContent = s.url; $("device").textContent = s.deviceName;
    const p = $<HTMLFormElement>("prefs");
    (p.elements.namedItem("notifications") as HTMLInputElement).checked = s.notifications;
    (p.elements.namedItem("startAtLogin") as HTMLInputElement).checked = s.startAtLogin;
    (p.elements.namedItem("shortcut") as HTMLInputElement).value = s.shortcut;
    (p.elements.namedItem("miniShortcut") as HTMLInputElement).value = s.miniShortcut;
    (p.elements.namedItem("cfClientId") as HTMLInputElement).value = s.cfClientId;
    if (s.lastError) status.textContent = s.lastError;
  }
  $("keyring").textContent = s.keyring === "file" ? "No keyring was found, so this computer's key is kept in a file only your account can read. Install and unlock GNOME Keyring or KWallet to encrypt it." : "";
}

$<HTMLFormElement>("signin").addEventListener("submit", async (e) => {
  e.preventDefault(); status.textContent = "";
  const f = new FormData(e.currentTarget as HTMLFormElement), go = $<HTMLButtonElement>("go");
  go.disabled = true; go.textContent = "Signing in…";
  try { show(await orb.signIn(Object.fromEntries(f))); } catch (x) { fail(x); } finally { go.disabled = false; go.textContent = "Sign in"; }
});
$<HTMLFormElement>("prefs").addEventListener("submit", async (e) => {
  e.preventDefault(); status.textContent = "";
  const f = e.currentTarget as HTMLFormElement, v = (n: string) => f.elements.namedItem(n) as HTMLInputElement;
  try {
    show(await orb.setSettings({ notifications: v("notifications").checked, startAtLogin: v("startAtLogin").checked, shortcut: v("shortcut").value, miniShortcut: v("miniShortcut").value, cfClientId: v("cfClientId").value, cfSecret: v("cfSecret").value || undefined }));
    v("cfSecret").value = ""; saved.textContent = "Saved.";
  } catch (x) { fail(x); }
});
$("open").addEventListener("click", () => orb.openOrb());
$("mini").addEventListener("click", () => orb.openMini());
$("signout").addEventListener("click", async () => { try { show(await orb.signOut()); saved.textContent = "Signed out of this computer."; } catch (x) { fail(x); } });
orb.onStatus((m: string) => { status.textContent = m; });
orb.state().then(show, fail);
