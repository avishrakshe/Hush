import { toClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { type Network, type SchemeNetworkClient, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { type Address, type PublicClient, getAddress } from "viem";
import { EXACT, FUJI_CHAIN_ID, type HushMode, MODE_SCHEME, toCaip2 } from "../constants.js";
import type { TypedDataSigner } from "../eip712.js";
import type { EercAccount } from "../eerc/account.js";
import { type HushClientEvent, HushCreditClient } from "./hushCredit.js";
import { HushDirectClient } from "./hushDirect.js";
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
  store: HushStore;
}

/** Builds a paying fetch for an agent. Reuse the returned object — it holds the per-provider voucher state. */
export function createHushFetch(opts: HushFetchOptions): HushFetch {
  const store = opts.store ?? new MemoryHushStore();
  const network =
    opts.network ?? toCaip2(opts.eercClient?.contracts.chainId ?? opts.publicClient?.chain?.id ?? FUJI_CHAIN_ID);
  const schemes: { network: Network; client: SchemeNetworkClient }[] = [
    { network, client: new ExactEvmScheme(toClientEvmSigner(opts.wallet, opts.publicClient)) },
  ];

  let credit: HushCreditClient | undefined;
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
    schemes.push({ network, client: credit });
    schemes.push({ network, client: new HushDirectClient({ eerc: opts.eercClient, store, policy: opts.policy }) });
  } else if (opts.mode !== "public") {
    throw new Error(`mode "${opts.mode}" needs an eercClient`);
  }

  const preferred = MODE_SCHEME[opts.mode];
  const client = x402Client.fromConfig({
    schemes,
    // x402's built-in spend controls only recognise its default assets; SpendPolicy (below + in each scheme) is
    // the guard for every Hush scheme instead.
    spendControls: false,
    policies: [toX402Policy(opts.policy)],
    paymentRequirementsSelector: (_version, reqs) => {
      const match = reqs.find((r) => r.scheme === preferred && r.network === network);
      if (match) return match;
      if (!opts.allowFallback || reqs.length === 0) {
        throw new Error(`server does not offer "${preferred}" on ${network} (offered: ${reqs.map((r) => r.scheme).join(", ") || "none"})`);
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

  return { fetch: wrapFetchWithPayment(opts.fetch ?? globalThis.fetch, client), client, credit, store };
}

/** One-shot convenience: `hushFetch(url, { mode, wallet, eercClient, policy, privacy })`. Prefer createHushFetch for agents. */
export async function hushFetch(url: string | URL, opts: HushFetchOptions & { init?: RequestInit }): Promise<Response> {
  return createHushFetch(opts).fetch(url, opts.init);
}
