// The main process and preload (Node, for Electron) and the app's own pages (browser), bundled with esbuild.
import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const node = { bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"], logLevel: "warning" };
await build({ ...node, entryPoints: ["src/main.ts"], outfile: "dist/main.cjs" });
await build({ ...node, entryPoints: ["src/preload.ts"], outfile: "dist/preload.cjs" });
mkdirSync("dist/pages", { recursive: true });
await build({ bundle: true, platform: "browser", format: "iife", target: "chrome130", logLevel: "warning",
  entryPoints: ["pages/settings.ts", "pages/offline.ts", "pages/mini.ts", "pages/style.css"], outdir: "dist/pages",
  loader: { ".woff2": "file", ".woff": "file" }, assetNames: "fonts/[name]-[hash]" });
for (const f of ["settings.html", "offline.html", "mini.html", "mini.css", "icon.svg"]) cpSync(`pages/${f}`, `dist/pages/${f}`);
