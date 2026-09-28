import type { PaymentRequirements } from "@x402/core/types";
import { type Address, isAddressEqual } from "viem";
import { formatUsdc } from "../units.js";
import type { HushStore } from "./store.js";

/** Owner-set guard rails, enforced before the agent signs or sends anything. Amounts in USDC atomic units. */
export interface SpendPolicy {
  /** Reject any single call priced above this. */
  maxPerCall?: bigint;
  /** Reject calls once this much has been spent in the current UTC day (all schemes combined). */
  dailyCap?: bigint;
  /** Only pay these providers (payTo addresses). */
  allowedProviders?: Address[];
}

export class PolicyViolation extends Error {
  constructor(readonly reason: "provider_not_allowed" | "over_per_call_max" | "over_daily_cap", message: string) {
    super(message);
    this.name = "PolicyViolation";
  }
}

const startOfUtcDay = (now = Date.now()) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

export async function spentToday(store: HushStore, now = Date.now()): Promise<bigint> {
  const since = startOfUtcDay(now);
  return (await store.listPayments()).filter((p) => p.at >= since).reduce((sum, p) => sum + BigInt(p.amount), 0n);
}

/** Throws PolicyViolation if paying `amount` to `provider` now would break the policy. */
export async function assertPolicy(policy: SpendPolicy | undefined, store: HushStore, provider: Address, amount: bigint) {
  if (!policy) return;
  if (policy.allowedProviders && !policy.allowedProviders.some((p) => isAddressEqual(p, provider))) {
    throw new PolicyViolation("provider_not_allowed", `provider ${provider} is not on the allowlist`);
  }
  if (policy.maxPerCall !== undefined && amount > policy.maxPerCall) {
    throw new PolicyViolation("over_per_call_max", `price ${formatUsdc(amount)} exceeds per-call max ${formatUsdc(policy.maxPerCall)}`);
  }
  if (policy.dailyCap !== undefined) {
    const spent = await spentToday(store);
    if (spent + amount > policy.dailyCap) {
      throw new PolicyViolation("over_daily_cap", `daily cap ${formatUsdc(policy.dailyCap)} reached (spent ${formatUsdc(spent)})`);
    }
  }
}

/** The static parts of the policy as an x402 PaymentPolicy, so disallowed offers are filtered out up front. */
export function toX402Policy(policy: SpendPolicy | undefined) {
  return (_version: number, reqs: PaymentRequirements[]) =>
    reqs.filter(
      (r) =>
        (!policy?.allowedProviders || policy.allowedProviders.some((p) => isAddressEqual(p, r.payTo as Address))) &&
        (policy?.maxPerCall === undefined || BigInt(r.amount) <= policy.maxPerCall),
    );
}
