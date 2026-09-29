"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { LABELS, labelEls } from "./coords";
import { AGENT, COLORS, PROVIDERS, shared, smoothstep } from "./layout";

const agentCore = COLORS.cyan.clone().multiplyScalar(2.4);
const providerCore = COLORS.ink.clone().multiplyScalar(1.6);

/** The agent (left) and the three paid APIs it calls (right). Bobbing is local to each node's positioned group. */
export function Nodes() {
  const agent = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const providers = useRef<(THREE.Group | null)[]>([]);

  useFrame((_, dt) => {
    const t = shared.uTime.value;
    if (agent.current) {
      agent.current.rotation.y += dt * 0.25;
      agent.current.position.y = Math.sin(t * 0.8) * 0.06;
    }
    if (ring.current) ring.current.rotation.z += dt * 0.4;
    providers.current.forEach((g, i) => {
      if (!g) return;
      g.rotation.y -= dt * (0.3 + i * 0.07);
      g.position.y = Math.sin(t * 0.9 + i * 2.1) * 0.05;
    });
  });

  return (
    <>
      <group position={AGENT}>
        <group ref={agent}>
          <mesh>
            <icosahedronGeometry args={[0.55, 1]} />
            <meshBasicMaterial color={COLORS.cyan} wireframe transparent opacity={0.45} />
          </mesh>
          <mesh>
            <sphereGeometry args={[0.17, 24, 24]} />
            <meshBasicMaterial color={agentCore} toneMapped={false} />
          </mesh>
        </group>
        <mesh ref={ring} rotation={[Math.PI / 2.3, 0.2, 0]}>
          <torusGeometry args={[0.9, 0.006, 6, 96]} />
          <meshBasicMaterial color={COLORS.violet} transparent opacity={0.7} />
        </mesh>
      </group>

      {PROVIDERS.map((p, i) => (
        <group key={p.name} position={p.pos}>
          <group ref={(g) => void (providers.current[i] = g)}>
            <mesh>
              <octahedronGeometry args={[0.3, 0]} />
              <meshBasicMaterial color={COLORS.ink} wireframe transparent opacity={0.55} />
            </mesh>
            <mesh>
              <octahedronGeometry args={[0.08, 0]} />
              <meshBasicMaterial color={providerCore} toneMapped={false} />
            </mesh>
          </group>
        </group>
      ))}
    </>
  );
}

/**
 * Pins the page-level DOM labels (SceneLabels) to their scene points. Plain DOM + one projection per label per frame,
 * instead of drei's <Html>, which mounts a React root per label.
 */
export function LabelProjector() {
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    const fade = 1 - smoothstep(2.4, 2.9, shared.uProgress.value); // PROOF looks straight down: labels would clutter
    for (const label of LABELS) {
      const el = labelEls.get(label.id);
      if (!el) continue;
      v.set(label.at[0], label.at[1], label.at[2]).project(camera);
      const x = (v.x * 0.5 + 0.5) * size.width;
      const y = (-v.y * 0.5 + 0.5) * size.height;
      const shift = label.anchor === "below" ? "translate(-50%, 0)" : "translate(0, -50%)";
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) ${shift}`;
      el.style.opacity = v.z > 1 ? "0" : fade.toFixed(3);
    }
  });
  return null;
}
