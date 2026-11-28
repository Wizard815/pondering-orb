import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Start at sign-in. Windows and macOS have it built in (app.setLoginItemSettings);
 *  on Linux it's a .desktop file in ~/.config/autostart. The AppImage's own path is
 *  used when there is one, since the mounted copy moves each run. */
export function linuxAutostart(on: boolean, exec: string, dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "autostart")) {
  const file = join(dir, "pondering-orb.desktop");
  if (!on) { rmSync(file, { force: true }); return file; }
  mkdirSync(dir, { recursive: true });
  const q = /[\s"]/.test(exec) ? `"${exec.replace(/"/g, '\\"')}"` : exec;
  writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Pondering Orb\nComment=Your homelab dashboard, in the tray\nExec=${q} --hidden\nIcon=pondering-orb\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`);
  return file;
}
