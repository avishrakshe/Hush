"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { COLORS, OUTPUT_CHUNKS, VEIL_Y, shared } from "./layout";

/**
 * The veil: a membrane between the agent's traffic (above) and the public chain (below). It materialises with a sweep
 * when hush mode turns on, carrying a drifting band of ciphertext — the only thing an observer below gets to see.
 */
const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uHush;
  uniform float uProgress;
  uniform vec3 uCyan;
  uniform vec3 uViolet;
  uniform vec3 uPink;
  uniform sampler2D uGlyphs;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }

  void main() {
    vec2 uv = vUv;
    float n = fbm(uv * vec2(5.0, 2.4) + vec2(uTime * 0.05, -uTime * 0.03));
    float n2 = fbm(uv * vec2(13.0, 6.0) - vec2(uTime * 0.07, 0.0) + n * 1.5);
    vec3 col = mix(uViolet, uCyan, smoothstep(0.35, 0.75, n2));
    col = mix(col, uPink, smoothstep(0.7, 0.9, n) * 0.3);

    float glyph = texture2D(uGlyphs, uv * vec2(2.4, 1.6) + vec2(uTime * 0.015, uTime * 0.004)).r;
    float edge = smoothstep(0.0, 0.14, uv.x) * smoothstep(1.0, 0.86, uv.x) * smoothstep(0.0, 0.22, uv.y) * smoothstep(1.0, 0.78, uv.y);

    // the veil sweeps in from the agent's side as hush turns on
    float front = uHush * 1.3 - 0.15;
    float sweep = smoothstep(front + 0.1, front - 0.1, uv.x);
    float rim = exp(-abs(uv.x - front) * 38.0) * smoothstep(0.0, 0.05, uHush) * smoothstep(1.0, 0.95, uHush);

    // thin out over PROOF so the chain below stays readable from the top-down camera
    float vis = 1.0 - 0.55 * smoothstep(2.5, 3.1, uProgress);
    float a = ((0.06 + 0.18 * n2) + glyph * 0.22 * smoothstep(0.35, 0.6, n)) * edge * sweep * vis + rim * edge * 0.7;
    gl_FragColor = vec4(col * (1.0 + rim * 1.5), a);
    ${OUTPUT_CHUNKS}
  }
`;

function glyphTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const g = canvas.getContext("2d");
  if (g) {
    const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-jetbrains-mono").trim() || "monospace";
    g.fillStyle = "#000";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.font = `500 19px ${mono}, ui-monospace, monospace`;
    const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[(Math.random() * 16) | 0]).join("");
    for (let row = 0; row < 16; row++) {
      for (let col = 0; col < 5; col++) {
        g.fillStyle = `rgba(255,255,255,${(0.25 + Math.random() * 0.75).toFixed(2)})`;
        g.fillText(`0x${hex(14)}`, col * 210 + (row % 2) * 60 - 30, 26 + row * 32);
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

export function Veil() {
  const { material, texture } = useMemo(() => {
    const texture = glyphTexture();
    const material = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        uCyan: { value: COLORS.cyan },
        uViolet: { value: COLORS.violet },
        uPink: { value: COLORS.pink },
        uGlyphs: { value: texture },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    return { material, texture };
  }, []);

  useEffect(
    () => () => {
      material.dispose();
      texture.dispose();
    },
    [material, texture],
  );

  return (
    <mesh position={[0.3, VEIL_Y, -0.2]} rotation={[-Math.PI / 2, 0, 0]} material={material} renderOrder={2}>
      <planeGeometry args={[14.5, 6, 1, 1]} />
    </mesh>
  );
}
