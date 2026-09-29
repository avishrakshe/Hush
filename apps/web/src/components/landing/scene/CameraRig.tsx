"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { shared, smoothstep } from "./layout";

/** One camera pose per chapter: [position, look-at]. */
const KEYS: [THREE.Vector3, THREE.Vector3][] = [
  // 01 THE LEAK — the whole flow and the public tape filling up below it, framed right of the headline
  [new THREE.Vector3(-2.6, 1.6, 12.6), new THREE.Vector3(-2.8, -0.35, 0)],
  // 02 THE VEIL — look down onto the membrane between traffic and chain
  [new THREE.Vector3(-2.9, 5.4, 9.8), new THREE.Vector3(-2.3, -1.3, -0.2)],
  // 03 HOW IT WORKS — provider side: vouchers in, Merkle roots down
  [new THREE.Vector3(5.4, 1.4, 8.8), new THREE.Vector3(2.9, -0.7, 0)],
  // 04 PROOF — straight down on the chain: roots on a metronome, nothing else
  [new THREE.Vector3(0.2, 12.5, 3.6), new THREE.Vector3(0.2, -2.2, -0.3)],
];

/** Midpoint between the agent and the providers. */
const FLOW_CENTER_X = 0.2;

export function CameraRig({ motion = true }: { motion?: boolean }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const pointer = useMemo(() => ({ x: 0, y: 0 }), []);
  const tmp = useMemo(() => ({ pos: new THREE.Vector3(), look: new THREE.Vector3(), cur: KEYS[0]![1].clone() }), []);

  // The canvas sits behind the page, so it never receives pointer events itself.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [pointer]);

  useFrame((_, dt) => {
    // Hold each pose while its chapter is being read; move during the last ~45% before the next one.
    const p = Math.min(Math.max(shared.uProgress.value, 0), KEYS.length - 1);
    const i = Math.min(Math.floor(p), KEYS.length - 2);
    const f = smoothstep(0.55, 1, p - i);
    const [pa, la] = KEYS[i]!;
    const [pb, lb] = KEYS[i + 1]!;
    tmp.pos.lerpVectors(pa, pb, f);
    tmp.look.lerpVectors(la, lb, f);

    // Poses are framed for a ~2.1:1 window with the copy column on the left. Narrower windows: back off along the
    // view ray so the flow still fits, and on portrait screens (copy stacked full-width) re-centre on the flow.
    const aspect = size.width / Math.max(1, size.height);
    const recenter = (FLOW_CENTER_X - tmp.look.x) * (1 - smoothstep(0.9, 1.5, aspect));
    tmp.pos.x += recenter;
    tmp.look.x += recenter;
    if (aspect < 2.1) tmp.pos.sub(tmp.look).multiplyScalar(Math.min(2.2, (2.1 / aspect) ** 0.85)).add(tmp.look);

    if (motion) {
      tmp.pos.x += pointer.x * 0.35;
      tmp.pos.y -= pointer.y * 0.2;
    }
    const k = motion ? 1 - Math.exp(-dt * 3.2) : 1;
    camera.position.lerp(tmp.pos, k);
    tmp.cur.lerp(tmp.look, k);
    camera.lookAt(tmp.cur);
  });

  return null;
}
