/**
 * Raw scene coordinates, kept free of three.js imports: the page-level label layer reads them without pulling three
 * into the initial bundle (the scene itself is lazy-loaded).
 */
export type XYZ = readonly [number, number, number];

export const AGENT_XYZ: XYZ = [-3.6, 0.5, 0];
export const PROVIDER_DEFS = [
  { xyz: [3.3, 1.45, -0.9] as XYZ, name: "feed.api", price: "0.010" },
  { xyz: [3.8, 0.35, 0.35] as XYZ, name: "search.api", price: "0.020" },
  { xyz: [3.15, -0.7, -0.25] as XYZ, name: "model.api", price: "0.250" },
] as const;

/** DOM labels pinned to scene points. Rendered by SceneLabels (page DOM), positioned per frame by LabelProjector. */
export const LABELS: { id: string; at: XYZ; anchor: "below" | "right" }[] = [
  { id: "agent", at: [AGENT_XYZ[0], AGENT_XYZ[1] - 0.95, AGENT_XYZ[2]], anchor: "below" },
  ...PROVIDER_DEFS.map((p, i) => ({ id: `provider-${i}`, at: [p.xyz[0], p.xyz[1] - 0.4, p.xyz[2]] as XYZ, anchor: "below" as const })),
];

export const labelEls = new Map<string, HTMLElement>();
