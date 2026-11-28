import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Glance } from "./orb.js";

export type Settings = {
  url?: string;
  deviceId?: string;            // this computer's entry in Orb's Settings → Devices
  deviceName?: string;
  cfClientId?: string;          // Cloudflare Access service token id (the secret is kept with the key)
  notifications: boolean;
  startAtLogin: boolean;
  shortcut: string;             // show or hide Orb
  miniShortcut: string;         // the mini view
  alertsSeen?: number;          // the newest alert this computer has shown
  glance?: Glance;              // the last one, for the tray and the offline view
};
export const DEFAULTS: Settings = { notifications: true, startAtLogin: false, shortcut: "CommandOrControl+Alt+O", miniShortcut: "CommandOrControl+Alt+M" };

/** The OS keychain (Electron's safeStorage), or a stand-in in tests.
 *  `plainOk`: with no keychain (Linux without a keyring), keep secrets in a file only this
 *  account can read, as other command-line tools do. Windows always has one. */
export type Vault = { available: () => boolean; encrypt: (s: string) => Buffer; decrypt: (b: Buffer) => string; plainOk?: boolean };
type Secrets = { token?: string; cfSecret?: string };

/** Settings in a JSON file; the device key and the Cloudflare secret encrypted by the
 *  OS keychain when there is one. Both files are readable by this account only.
 *  Orb's password is never kept. */
export class Store {
  private file: string; private keyFile: string; private plainFile: string;
  settings: Settings;
  constructor(dir: string, private vault: Vault) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "settings.json");
    this.keyFile = join(dir, "orb.key");
    this.plainFile = join(dir, "orb.key.json");
    let s: Partial<Settings> = {};
    try { s = JSON.parse(readFileSync(this.file, "utf8")); } catch { /* first run */ }
    this.settings = { ...DEFAULTS, ...s };
  }
  set(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    writeFileSync(this.file, JSON.stringify(this.settings, null, 2), { mode: 0o600 });
  }
  get keeping(): "os" | "file" | "none" { return this.vault.available() ? "os" : this.vault.plainOk ? "file" : "none"; }

  get secrets(): Secrets {
    try {
      if (existsSync(this.keyFile) && this.vault.available()) return JSON.parse(this.vault.decrypt(readFileSync(this.keyFile)));
      if (existsSync(this.plainFile) && this.vault.plainOk) return JSON.parse(readFileSync(this.plainFile, "utf8"));
    } catch { /* a key from another account, or a changed keychain: sign in again */ }
    return {};
  }
  saveSecrets(patch: Secrets) {
    const how = this.keeping;
    if (how === "none") throw new Error(NO_KEYCHAIN);
    const next = JSON.stringify({ ...this.secrets, ...patch });
    const [file, data] = how === "os" ? [this.keyFile, this.vault.encrypt(next)] : [this.plainFile, next];
    writeFileSync(file, data, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  forget() {
    const { cfSecret } = this.secrets;
    rmSync(this.keyFile, { force: true }); rmSync(this.plainFile, { force: true });
    // The Cloudflare token belongs to the address, not the sign-in: keep it.
    if (cfSecret) this.saveSecrets({ cfSecret });
    this.set({ deviceId: undefined, alertsSeen: undefined, glance: undefined });
  }
}

export const NO_KEYCHAIN = "This computer has no keychain Orb can use, so it can't keep you signed in. On Linux, install and unlock a keyring (GNOME Keyring or KWallet).";
