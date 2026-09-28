import type { PaymentCreationContext, PaymentResponseContext } from "@x402/core/client";
import type { PaymentPayloadResult, PaymentRequirements, SchemeClientHooks, SchemeNetworkClient } from "@x402/core/types";
import { type Address, type Hex, type PublicClient, getAddress, isAddressEqual } from "viem";
import { DEFAULT_VOUCHER_TTL_SECONDS, HUSH_CREDIT, TOPUP_MEMO_PREFIX } from "../constants.js";
import {
  type TypedDataSigner,
  hushDomain,
  isValidCreditReceipt,
  receiptFromJson,
  refundRequestToJson,
  requestHashFor,
  signRefundRequest,
  signVoucher,
  voucherFromJson,
  voucherToJson,
} from "../eip712.js";
import type { EercAccount } from "../eerc/account.js";
import { hushLedgerAbi } from "../generated/abis.js";
import { verifyMerkleProof, voucherLeaf } from "../merkle.js";
import type { CreditStateJson, HushCreditExtra, HushCreditPayload, RefundResponse, SignedCreditReceipt } from "../types.js";
import { atomicToEercExact, eercToAtomic } from "../units.js";
import { HushFacilitatorApi } from "./facilitatorApi.js";
import { type SpendPolicy, assertPolicy } from "./policy.js";
import { type PrivacyOptions, pickTopUpChunk, randomDelay, resolvePrivacy } from "./privacy.js";
import { type HushStore, MemoryHushStore, type StoredVoucher } from "./store.js";

export type HushClientEvent =
  | { type: "topup:start"; provider: Address; amount: bigint; reason: "needed" | "preemptive" }
  | { type: "topup:credited"; provider: Address; amount: bigint; txHash: Hex; receipt: SignedCreditReceipt; payer: Address }
  | { type: "voucher:signed"; provider: Address; amount: bigint; cumulativeSpent: bigint; nonce: bigint; leaf: Hex }
  | { type: "voucher:settled"; provider: Address; leaf: Hex }
  | { type: "voucher:rejected"; provider: Address; leaf: Hex; reason: string }
  | { type: "refund"; provider: Address; amount: bigint; txHash: Hex | null }
  | { type: "receipt:mismatch"; provider: Address; expected: bigint; receipt: SignedCreditReceipt }
  | { type: "error"; error: Error };

export interface HushCreditClientOptions {
  /** The agent's EOA: signs vouchers and refund requests (e.g. viem `privateKeyToAccount`). */
  signer: TypedDataSigner;
  /** The agent's eERC account: sends private top-ups and decrypts refunds. */
  eerc: EercAccount;
  /** Needed for `verifyMyVouchers()` (reads HushLedger). */
  publicClient?: Pick<PublicClient, "readContract">;
  store?: HushStore;
  policy?: SpendPolicy;
  privacy?: PrivacyOptions;
  voucherTtlSeconds?: number;
  fetch?: typeof fetch;
  onEvent?: (event: HushClientEvent) => void;
}

interface ProviderConfig {
  extra: HushCreditExtra;
  chainId: number;
}

const chainIdOf = (network: string) => Number(network.split(":")[1]);

/**
 * x402 v2 client mechanism for `hush-credit`.
 *
 * Per paid call: sync credit with the provider's facilitator → top up privately if needed (one eERC transfer +
 * provider-signed CreditReceipt) → sign a cumulative EIP-712 voucher. No on-chain transaction per call.
 */
export class HushCreditClient implements SchemeNetworkClient {
  readonly scheme = HUSH_CREDIT;
  readonly schemeHooks: SchemeClientHooks;
  readonly store: HushStore;
  readonly agent: Address;

  private readonly opts: HushCreditClientOptions;
  private readonly privacy: ReturnType<typeof resolvePrivacy>;
  private readonly providers = new Map<string, ProviderConfig>();
  /** Resource URL per selected-requirements object — x402 passes the same object to hooks and to createPaymentPayload. */
  private readonly resources = new WeakMap<object, string>();
  /** Lock release per returned payload, fired from onPaymentResponse once the paid request completes. */
  private readonly releases = new WeakMap<object, () => void>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastReceipt = new Map<string, SignedCreditReceipt>();

