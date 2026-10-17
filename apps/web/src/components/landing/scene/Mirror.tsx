"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { MIRROR_XYZ } from "./coords";
import { COLORS, LEDGER_Y, shared } from "./layout";

const core = COLORS.avax.clone().multiplyScalar(2.2);

/**
 * Mirror, the copycat: an eye hovering over the public tape. In public mode it locks onto the tape and pulses as it
 * copies; behind the veil there's nothing to read, so it dims and its scan beam wanders.
 */
export function Mirror() {
  const eye = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const beam = useRef<THREE.Mesh>(null);
  const coreMat = useRef<THREE.MeshBasicMaterial>(null);
  const ringMat = useRef<THREE.MeshBasicMaterial>(null);
  const beamMat = useRef<THREE.MeshBasicMaterial>(null);
  const pos = useMemo(() => new THREE.Vector3(...MIRROR_XYZ), []);
  const beamGeo = useMemo(() => {
    const len = pos.y - LEDGER_Y;
    return new THREE.ConeGeometry(0.32, len, 24, 1, true).translate(0, -len / 2, 0);
  }, [pos]);

  useFrame((_, dt) => {
    const t = shared.uTime.value;
    const hush = shared.uHush.value;
    const lock = 1 - hush;
    if (eye.current) eye.current.position.y = Math.sin(t * 0.7) * 0.05;
    if (ring.current) ring.current.rotation.z += dt * (0.3 + 1.6 * lock);
    // Public: a copy every ~1.6 s (sharp pulse). Hush: a slow idle glow.
    const pulse = lock * Math.pow(Math.max(0, Math.sin(t * 3.9)), 8) + 0.25 + 0.15 * Math.sin(t * 0.8) * hush;
    if (coreMat.current) coreMat.current.color.copy(core).multiplyScalar(0.35 + 0.9 * pulse);
    if (ringMat.current) ringMat.current.opacity = 0.25 + 0.5 * lock;
    if (beam.current && beamMat.current) {
      // Locked on the tape below, or sweeping around looking for something to copy.
      beam.current.rotation.z = hush * Math.sin(t * 0.9) * 0.6;
      beam.current.rotation.x = hush * Math.cos(t * 0.7) * 0.4;
      beamMat.current.opacity = 0.03 + 0.11 * lock * (0.5 + pulse);
    }
  });

  return (
    <group position={pos}>
      <group ref={eye}>
        <mesh>
          <sphereGeometry args={[0.13, 24, 24]} />
          <meshBasicMaterial ref={coreMat} color={core} toneMapped={false} />
        </mesh>
        <mesh>
          <icosahedronGeometry args={[0.34, 1]} />
          <meshBasicMaterial color={COLORS.avax} wireframe transparent opacity={0.35} />
        </mesh>
        <mesh ref={ring} rotation={[Math.PI / 2.2, 0, 0]}>
          <torusGeometry args={[0.55, 0.008, 6, 72]} />
          <meshBasicMaterial ref={ringMat} color={COLORS.leak} transparent opacity={0.6} />
        </mesh>
      </group>
      {/* tip at the eye, base on the tape, so rotating the mesh sweeps the beam around the eye */}
      <mesh ref={beam} geometry={beamGeo}>
        <meshBasicMaterial ref={beamMat} color={COLORS.avax} transparent opacity={0.2} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
    </group>
  );
}
