"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { AGENT, COLORS, LANES_Z, LEDGER_Y, OUTPUT_CHUNKS, PROVIDERS, TAPE_END_X, mulberry32, shared } from "./layout";

/**
 * Every paid call, as a GPU particle. The whole lifecycle is computed in the vertex shader from a per-particle phase:
 *   public x402: fly to the provider → drop onto the chain → scroll along the public tape as a readable receipt
 *   hush-credit: fly as a signed voucher → absorbed by the provider; nothing reaches the chain
 */
const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uHush;
  uniform float uPixelRatio;
  uniform vec3 uAgent;
  uniform vec3 uProv[3];
  uniform float uLane[3];
  uniform float uLedgerY;
  uniform float uTapeEnd;
  attribute float aPhase;
  attribute float aTarget;
  attribute float aAmount;
  attribute float aSeed;
  varying float vAlpha;
  varying float vHeat;
  varying float vReceipt;

  const float CYCLE = 11.0; // seconds per call lifecycle
  const float ARC = 0.26;   // in flight
  const float FALL = 0.33;  // settling on-chain

  vec3 bezier(vec3 a, vec3 b, vec3 c, float t) {
    float u = 1.0 - t;
    return u * u * a + 2.0 * u * t * b + t * t * c;
  }

  void main() {
    int ti = int(aTarget + 0.5);
    vec3 dest = uProv[ti];
    float lane = uLane[ti] + (aSeed - 0.5) * 0.3;
    float c = fract(uTime / CYCLE + aPhase);
    vec3 pos;
    float alpha;
    float size;
    float heat = 0.0;
    float receipt = 0.0;

    if (c < ARC) {
      float s = c / ARC;
      vec3 ctrl = 0.5 * (uAgent + dest) + vec3(0.0, 1.2 + aSeed * 1.1 + uHush * 0.5, (aSeed - 0.5) * 2.0);
      pos = bezier(uAgent, ctrl, dest, s);
      // behind the veil a call is a signed voucher, not a payment: dimmer, jittery, absorbed by the provider
      pos += uHush * 0.06 * vec3(sin(uTime * 9.0 + aSeed * 40.0), cos(uTime * 7.0 + aSeed * 31.0), sin(uTime * 8.0 + aSeed * 17.0));
      alpha = smoothstep(0.0, 0.08, s) * (1.0 - uHush * smoothstep(0.8, 1.0, s));
      size = mix(0.9 + aAmount, 0.55, uHush);
    } else if (c < FALL) {
      // public x402: the payment settles on-chain right under its payee
      float s = (c - ARC) / (FALL - ARC);
      pos = mix(dest, vec3(dest.x, uLedgerY, lane), s * s);
      alpha = 1.0 - uHush;
      size = 0.8 + aAmount;
      heat = smoothstep(0.7, 1.0, s);
    } else {
      // ...and stays there, readable by anyone, while the chain moves on
      float s = (c - FALL) / (1.0 - FALL);
      pos = vec3(mix(dest.x, uTapeEnd, s), uLedgerY + 0.02, lane);
      alpha = (1.0 - uHush) * (1.0 - smoothstep(0.8, 1.0, s));
      size = 0.55 + aAmount * 2.6;
      heat = 1.0 - smoothstep(0.0, 0.05, s);
      receipt = 1.0;
    }

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = size * 60.0 * uPixelRatio / -mv.z;
    vAlpha = alpha;
    vHeat = heat;
    vReceipt = receipt;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uHush;
  uniform vec3 uPink;
  uniform vec3 uViolet;
  uniform vec3 uAvax;
  uniform vec3 uWhite;
  varying float vAlpha;
  varying float vHeat;
  varying float vReceipt;

  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float d = length(p);
    float orb = smoothstep(0.5, 0.0, d);
    orb *= orb;
    float box = 1.0 - smoothstep(0.32, 0.5, max(abs(p.x), abs(p.y)));
    float shape = mix(orb, box * 0.8, vReceipt);
    vec3 col = mix(uPink, uViolet, uHush);
    col = mix(col, uWhite, smoothstep(0.14, 0.0, d) * (1.0 - vReceipt) * 0.8);
    col = mix(col, uAvax * 1.6, vHeat); // AVAX red marks the on-chain moment
    float a = shape * vAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
    ${OUTPUT_CHUNKS}
  }
`;

export function Packets({ count }: { count: number }) {
  const { geometry, material } = useMemo(() => {
    const rand = mulberry32(7);
    const phase = new Float32Array(count);
    const target = new Float32Array(count);
    const amount = new Float32Array(count);
    const seed = new Float32Array(count);

    // The strategy signature the public tape gives away:
    //   feed.api   — metronomic polling (evenly spaced, tiny amounts)
    //   search.api — sporadic
    //   model.api  — bursts right after price moves, big amounts
    const nFeed = Math.round(count * 0.45);
    const nSearch = Math.round(count * 0.25);
    const bursts = [0.08, 0.31, 0.52, 0.77];
    for (let i = 0; i < count; i++) {
      seed[i] = rand();
      if (i < nFeed) {
        target[i] = 0;
        phase[i] = i / nFeed;
        amount[i] = 0.04;
      } else if (i < nFeed + nSearch) {
        target[i] = 1;
        phase[i] = rand();
        amount[i] = 0.1;
      } else {
        target[i] = 2;
        phase[i] = bursts[i % bursts.length]! + (rand() - 0.5) * 0.035;
        amount[i] = 0.35;
      }
    }

    const g = new THREE.BufferGeometry();
    // three needs a position attribute to know the draw count; real positions come from the shader.
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
    g.setAttribute("aTarget", new THREE.BufferAttribute(target, 1));
    g.setAttribute("aAmount", new THREE.BufferAttribute(amount, 1));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));

    const m = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        uAgent: { value: AGENT },
        uProv: { value: PROVIDERS.map((p) => p.pos) },
        uLane: { value: LANES_Z },
        uLedgerY: { value: LEDGER_Y },
        uTapeEnd: { value: TAPE_END_X },
        uPink: { value: COLORS.pink },
        uViolet: { value: COLORS.violet },
        uAvax: { value: COLORS.avax },
        uWhite: { value: COLORS.ink },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return { geometry: g, material: m };
  }, [count]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  return <points geometry={geometry} material={material} frustumCulled={false} />;
}