  constructor(opts: HushCreditClientOptions) {
    this.opts = opts;
    this.agent = getAddress(opts.signer.address);
    this.store = opts.store ?? new MemoryHushStore();
    this.privacy = resolvePrivacy(opts.privacy);
    this.schemeHooks = {
      onBeforePaymentCreation: async (ctx: PaymentCreationContext) => {
        this.resources.set(ctx.selectedRequirements, ctx.paymentRequired.resource.url);
      },
      onPaymentResponse: async (ctx: PaymentResponseContext) => {
        await this.onPaymentResponse(ctx);
      },
    };
  }

  // ───────────────────────────── x402 SchemeNetworkClient ─────────────────────────────

  async createPaymentPayload(x402Version: number, req: PaymentRequirements): Promise<PaymentPayloadResult> {
    const extra = parseCreditExtra(req.extra);
    const provider = getAddress(req.payTo);
    const price = BigInt(req.amount);
    const chainId = chainIdOf(req.network);
    this.providers.set(provider.toLowerCase(), { extra, chainId });

    const resource = this.resources.get(req);
    if (!resource) throw new Error("hush-credit: missing request context — pay through x402Client / hushFetch");

    // Policy is enforced before anything is signed or sent.
    await assertPolicy(this.opts.policy, this.store, provider, price);

    // Held until the paid request completes, so concurrent calls to one provider never sign the same nonce.
    const release = await this.acquire(provider);
    try {
      const api = this.api(extra);
      let credit = await api.credit(this.agent, provider);
      if (credit.frozen) throw new Error("agent is frozen by its owner (HushRegistry kill switch)");

      if (BigInt(credit.available) < price) {
        credit = await this.topUp(provider, { extra, chainId }, price - BigInt(credit.available), "needed");
      }

      const voucher = {
        agent: this.agent,
        provider,
        cumulativeSpent: BigInt(credit.settledCumulative) + price,
        nonce: BigInt(credit.lastNonce) + 1n,
        requestHash: requestHashFor(resource),
        expiry: BigInt(Math.floor(Date.now() / 1000) + (this.opts.voucherTtlSeconds ?? DEFAULT_VOUCHER_TTL_SECONDS)),
      };
      const signature = await signVoucher(this.opts.signer, hushDomain(chainId, extra.hushLedger), voucher);
      const leaf = voucherLeaf({ voucher, signature });
      const now = Date.now();

      await this.store.addVoucher({
        leaf,
        voucher: voucherToJson(voucher),
        signature,
        resource,
        amount: price.toString(),
        status: "signed",
        createdAt: now,
      });
      await this.store.addPayment({ id: leaf, scheme: HUSH_CREDIT, provider, amount: price.toString(), resource, at: now });
      this.emit({ type: "voucher:signed", provider, amount: price, cumulativeSpent: voucher.cumulativeSpent, nonce: voucher.nonce, leaf });

      this.maybeSchedulePreemptiveTopUp(provider, { extra, chainId }, BigInt(credit.available) - price);

      const payload: HushCreditPayload = { voucher: voucherToJson(voucher), signature };
      this.releases.set(payload, release);
      return { x402Version, payload: payload as unknown as Record<string, unknown> };
    } catch (err) {
      release();
      throw err;
    }
  }

  // ───────────────────────────── public API ─────────────────────────────

  /** Current credit with a provider as the facilitator sees it (USDC atomic units). */
  async creditState(provider: Address): Promise<CreditStateJson> {
    return this.api((await this.config(provider)).extra).credit(this.agent, provider);
  }

  /** Top up proactively (e.g. at startup) instead of on the first call. */
  async prefund(provider: Address, amount?: bigint): Promise<CreditStateJson> {
    const cfg = await this.config(provider);
    const release = await this.acquire(provider);
    try {
      return await this.topUp(provider, cfg, amount ?? this.privacy.chunks[0]!, "preemptive");
    } finally {
      release();
    }
  }

  /** Ask the provider to privately return all unspent credit. Verifies the refund by decrypting it. */
  async requestRefund(provider: Address): Promise<RefundResponse> {
    const { extra, chainId } = await this.config(provider);
    const release = await this.acquire(provider);
    try {
      const request = { agent: this.agent, provider: getAddress(provider), deadline: BigInt(Math.floor(Date.now() / 1000) + 300) };
      const signature = await signRefundRequest(this.opts.signer, hushDomain(chainId, extra.hushLedger), request);
      const res = await this.api(extra).refund(refundRequestToJson(request), signature);
      if (res.txHash) {
        const { units } = await this.opts.eerc.decryptIncoming(res.txHash);
        if (eercToAtomic(units, extra.eercDecimals) !== BigInt(res.amount)) {
          throw new Error(`refund mismatch: facilitator reported ${res.amount}, decrypted ${eercToAtomic(units, extra.eercDecimals)}`);
        }
      }
      await this.store.addRefund({ provider, txHash: res.txHash, amount: res.amount, createdAt: Date.now() });
      this.emit({ type: "refund", provider, amount: BigInt(res.amount), txHash: res.txHash });
      return res;
    } finally {
      release();
    }
  }

