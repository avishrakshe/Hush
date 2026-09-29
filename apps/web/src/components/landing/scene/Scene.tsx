"use client";

import { PerformanceMonitor } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { useState } from "react";
import * as THREE from "three";
import { landing, scrollState } from "../state";
import { CameraRig } from "./CameraRig";
import { Ledger } from "./Ledger";
import { Merkle } from "./Merkle";
import { LabelProjector, Nodes } from "./Nodes";
import { Packets } from "./Packets";
import { Veil } from "./Veil";
import { shared } from "./layout";

export type Quality = "high" | "low";

/** Writes the shared uniforms once per frame, before anything else reads them (negative priority keeps auto-render). */
function Driver() {
  const gl = useThree((s) => s.gl);
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1); // no jumps after a background tab resumes
    shared.uTime.value += dt;
    const target = landing.get().mode === "hush" ? 1 : 0;
    shared.uHush.value = THREE.MathUtils.damp(shared.uHush.value, target, 2.4, dt);
    shared.uProgress.value = THREE.MathUtils.damp(shared.uProgress.value, scrollState.progress, 4, dt);
    shared.uPixelRatio.value = gl.getPixelRatio();
  }, -1);
  return null;
}

export default function Scene({ quality: initial, onReady }: { quality: Quality; onReady: () => void }) {
  // Bloom and high DPR go first if the frame rate drops; particle count is fixed at mount to avoid a visual pop.
  const [quality, setQuality] = useState(initial);
  const high = quality === "high";
  return (
    <Canvas
      dpr={high ? [1, 1.75] : [1, 1.25]}
      flat
      gl={{ antialias: !high, powerPreference: "high-performance", alpha: false, stencil: false }}
      camera={{ fov: 38, near: 0.1, far: 80, position: [-2.6, 1.6, 12.6] }}
      onCreated={() => requestAnimationFrame(onReady)}
    >
      <color attach="background" args={["#05060A"]} />
      <PerformanceMonitor flipflops={2} onDecline={() => setQuality("low")} onFallback={() => setQuality("low")} />
      <Driver />
      <CameraRig />
      <Ledger />
      <Veil />
      <Packets count={initial === "high" ? 170 : 100} />
      <Merkle />
      <Nodes />
      <LabelProjector />
      {high && (
        <EffectComposer multisampling={4}>
          <Bloom mipmapBlur luminanceThreshold={0.22} luminanceSmoothing={0.3} intensity={0.85} radius={0.7} />
        </EffectComposer>
      )}
    </Canvas>
  );
}
