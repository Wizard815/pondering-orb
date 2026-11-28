import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

// The app's own pages (settings, mini view, offline) get these calls. Orb's web page,
// loaded from the server, gets nothing: no Node, no Electron, no key.
const CHANNELS = ["state", "signIn", "signOut", "setSettings", "openOrb", "retry", "glance", "refresh", "done", "closeMini", "openMini"];
const listen = (ch: string) => (cb: (...a: any[]) => void) => {
  const f = (_e: IpcRendererEvent, ...a: any[]) => cb(...a);
  ipcRenderer.on(`orb:${ch}`, f);
  return () => { ipcRenderer.removeListener(`orb:${ch}`, f); };
};
if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("orb", {
    ...Object.fromEntries(CHANNELS.map((c) => [c, (...a: unknown[]) => ipcRenderer.invoke(`orb:${c}`, ...a)])),
    onGlance: listen("glance"), onStatus: listen("status"),
  });
}
