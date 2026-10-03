import type { wallet } from "@hush/config";
import type { EercAccount, HushContracts } from "@hush/x402";
import type { HushFetch, HushStore, SpendPolicy } from "@hush/x402/client";
import type { AgentProfile } from "./profiles.js";
import type { Telemetry } from "./telemetry.js";

/** Everything a strategy needs; built once in index.ts. */
export interface AgentContext {
  profile: AgentProfile;
  contracts: HushContracts;
  me: ReturnType<typeof wallet>;
  /** Veil only. */
  eerc?: EercAccount;
  telemetry: Telemetry;
  store: HushStore;
  policy: SpendPolicy & { dailyCap: bigint };
  hush: HushFetch;
  log: (msg: string) => void;
  maxTicks: number;
  intervalMs: number;
  running: () => boolean;
}
