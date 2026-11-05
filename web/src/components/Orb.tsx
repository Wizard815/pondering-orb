import { useEffect, useRef } from "react";

/** The animated scrying orb in the header (canvas, follows theme tokens). */
export function Orb() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!, g = c.getContext("2d")!, R = c.width / 2;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const wisps = Array.from({ length: 5 }, (_, i) => ({ a: i * 1.26, r: 0.25 + 0.12 * (i % 3), s: 0.0025 + 0.0012 * i, size: 0.38 + 0.08 * (i % 2) }));
    let raf = 0;
    const frame = () => {
      const hi = css("--orb-hi"), mid = css("--orb-mid"), deep = css("--orb-deep");
      g.clearRect(0, 0, c.width, c.height); g.save(); g.beginPath(); g.arc(R, R, R, 0, Math.PI * 2); g.clip();
      const base = g.createRadialGradient(R * 0.7, R * 0.65, R * 0.1, R, R, R); base.addColorStop(0, mid); base.addColorStop(1, deep);
      g.fillStyle = base; g.fillRect(0, 0, c.width, c.height); g.globalCompositeOperation = "lighter";
      for (const w of wisps) { if (!reduce) w.a += w.s; const x = R + Math.cos(w.a) * R * w.r, y = R + Math.sin(w.a * 1.3) * R * w.r;
        const rg = g.createRadialGradient(x, y, 0, x, y, R * w.size); rg.addColorStop(0, mid); rg.addColorStop(1, "rgba(0,0,0,0)"); g.globalAlpha = 0.35; g.fillStyle = rg; g.fillRect(0, 0, c.width, c.height); }
      g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
      const sh = g.createRadialGradient(R * 0.62, R * 0.55, 0, R * 0.62, R * 0.55, R * 0.32); sh.addColorStop(0, hi); sh.addColorStop(1, "rgba(255,255,255,0)");
      g.globalAlpha = 0.7; g.fillStyle = sh; g.fillRect(0, 0, c.width, c.height); g.globalAlpha = 1; g.restore();
      if (!reduce && !document.hidden) raf = requestAnimationFrame(frame); else raf = 0;
    };
    frame();
    const vis = () => { if (!document.hidden && !raf && !reduce) frame(); };
    document.addEventListener("visibilitychange", vis);
    return () => { cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", vis); };
  }, []);
  return <div className="orb-wrap" aria-hidden="true"><canvas ref={ref} width={108} height={108} /></div>;
}
