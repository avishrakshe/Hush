"use client";

import { useEffect } from "react";
import { landing, scrollState } from "./state";

/** Scroll into THE VEIL far enough and the page puts itself behind the veil (unless the visitor chose a mode). */
const HUSH_AT = 0.9;

/**
 * Measures how far the viewport centre has travelled through the `[data-chapter]` sections and publishes it as a
 * continuous 0 → 4 value. Rendered once on the landing page; renders nothing.
 */
export function ScrollProgress() {
  useEffect(() => {
    const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-chapter]"));
    let frame = 0;

    const measure = () => {
      frame = 0;
      const mid = window.innerHeight * 0.5;
      let progress = 0;
      for (const el of sections) {
        const r = el.getBoundingClientRect();
        progress += Math.min(1, Math.max(0, (mid - r.top) / Math.max(1, r.height)));
      }
      scrollState.progress = progress;
      landing.setChapter(Math.min(sections.length - 1, Math.floor(progress)));
      const s = landing.get();
      if (s.followScroll) landing.setMode(progress >= HUSH_AT ? "hush" : "public");
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return null;
}
