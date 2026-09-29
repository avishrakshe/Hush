"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import {
  CADENCE_S,
  COLORS,
  LANES_Z,
  LEDGER_Y,
  MERKLE,
  OUTPUT_CHUNKS,
  ROOT_LAND_AT,
  TAPE_END_X,
  TAPE_SPEED,
  TOPUP,
  shared,
} from "./layout";

/**
 * The public chain: a ground plane whose block grid keeps scrolling whether or not anyone pays. In public mode the
 * packets (Packets.tsx) land here as receipts in one lane per provider. Behind the veil the only marks are batch roots
 * on a fixed metronome and the occasional fixed-size encrypted top-up — no lanes, no rhythm to read.
 */
const gridVertex = /* glsl */ `
  varying vec3 vWorld;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const gridFragment = /* glsl */ `
  uniform float uTime;
  uniform float uHush;
  uniform float uTapeSpeed;
  uniform float uLane[3];
  uniform float uTopupZ;
  uniform vec3 uGrid;
  uniform vec3 uPink;
  uniform vec3 uCyan;
  uniform vec3 uViolet;
  varying vec3 vWorld;
  varying vec2 vUv;

  float gridLine(float coord, float spacing) {
    float c = coord / spacing;
    float d = abs(fract(c - 0.5) - 0.5);
    return 1.0 - smoothstep(0.0, fwidth(c) * 1.2, d);
  }

  void main() {
    float bx = vWorld.x + uTime * uTapeSpeed; // blocks roll left as the chain advances
    float minor = max(gridLine(bx, 0.6), gridLine(vWorld.z, 0.6)) * 0.3;
    float major = max(gridLine(bx, 3.0), gridLine(vWorld.z, 3.0)) * 0.75;
    float g = max(minor, major);

    float lanes = 0.0;
    for (int i = 0; i < 3; i++) lanes = max(lanes, exp(-abs(vWorld.z - uLane[i]) * 16.0));
    float center = exp(-abs(vWorld.z) * 16.0);
    float topup = exp(-abs(vWorld.z - uTopupZ) * 16.0);

    vec3 col = uGrid * g
      + uPink * lanes * 0.5 * (1.0 - uHush)
      + (uCyan * center * 0.45 + uViolet * topup * 0.3) * uHush;
    float fade = smoothstep(0.0, 0.16, vUv.x) * smoothstep(1.0, 0.84, vUv.x) * smoothstep(0.0, 0.3, vUv.y) * smoothstep(1.0, 0.7, vUv.y);
    float a = (g * 0.55 + lanes * 0.35 * (1.0 - uHush) + (center * 0.35 + topup * 0.2) * uHush) * fade;
    gl_FragColor = vec4(col, a);
    ${OUTPUT_CHUNKS}
  }
`;

const markVertex = /* glsl */ `
  uniform float uTime;
  uniform float uHush;
  uniform float uLedgerY;
  uniform float uTapeSpeed;
  uniform float uTapeEnd;
  uniform float uCadence;
  uniform float uLandAt;
  uniform float uRootX;
  uniform float uRootZ;
  uniform float uTopupX;
  uniform float uTopupZ;
  uniform float uTopupEvery;
  attribute float aSlot;
  attribute float aKind;
  varying float vHeat;
  varying float vAlpha;
  varying float vKind;
  varying vec3 vN;

  void main() {
    bool root = aKind < 0.5;
    float period = root ? uCadence : uCadence * uTopupEvery;
    float slots = root ? 8.0 : 4.0;
    float offset = root ? uLandAt * uCadence : 0.4 * uCadence;
    // seconds since this slot's mark landed; slots are staggered by one period, so marks arrive on a metronome
    float age = mod(uTime - offset - aSlot * period, slots * period);
    vec3 origin = vec3((root ? uRootX : uTopupX) - age * uTapeSpeed, uLedgerY, root ? uRootZ : uTopupZ);
    vec3 size = root ? vec3(0.1, 0.55, 0.1) : vec3(0.2, 0.2, 0.2);
    vec3 p = position * size;
    p.y = (position.y + 0.5) * size.y * smoothstep(0.0, 0.3, age); // stand on the chain, grow on landing
    gl_Position = projectionMatrix * modelViewMatrix * vec4(origin + p, 1.0);
    vN = normal;
    vHeat = 1.0 - smoothstep(0.0, 0.9, age);
    vAlpha = uHush * smoothstep(uTapeEnd, uTapeEnd + 1.5, origin.x);
    vKind = aKind;
  }