  /**
   * Checks every settled voucher against the Merkle roots the provider committed to HushLedger. A provider that
   * charged for a voucher but never committed it (or committed something else) shows up in `failed`.
   */
  async verifyMyVouchers(): Promise<{ verified: number; pending: number; failed: StoredVoucher[] }> {
    const publicClient = this.opts.publicClient;
    if (!publicClient) throw new Error("verifyMyVouchers needs `publicClient`");
    let verified = 0;
    let pending = 0;
    const failed: StoredVoucher[] = [];

    for (const v of await this.store.listVouchers()) {
      if (v.status !== "settled" || v.verifiedOnChain) continue;
      const cfg = await this.config(v.voucher.provider).catch(() => undefined);
      if (!cfg) {
        pending++;
        continue;
      }
      const proof = await this.api(cfg.extra).proof(v.leaf);
      if (!proof) {
        pending++;
        continue;
      }
      const localOk = verifyMerkleProof(proof.root, v.leaf, proof.proof);
      const onchainOk = await publicClient.readContract({
        address: cfg.extra.hushLedger,
        abi: hushLedgerAbi,
        functionName: "verifyVoucherInclusion",
        args: [BigInt(proof.batchId), voucherFromJson(v.voucher), v.signature, proof.proof],
      });
      if (localOk && onchainOk) {
        verified++;
        await this.store.updateVoucher(v.leaf, { verifiedOnChain: true, batchId: proof.batchId });
      } else {
        failed.push(v);
      }
    }
    return { verified, pending, failed };
  }

  /** Stops pending pre-emptive top-up timers (call on shutdown). */
  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // ───────────────────────────── internals ─────────────────────────────

  /** One private eERC transfer to the provider, then a provider-signed CreditReceipt. Caller holds the lock. */
  private async topUp(provider: Address, cfg: ProviderConfig, needed: bigint, reason: "needed" | "preemptive"): Promise<CreditStateJson> {
    const { extra, chainId } = cfg;
    const chunk = pickTopUpChunk(needed, BigInt(extra.minTopUp), this.privacy.chunks);
    const units = atomicToEercExact(chunk, extra.eercDecimals);
    this.emit({ type: "topup:start", provider, amount: chunk, reason });

    // The memo is eERC encrypted metadata: only the provider can read which agent to credit.
    const { txHash } = await this.opts.eerc.transfer(provider, units, `${TOPUP_MEMO_PREFIX}${this.agent.toLowerCase()}`);
    const res = await this.api(extra).topUp(this.agent, txHash);

    const receipt = receiptFromJson(res.receipt);
    const signed: SignedCreditReceipt = { receipt, signature: res.signature };
    const domain = hushDomain(chainId, extra.hushLedger);
    if (!(await isValidCreditReceipt(domain, receipt, res.signature)) || !isAddressEqual(receipt.provider, provider)) {
      throw new Error("facilitator returned a CreditReceipt not signed by the provider");
    }
    if (!isAddressEqual(receipt.agent, this.agent) || receipt.topupTxHash.toLowerCase() !== txHash.toLowerCase()) {
      throw new Error("CreditReceipt does not match this top-up");
    }
    // Accountability: creditedTotal must grow by exactly what we sent. A shortfall is signed evidence for flagProvider.
    const prev = this.lastReceipt.get(provider.toLowerCase())?.receipt.creditedTotal;
    if (prev !== undefined && receipt.creditedTotal !== prev + chunk) {
      this.emit({ type: "receipt:mismatch", provider, expected: prev + chunk, receipt: signed });
    }
    this.lastReceipt.set(provider.toLowerCase(), signed);
    await this.store.addReceipt({
      receipt: res.receipt,
      signature: res.signature,
      amount: res.amount,
      payer: res.payer,
      createdAt: Date.now(),
      terms: { extra, chainId },
    });
    this.emit({ type: "topup:credited", provider, amount: BigInt(res.amount), txHash, receipt: signed, payer: res.payer });
    return res.credit;
  }

