import { useEffect, useRef } from "react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A modal dialog's keyboard rules: focus moves into it when it opens (to
 *  `first` if given), Tab and Shift+Tab stay inside it, Escape closes it, and
 *  focus goes back to what had it before when it closes. */
export function useDialog<T extends HTMLElement>(onClose: () => void, first?: string) {
  const ref = useRef<T>(null), close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const before = document.activeElement as HTMLElement | null;
    const items = () => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(x => x.offsetParent !== null || x === document.activeElement);
    (first && el.querySelector<HTMLElement>(first) || items()[0] || el).focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close.current(); return; }
      if (e.key !== "Tab") return;
      const list = items(); if (!list.length) { e.preventDefault(); return; }
      const i = list.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); list[list.length - 1].focus(); }
      else if (!e.shiftKey && (i === -1 || i === list.length - 1)) { e.preventDefault(); list[0].focus(); }
    };
    el.addEventListener("keydown", key);
    return () => { el.removeEventListener("keydown", key); if (before && document.contains(before)) before.focus(); };
  }, []);
  return ref;
}
