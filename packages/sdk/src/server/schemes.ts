import type {
  AssetAmount,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import { DEFAULT_CREDIT_TTL_SECONDS, HUSH_CREDIT, HUSH_DIRECT, USDC_DECIMALS } from "../constants.js";
import type { HushContracts, HushCreditExtra, HushDirectExtra } from "../types.js";

/** Resolves "$0.02" / 0.02 / {amount, asset} into USDC atomic units on the Hush deployment's token. */
function usdcPrice(price: Price, contracts: HushContracts): AssetAmount {
  if (typeof price === "object" && price !== null && "amount" in price) {
    return { amount: price.amount, asset: price.asset ?? contracts.usdc, extra: price.extra ?? {} };
  }
  const { amount } = parseMoney(price);
  return { amount: convertToTokenAmount(amount, USDC_DECIMALS), asset: contracts.usdc, extra: {} };
}

// Hush schemes have no on-wire asset-transfer method; "default" is the SDK plumbing value core expects then.
// "authorization" = verify before the handler, settle after it succeeds, so a failed handler never charges.
const PAYMENT_FLOWS = {
  default: { supported: ["authorization"], default: "authorization" },
} as const satisfies Record<string, PaymentFlowConfig>;

export interface HushCreditServerOptions {
  contracts: HushContracts;
  /** Public URL of the provider's Hush facilitator (agents top up and fetch proofs there). */
  facilitatorUrl: string;
  /** Smallest accepted top-up, USDC atomic. Default 1 USDC. */
  minTopUp?: bigint;
  creditTtlSeconds?: number;
}

/** x402 v2 resource-server mechanism for `hush-credit`: advertises the terms agents need to top up and pay. */
export class HushCreditServerScheme implements SchemeNetworkServer {
  readonly scheme = HUSH_CREDIT;
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = PAYMENT_FLOWS;

  constructor(private readonly opts: HushCreditServerOptions) {}

  async parsePrice(price: Price, _network: Network): Promise<AssetAmount> {
    return usdcPrice(price, this.opts.contracts);
  }

  getAssetDecimals(): number {
    return USDC_DECIMALS;
  }

  async enhancePaymentRequirements(req: PaymentRequirements, _kind: SupportedKind, _ext: string[]): Promise<PaymentRequirements> {
    const c = this.opts.contracts;
    const extra: HushCreditExtra = {
      facilitatorUrl: this.opts.facilitatorUrl,
      encryptedErc: c.encryptedErc,
      hushLedger: c.hushLedger,
      hushRegistry: c.hushRegistry,
      eercDecimals: c.eercDecimals,
      minTopUp: (this.opts.minTopUp ?? 1_000_000n).toString(),
      creditTtlSeconds: this.opts.creditTtlSeconds ?? DEFAULT_CREDIT_TTL_SECONDS,
    };
    return { ...req, extra: { ...req.extra, ...extra } };
  }
}

/** x402 v2 resource-server mechanism for `hush-direct` (reference scheme). */
export class HushDirectServerScheme implements SchemeNetworkServer {
  readonly scheme = HUSH_DIRECT;
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = PAYMENT_FLOWS;

  constructor(private readonly opts: { contracts: HushContracts }) {}

  async parsePrice(price: Price, _network: Network): Promise<AssetAmount> {
    return usdcPrice(price, this.opts.contracts);
  }

  getAssetDecimals(): number {
    return USDC_DECIMALS;
  }

  async enhancePaymentRequirements(req: PaymentRequirements, _kind: SupportedKind, _ext: string[]): Promise<PaymentRequirements> {
    const extra: HushDirectExtra = { encryptedErc: this.opts.contracts.encryptedErc, eercDecimals: this.opts.contracts.eercDecimals };
    return { ...req, extra: { ...req.extra, ...extra } };
  }
}
