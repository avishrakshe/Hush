"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { SceneLabels } from "./SceneLabels";
import type { Quality } from "./scene/Scene";

const Scene = dynamic(() => import("./scene/Scene"), { ssr: false });

function hasWebGL2() {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    gl?.getExtension("WEBGL_lose_context")?.loseContext(); // browsers cap live contexts; give the probe back
    return !!gl;
  } catch {
    return false;
  }
}

/**
 * Fixed background layer for the landing page. Always paints the static backdrop; upgrades to the WebGL scene once the
 * main thread is idle — unless the visitor prefers reduced motion or has no WebGL2, in which case the backdrop stays.
 */
export function SceneRoot() {
  const [kind, setKind] = useState<"pending" | "webgl" | "static">("pending");
  const [quality, setQuality] = useState<Quality>("high");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || !hasWebGL2()) {
      setKind("static");
      return;
    }
    const constrained =
      matchMedia("(max-width: 768px), (pointer: coarse)").matches || (navigator.hardwareConcurrency ?? 8) <= 4;
    setQuality(constrained ? "low" : "high");
    const start = () => setKind("webgl");
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(start, { timeout: 1500 });
      return () => window.cancelIdleCallback(id);
    }
    const id = setTimeout(start, 300);
    return () => clearTimeout(id);
  }, []);

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
      <div className="backdrop absolute inset-0" />
      {kind === "webgl" && (
        <div className={`absolute inset-0 transition-opacity duration-[1400ms] ${ready ? "opacity-100" : "opacity-0"}`}>
          <Scene quality={quality} onReady={() => setReady(true)} />
          <SceneLabels />
        </div>
      )}
      {/* vignette + left scrim keep the copy column legible over the brightest parts of the scene */}
      <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_45%,transparent_45%,rgba(5,6,10,0.75)_100%)]" />
      <div className="absolute inset-y-0 left-0 hidden w-[58%] bg-gradient-to-r from-bg/80 via-bg/35 to-transparent md:block" />
      {/* on phones the copy spans the full width, over the scene */}
      <div className="absolute inset-0 bg-bg/45 md:hidden" />
    </div>
  );
}