`;

const markFragment = /* glsl */ `
  uniform vec3 uCyan;
  uniform vec3 uViolet;
  uniform vec3 uAvax;
  varying float vHeat;
  varying float vAlpha;
  varying float vKind;
  varying vec3 vN;

  void main() {
    float light = 0.5 + 0.5 * max(dot(normalize(vN), normalize(vec3(0.3, 1.0, 0.5))), 0.0);
    vec3 col = (vKind < 0.5 ? uCyan : uViolet) * light * 1.3;
    col = mix(col, uAvax * 1.8, vHeat); // AVAX red: the moment a root lands on C-Chain
    if (vAlpha < 0.01) discard;
    gl_FragColor = vec4(col, vAlpha);
    ${OUTPUT_CHUNKS}
  }
`;

const ROOT_SLOTS = 8;
const TOPUP_SLOTS = 4;

export function Ledger() {
  const { gridMaterial, marks, markMaterial } = useMemo(() => {
    const gridMaterial = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        uTapeSpeed: { value: TAPE_SPEED },
        uLane: { value: LANES_Z },
        uTopupZ: { value: TOPUP.z },
        uGrid: { value: COLORS.grid },
        uPink: { value: COLORS.pink },
        uCyan: { value: COLORS.cyan },
        uViolet: { value: COLORS.violet },
      },
      vertexShader: gridVertex,
      fragmentShader: gridFragment,
      transparent: true,
      depthWrite: false,
    });

    const box = new THREE.BoxGeometry(1, 1, 1);
    const marks = new THREE.InstancedBufferGeometry();
    marks.setIndex(box.getIndex());
    marks.setAttribute("position", box.getAttribute("position"));
    marks.setAttribute("normal", box.getAttribute("normal"));
    const slot = new Float32Array(ROOT_SLOTS + TOPUP_SLOTS);
    const kind = new Float32Array(ROOT_SLOTS + TOPUP_SLOTS);
    for (let i = 0; i < ROOT_SLOTS + TOPUP_SLOTS; i++) {
      slot[i] = i < ROOT_SLOTS ? i : i - ROOT_SLOTS;
      kind[i] = i < ROOT_SLOTS ? 0 : 1;
    }
    marks.setAttribute("aSlot", new THREE.InstancedBufferAttribute(slot, 1));
    marks.setAttribute("aKind", new THREE.InstancedBufferAttribute(kind, 1));
    marks.instanceCount = ROOT_SLOTS + TOPUP_SLOTS;

    const markMaterial = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        uLedgerY: { value: LEDGER_Y },
        uTapeSpeed: { value: TAPE_SPEED },
        uTapeEnd: { value: TAPE_END_X },
        uCadence: { value: CADENCE_S },
        uLandAt: { value: ROOT_LAND_AT },
        uRootX: { value: MERKLE.x },
        uRootZ: { value: MERKLE.z },
        uTopupX: { value: TOPUP.x },
        uTopupZ: { value: TOPUP.z },
        uTopupEvery: { value: TOPUP.every },
        uCyan: { value: COLORS.cyan },
        uViolet: { value: COLORS.violet },
        uAvax: { value: COLORS.avax },
      },
      vertexShader: markVertex,
      fragmentShader: markFragment,
      transparent: true,
      depthWrite: false,
    });
    return { gridMaterial, marks, markMaterial };
  }, []);

  useEffect(
    () => () => {
      gridMaterial.dispose();
      marks.dispose();
      markMaterial.dispose();
    },
    [gridMaterial, marks, markMaterial],
  );

  return (
    <>
      <mesh position={[-0.2, LEDGER_Y, 0]} rotation={[-Math.PI / 2, 0, 0]} material={gridMaterial} renderOrder={0}>
        <planeGeometry args={[18, 8, 1, 1]} />
      </mesh>
      <mesh geometry={marks} material={markMaterial} frustumCulled={false} renderOrder={1} />
    </>
  );
}
