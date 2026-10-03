import { toClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { type Network, type SchemeNetworkClient, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { type Address, type PublicClient, getAddress } from "viem";
import { EXACT, FUJI_CHAIN_ID, HUSH_CREDIT, HUSH_DIRECT, HUSH_RFQ, type HushMode, toCaip2 } from "../constants.js";
import type { TypedDataSigner } from "../eip712.js";
import type { EercAccount } from "../eerc/account.js";
import { type HushClientEvent, HushCreditClient } from "./hushCredit.js";
import { HushDirectClient } from "./hushDirect.js";
import { HushRfqClient, type TradePolicy } from "./hushRfq.js";
import { type SpendPolicy, assertPolicy, toX402Policy } from "./policy.js";
import type { PrivacyOptions } from "./privacy.js";
import { type HushStore, MemoryHushStore } from "./store.js";

export interface HushFetchOptions {
  /** Preferred scheme: "public" (x402 exact), "hush-credit" (the product) or "hush-direct" (reference). */
  mode: HushMode;
  /** The agent's EOA (a viem LocalAccount works): signs vouchers / EIP-3009 authorizations. */
  wallet: TypedDataSigner;
  /** The agent's eERC account. Required for hush-credit and hush-direct. */
  eercClient?: EercAccount;
  /** Chain reads (voucher verification, exact-scheme reads). */
  publicClient?: PublicClient;
  /** CAIP-2 network. Defaults to the eERC account's chain, else the public client's chain, else Fuji. */
  network?: Network;
  policy?: SpendPolicy;
  /** v2: guard rails for trades at a Hush Desk (hush-rfq). Separate from `policy`, which caps API spend. */
  tradePolicy?: TradePolicy;
  privacy?: PrivacyOptions;
  store?: HushStore;
  onEvent?: (event: HushClientEvent) => void;
  /**
   * Pay with another offered scheme if the preferred one isn't offered. Default false: a private agent must never
   * silently downgrade to a public payment.
   */
  allowFallback?: boolean;
  fetch?: typeof fetch;
}

export interface HushFetch {
  /** Drop-in fetch that pays 402s according to the options. */
  fetch: typeof fetch;
  client: x402Client;
  /** Present when an eERC account was supplied: refunds, credit state, voucher verification. */
  credit?: HushCreditClient;
  /** v2: present with an eERC account — pays Hush Desk quotes (use HushDeskClient for buy/sell/positions). */
  rfq?: HushRfqClient;
  store: HushStore;
}

/**
 * Which offered scheme each mode pays with, in order. A private agent pays a data API with hush-credit and a desk quote
 * with hush-rfq (both vouchers against prepaid encrypted credit) — and never falls back to a public payment.
 */
const MODE_PREFERENCE: Record<HushMode, string[]> = {
  public: [EXACT],
  [HUSH_CREDIT]: [HUSH_CREDIT, HUSH_RFQ],
  [HUSH_DIRECT]: [HUSH_DIRECT],
};

/** Builds a paying fetch for an agent. Reuse the returned object — it holds the per-provider voucher state. */
export function createHushFetch(opts: HushFetchOptions): HushFetch {
  const store = opts.store ?? new MemoryHushStore();
  const network =
    opts.network ?? toCaip2(opts.eercClient?.contracts.chainId ?? opts.publicClient?.chain?.id ?? FUJI_CHAIN_ID);
  const schemes: { network: Network; client: SchemeNetworkClient }[] = [
    { network, client: new ExactEvmScheme(toClientEvmSigner(opts.wallet, opts.publicClient)) },
  ];

  let credit: HushCreditClient | undefined;
  let rfq: HushRfqClient | undefined;
  if (opts.eercClient) {
    credit = new HushCreditClient({
      signer: opts.wallet,
      eerc: opts.eercClient,
      publicClient: opts.publicClient,
      store,
      policy: opts.policy,
      privacy: opts.privacy,
      onEvent: opts.onEvent,
      fetch: opts.fetch,
    });
    rfq = new HushRfqClient({ signer: opts.wallet, credit, store, policy: opts.tradePolicy, onEvent: opts.onEvent });
    schemes.push({ network, client: credit });
    schemes.push({ network, client: new HushDirectClient({ eerc: opts.eercClient, store, policy: opts.policy }) });
    schemes.push({ network, client: rfq });
  } else if (opts.mode !== "public") {
    throw new Error(`mode "${opts.mode}" needs an eercClient`);
  }

  const preferred = MODE_PREFERENCE[opts.mode];
  const client = x402Client.fromConfig({
    schemes,
    // x402's built-in spend controls only recognise its default assets; SpendPolicy (below + in each scheme) is
    // the guard for every Hush scheme instead.
    spendControls: false,
    policies: [toX402Policy(opts.policy)],
    paymentRequirementsSelector: (_version, reqs) => {
      for (const scheme of preferred) {
        const match = reqs.find((r) => r.scheme === scheme && r.network === network);
        if (match) return match;
      }
      if (!opts.allowFallback || reqs.length === 0) {
        throw new Error(`server does not offer "${preferred.join('" or "')}" on ${network} (offered: ${reqs.map((r) => r.scheme).join(", ") || "none"})`);
      }
      return reqs[0]!;
    },
  });

  // hush schemes enforce policy and record payments themselves; do the same for the public `exact` scheme.
  client.onBeforePaymentCreation(async (ctx) => {
    const r = ctx.selectedRequirements;
    if (r.scheme === EXACT) await assertPolicy(opts.policy, store, getAddress(r.payTo) as Address, BigInt(r.amount));
  });
  client.onAfterPaymentCreation(async (ctx) => {
    const r = ctx.selectedRequirements;
    if (r.scheme !== EXACT) return;
    const auth = (ctx.paymentPayload.payload as { authorization?: { nonce?: string } }).authorization;
    await store.addPayment({
      id: auth?.nonce ?? `${Date.now()}`,
      scheme: EXACT,
      provider: getAddress(r.payTo),
      amount: r.amount,
      resource: ctx.paymentRequired.resource.url,
      at: Date.now(),
    });
  });

  return { fetch: wrapFetchWithPayment(opts.fetch ?? globalThis.fetch, client), client, credit, rfq, store };
}

/** One-shot convenience: `hushFetch(url, { mode, wallet, eercClient, policy, privacy })`. Prefer createHushFetch for agents. */
export async function hushFetch(url: string | URL, opts: HushFetchOptions & { init?: RequestInit }): Promise<Response> {
  return createHushFetch(opts).fetch(url, opts.init);
}
