/** Theme presets ported from the demo page. Tokens are CSS custom properties. */
export const TOKENS = ["bg","panel","inset","line","line-hi","ink","muted","gold","gold-soft","arcane","arcane-soft","star","ok","warn","bad","ok-bg","warn-bg","bad-bg","orb-hi","orb-mid","orb-deep"];
export const SEM_DARK = {ok:"#7cc48f", warn:"#e2b553", bad:"#e8796c", "ok-bg":"#1a3123", "warn-bg":"#3a301b", "bad-bg":"#3e2121"};
export const PRESETS: Record<string, {name:string; scheme:string; t:Record<string,string>}> = {
    night:{name:"Night tower", scheme:"dark", t:{bg:"#0f1119",panel:"#161a28",inset:"#1d2133",line:"#2d3352","line-hi":"#4a4568",ink:"#ebe3cf",muted:"#9d99ad",gold:"#d9a94f","gold-soft":"#3a2f1b",arcane:"#7ccac2","arcane-soft":"#183236",star:"rgba(235,227,207,.55)",...SEM_DARK,"orb-hi":"#e8fffb","orb-mid":"#5fb6ad","orb-deep":"#141c3a"}},
    parchment:{name:"Parchment", scheme:"light", t:{bg:"#ebe2cd",panel:"#f6efdf",inset:"#ede3cc",line:"#cfbf9c","line-hi":"#b39c6e",ink:"#2a2217",muted:"#6d604b",gold:"#8b5b12","gold-soft":"#efdbb1",arcane:"#1f6d67","arcane-soft":"#d3e7e1",star:"rgba(0,0,0,0)",ok:"#2e7a4c",warn:"#9a6a0c",bad:"#b03a2d","ok-bg":"#dcecdf","warn-bg":"#f3e4c3","bad-bg":"#f4dbd5","orb-hi":"#ffffff","orb-mid":"#4aa39a","orb-deep":"#1d3159"}},
    library:{name:"Arcane library", scheme:"dark", t:{bg:"#0e1512",panel:"#142019",inset:"#1a2a21",line:"#2a3d32","line-hi":"#3f5a49",ink:"#e6e9dc",muted:"#98a89c",gold:"#c9a35a","gold-soft":"#33301f",arcane:"#6fc3a0","arcane-soft":"#183327",star:"rgba(230,233,220,.4)",...SEM_DARK,"orb-hi":"#eafff4","orb-mid":"#4fae86","orb-deep":"#0f2a20"}},
    forge:{name:"Ember forge", scheme:"dark", t:{bg:"#141110",panel:"#1d1816",inset:"#261f1c",line:"#3a2f2a","line-hi":"#5a463c",ink:"#f0e4d8",muted:"#a8968a",gold:"#e8893a","gold-soft":"#3d2615",arcane:"#e0b35a","arcane-soft":"#3a2d18",star:"rgba(240,228,216,.35)",ok:"#8cc47c",warn:"#e8b04a",bad:"#ef6b5a","ok-bg":"#20301b","warn-bg":"#3d3019","bad-bg":"#432019","orb-hi":"#fff1df","orb-mid":"#e07a3a","orb-deep":"#3a1508"}},
    frost:{name:"Frost spire", scheme:"dark", t:{bg:"#0f141b",panel:"#161d27",inset:"#1c2532",line:"#2c3a4d","line-hi":"#456079",ink:"#e4ecf4",muted:"#94a3b4",gold:"#a9c7e8","gold-soft":"#1f2d3d",arcane:"#8fe0ea","arcane-soft":"#163239",star:"rgba(228,236,244,.6)",...SEM_DARK,"orb-hi":"#f3fbff","orb-mid":"#7fb8e0","orb-deep":"#142640"}}
  };
export const EDITABLE: [string,string][] = [["bg","Background"],["panel","Panels"],["inset","Insets"],["line","Borders"],["ink","Text"],["muted","Quiet text"],["gold","Accent"],["arcane","Second accent"],["orb-mid","Orb glow"]];
export const PAGE_W: Record<string,string> = { fit: "none", wide: "1680px", comfortable: "1240px" };
export const GOLEM_FS: Record<string,string> = { s: ".86rem", m: ".95rem", l: "1.06rem", xl: "1.2rem" };

export function applyAppearance(s: Record<string, any>) {
  const root = document.documentElement.style;
  const th = { mode: "auto", preset: "night", custom: {}, ...(s.theme || {}) };
  if (th.mode === "auto") { TOKENS.forEach(t => root.removeProperty("--" + t)); root.removeProperty("color-scheme"); }
  else { const pr = PRESETS[th.preset] || PRESETS.night; const vals: Record<string,string> = { ...pr.t, ...(th.mode === "custom" ? th.custom : {}) };
    TOKENS.forEach(t => { if (vals[t]) root.setProperty("--" + t, vals[t]); }); root.setProperty("color-scheme", pr.scheme); }
  root.setProperty("--page-w", PAGE_W[s.pageWidth || "fit"] || "none");
  root.setProperty("--golem-fs", GOLEM_FS[s.golemFont || "m"]);
}
