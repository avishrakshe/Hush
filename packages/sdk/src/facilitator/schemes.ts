import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { HUSH_CREDIT, HUSH_DIRECT, HUSH_RFQ } from "../constants.js";
import type { HushCreditPayload, HushDirectPayload, RfqSettleExtra } from "../types.js";
import type { HushDeskService } from "./desk.js";
import type { HushProviderService } from "./service.js";

const resourceUrl = (p: PaymentPayload) => (p as { resource?: { url?: string } }).resource?.url;

/** x402 v2 facilitator mechanism for `hush-credit` (voucher verification + settlement into the next batch). */
export class HushCreditFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = HUSH_CREDIT;
  readonly caipFamily = "eip155:*";

  constructor(private readonly service: HushProviderService) {}

  getExtra(_network: Network) {
    return { provider: this.service.provider, hushLedger: this.service.contracts.hushLedger };
  }

  getSigners(_network: string) {
    return [this.service.provider];
  }

  async verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    const r = await this.service.verifyVoucher(payload.payload as unknown as HushCreditPayload, req, resourceUrl(payload));
    return r.ok
      ? { isValid: true, payer: r.voucher.agent }
      : { isValid: false, invalidReason: r.code, invalidMessage: r.message, payer: r.agent };
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    const r = await this.service.settleVoucher(payload.payload as unknown as HushCreditPayload, req, resourceUrl(payload));
    if (!r.ok) {
      return { success: false, errorReason: r.code, errorMessage: r.message, payer: r.agent, transaction: "", network: req.network };
    }
    // batch-settlement semantics: value moves later (next Merkle batch), so `transaction` is the commitment id.
    return {
      success: true,
      transaction: r.leaf,
      network: req.network,
      payer: r.credit.agent,
      amount: r.increment.toString(),
      extra: {
        voucherLeaf: r.leaf,
        cumulativeSpent: r.credit.settledCumulative.toString(),
        available: this.service.toJson(r.credit).available,
      },
    };
  }
}

/**
 * x402 v2 facilitator mechanism for `hush-rfq` (the Hush Desk). verify: the desk-signed quote in the requirements is live
 * and the voucher pays exactly its notional, bound to the quote digest. settle: voucher consumed + position booked
 * atomically; the signed FillReceipt and PositionStatement travel back to the agent in PAYMENT-RESPONSE.
 */
export class HushRfqFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = HUSH_RFQ;
  readonly caipFamily = "eip155:*";

  constructor(private readonly desk: HushDeskService) {}

  getExtra(_network: Network) {
    return { provider: this.desk.desk, hushAlpha: this.desk.domain.verifyingContract };
  }

  getSigners(_network: string) {
    return [this.desk.desk];
  }

  async verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    const r = await this.desk.verifyRfq(payload.payload as unknown as HushCreditPayload, req);
    return r.ok
      ? { isValid: true, payer: r.voucher.agent }
      : { isValid: false, invalidReason: r.code, invalidMessage: r.message, payer: r.agent };
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    const r = await this.desk.settleRfq(payload.payload as unknown as HushCreditPayload, req);
    if (!r.ok) {
      return { success: false, errorReason: r.code, errorMessage: r.message, payer: r.agent, transaction: "", network: req.network };
    }
    const extra: RfqSettleExtra = {
      voucherLeaf: r.leaf,
      fill: r.fill,
      statement: r.statement,
      available: (r.credit.creditedTotal + r.credit.proceedsTotal - r.credit.refundedTotal - r.credit.settledCumulative).toString(),
    };
    // Like hush-credit: no on-chain transfer per trade, so `transaction` is the voucher's Merkle leaf.
    return { success: true, transaction: r.leaf, network: req.network, payer: r.credit.agent, amount: r.quote.notional.toString(), extra: { ...extra } };
  }
}

/** x402 v2 facilitator mechanism for `hush-direct` (reference: one decrypted eERC transfer per call). */
export class HushDirectFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = HUSH_DIRECT;
  readonly caipFamily = "eip155:*";

  constructor(private readonly service: HushProviderService) {}

  getExtra(_network: Network) {
    return { provider: this.service.provider };
  }

  getSigners(_network: string) {
    return [this.service.provider];
  }

  async verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    const r = await this.service.verifyDirect((payload.payload as unknown as HushDirectPayload).txHash, req);
    return r.ok ? { isValid: true, payer: r.agent } : { isValid: false, invalidReason: r.code, invalidMessage: r.message, payer: r.agent };
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    const { txHash } = payload.payload as unknown as HushDirectPayload;
    const r = await this.service.settleDirect(txHash, req, resourceUrl(payload));
    return r.ok
      ? { success: true, transaction: txHash, network: req.network, payer: r.agent, amount: r.amount.toString() }
      : { success: false, errorReason: r.code, errorMessage: r.message, payer: r.agent, transaction: "", network: req.network };
  }
}
