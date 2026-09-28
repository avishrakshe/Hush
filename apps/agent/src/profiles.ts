import type { Role } from "@hush/config";
import type { HushMode } from "@hush/x402";

export interface AgentProfile {
  id: "atlas" | "veil";
  name: string;
  role: Role;
  /** How it pays: Atlas uses public x402 `exact`, Veil uses hush-credit. Same code, same goal. */
  mode: HushMode;
  port: number;
  tagline: string;
}

export const PROFILES: Record<AgentProfile["id"], AgentProfile> = {
  atlas: {
    id: "atlas",
    name: "Atlas",
    role: "ATLAS",
    mode: "public",
    port: Number(process.env.ATLAS_PORT || 4031),
    tagline: "pays with public x402 — every purchase, amount and cadence is visible on-chain",
  },
  veil: {
    id: "veil",
    name: "Veil",
    role: "VEIL",
    mode: "hush-credit",
    port: Number(process.env.VEIL_PORT || 4032),
    tagline: "pays with Hush — encrypted top-ups and off-chain vouchers; only its owner (and the auditor) can see the details",
  },
};

export function profileFromArgs(argv = process.argv): AgentProfile {
  const i = argv.indexOf("--agent");
  const id = (i >= 0 ? argv[i + 1] : process.env.HUSH_AGENT)?.toLowerCase();
  if (id !== "atlas" && id !== "veil") throw new Error("pass --agent atlas|veil");
  return PROFILES[id];
}
