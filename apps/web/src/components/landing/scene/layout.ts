import { Color, Vector3 } from "three";
import { AGENT_XYZ, PROVIDER_DEFS } from "./coords";

/** World layout. The traffic (agent → providers) lives above the veil; the public chain is the plane below it. */
export const AGENT = new Vector3(...AGENT_XYZ);
export const PROVIDERS = PROVIDER_DEFS.map((p) => ({ ...p, pos: new Vector3(...p.xyz) }));

export const LEDGER_Y = -2.2;
export const VEIL_Y = -1.45;
/** One lane per provider on the public tape (public x402 sorts itself by payee). */
export const LANES_Z = [-1.1, 0, 1.1];
export const TAPE_END_X = -7.6;
/** How fast recorded marks scroll away as blocks are produced. */
export const TAPE_SPEED = 0.45;

/** Scene-time batch cadence. The real facilitator commits every 120 s; 4 s keeps the loop watchable. */
export const CADENCE_S = 4;
/** Fraction of a batch cycle at which the root lands on the chain (Merkle.tsx and Ledger.tsx must agree). */
export const ROOT_LAND_AT = 0.86;
export const MERKLE = { x: 5.7, z: 0, leafY: 0.25, levelGap: 0.36 };
/** Encrypted top-ups land under the providers, on their own lane. */
export const TOPUP = { x: 3.5, z: -1.0, every: 3.25 };

export const COLORS = {
  cyan: new Color("#22E6FF"),
  violet: new Color("#8B5CF6"),
  pink: new Color("#FF3DA8"),
  avax: new Color("#E84142"),
  ink: new Color("#E9ECF5"),
  grid: new Color("#46507A"),
};

/**
 * Uniform objects shared by every scene material. One `useFrame` (Scene.tsx) writes them; each ShaderMaterial holds
 * references, so a single update drives the whole scene without React re-renders.
 */
export const shared = {
  uTime: { value: 0 },
  /** 0 = public x402, 1 = behind the veil (eased). */
  uHush: { value: 0 },
  /** Scroll position in chapters, 0 → 4 (eased). */
  uProgress: { value: 0 },
  uPixelRatio: { value: 1 },
};

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Deterministic PRNG so the scene looks the same on every visit. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard three.js output chunks: without them a ShaderMaterial skips colour-space conversion (and looks different with and without the bloom composer). */
export const OUTPUT_CHUNKS = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;
