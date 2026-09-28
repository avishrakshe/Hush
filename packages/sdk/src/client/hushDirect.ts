import type { PaymentCreationContext } from "@x402/core/client";
import type { PaymentPayloadResult, PaymentRequirements, SchemeClientHooks, SchemeNetworkClient } from "@x402/core/types";
import { getAddress } from "viem";
import { HUSH_DIRECT } from "../constants.js";
import type { EercAccount } from "../eerc/account.js";
import type { HushDirectExtra, HushDirectPayload } from "../types.js";
import { atomicToEercExact } from "../units.js";
import { type SpendPolicy, assertPolicy } from "./policy.js";
import { type HushStore, MemoryHushStore } from "./store.js";

/**
 * x402 v2 client mechanism for `hush-direct` — REFERENCE ONLY. Every call is its own eERC private transfer, so each
 * call costs a Groth16 proof (~5 s) and an on-chain transaction. Amounts are hidden; frequency is not. hush-credit
 * exists to fix both.
 */
export class HushDirectClient implements SchemeNetworkClient {
  readonly scheme = HUSH_DIRECT;
  readonly schemeHooks: SchemeClientHooks;
  readonly store: HushStore;
  private readonly resources = new WeakMap<object, string>();

  constructor(private readonly opts: { eerc: EercAccount; store?: HushStore; policy?: SpendPolicy }) {
    this.store = opts.store ?? new MemoryHushStore();
    this.schemeHooks = {
      onBeforePaymentCreation: async (ctx: PaymentCreationContext) => {
        this.resources.set(ctx.selectedRequirements, ctx.paymentRequired.resource.url);
      },
    };
  }

  async createPaymentPayload(x402Version: number, req: PaymentRequirements): Promise<PaymentPayloadResult> {
    const extra = req.extra as unknown as HushDirectExtra;
    const provider = getAddress(req.payTo);
    const price = BigInt(req.amount);
    await assertPolicy(this.opts.policy, this.store, provider, price);

    const { txHash } = await this.opts.eerc.transfer(provider, atomicToEercExact(price, extra.eercDecimals));
    await this.store.addPayment({
      id: txHash,
      scheme: HUSH_DIRECT,
      provider,
      amount: price.toString(),
      resource: this.resources.get(req) ?? "",
      at: Date.now(),
    });
    const payload: HushDirectPayload = { txHash };
    return { x402Version, payload: payload as unknown as Record<string, unknown> };
  }
}