  /**
   * When credit runs low, top up after a random delay instead of at the moment a call needs it — so on-chain top-up
   * timing doesn't line up with bursts of API calls.
   */
  private maybeSchedulePreemptiveTopUp(provider: Address, cfg: ProviderConfig, remaining: bigint) {
    const [min, max] = this.privacy.jitterMs;
    if (max <= 0) return;
    const smallest = this.privacy.chunks[0]!;
    const threshold = (smallest * BigInt(Math.round(this.privacy.lowWatermark * 1000))) / 1000n;
    const key = provider.toLowerCase();
    if (remaining >= threshold || this.timers.has(key)) return;

    const timer = setTimeout(async () => {
      this.timers.delete(key);
      const release = await this.acquire(provider);
      try {
        const credit = await this.api(cfg.extra).credit(this.agent, provider);
        if (BigInt(credit.available) < threshold && !credit.frozen) await this.topUp(provider, cfg, smallest, "preemptive");
      } catch (err) {
        this.emit({ type: "error", error: err as Error });
      } finally {
        release();
      }
    }, randomDelay([min, max]));
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(key, timer);
  }

  private async onPaymentResponse(ctx: PaymentResponseContext) {
    const payload = ctx.paymentPayload.payload as unknown as HushCreditPayload;
    const release = this.releases.get(payload);
    try {
      if (!payload?.voucher) return;
      const leaf = voucherLeaf({ voucher: voucherFromJson(payload.voucher), signature: payload.signature });
      const provider = getAddress(payload.voucher.provider);
      if (ctx.settleResponse?.success) {
        await this.store.updateVoucher(leaf, { status: "settled" });
        this.emit({ type: "voucher:settled", provider, leaf });
      } else {
        const reason = ctx.settleResponse?.errorReason ?? ctx.error?.message ?? "payment rejected";
        await this.store.updateVoucher(leaf, { status: "rejected" });
        this.emit({ type: "voucher:rejected", provider, leaf, reason });
      }
    } finally {
      release?.();
    }
  }

  /** Per-provider mutex with a safety timeout (in case a request dies without a payment response). */
  private async acquire(provider: Address): Promise<() => void> {
    const key = provider.toLowerCase();
    const prev = this.locks.get(key) ?? Promise.resolve();
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const tail = prev.then(() => gate);
    this.locks.set(key, tail);
    await prev;
    let released = false;
    const safety = setTimeout(() => release(), 120_000);
    (safety as { unref?: () => void }).unref?.();
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(safety);
      open();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    };
    return release;
  }

  /** Terms from this session, else from the newest stored receipt (e.g. after a restart). */
  private async config(provider: Address): Promise<ProviderConfig> {
    const key = provider.toLowerCase();
    const cached = this.providers.get(key);
    if (cached) return cached;
    const stored = (await this.store.listReceipts())
      .filter((r) => r.terms && r.receipt.provider.toLowerCase() === key)
      .sort((a, b) => b.createdAt - a.createdAt)[0]?.terms;
    if (!stored) throw new Error(`no hush-credit terms known for provider ${provider} — make one paid call first`);
    this.providers.set(key, stored);
    return stored;
  }

  /** Providers this agent has hush-credit terms for (this session or stored receipts). */
  async knownProviders(): Promise<Address[]> {
    const fromStore = (await this.store.listReceipts()).filter((r) => r.terms).map((r) => r.receipt.provider.toLowerCase());
    return [...new Set([...this.providers.keys(), ...fromStore])].map((p) => getAddress(p));
  }

  private api(extra: HushCreditExtra) {
    return new HushFacilitatorApi(extra.facilitatorUrl, this.opts.fetch);
  }

  private emit(event: HushClientEvent) {
    try {
      this.opts.onEvent?.(event);
    } catch {
      // listeners must never break payments
    }
  }
}

export function parseCreditExtra(extra: Record<string, unknown> | undefined): HushCreditExtra {
  const e = (extra ?? {}) as Partial<HushCreditExtra>;
  for (const k of ["facilitatorUrl", "encryptedErc", "hushLedger", "hushRegistry", "minTopUp"] as const) {
    if (!e[k]) throw new Error(`hush-credit requirements missing extra.${k}`);
  }
  if (typeof e.eercDecimals !== "number") throw new Error("hush-credit requirements missing extra.eercDecimals");
  return e as HushCreditExtra;
}
