import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import type { PaymentRequirements } from "@x402/core/types";
import {
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type TypedDataDomain,
  type WalletClient,
  getAddress,
  isAddressEqual,
  keccak256,
  toHex,
} from "viem";
import {
  CREDIT_QUERY_MAX_AGE_SECONDS,
  DEFAULT_CREDIT_TTL_SECONDS,
  HUSH_CREDIT,
  LEAF_TYPES,
  REFUND_MEMO,
  TOPUP_MEMO_PREFIX,
  VOUCHER_TYPES,
} from "../constants.js";
import {
  type TypedDataSigner,
  hushDomain,
  receiptToJson,
  recoverCreditQuerySigner,
  recoverRefundRequestSigner,
  refundRequestFromJson,
  requestHashFor,
  signCreditReceipt,
  verifyTypedSignature,
  voucherFromJson,
} from "../eip712.js";
import type { EercAccount } from "../eerc/account.js";
import { encryptedErcAbi, hushLedgerAbi, hushRegistryAbi } from "../generated/abis.js";
import { voucherLeaf, voucherLeafValues } from "../merkle.js";
import type {
  CreditStateJson,
  HushContracts,
  HushCreditPayload,
  RefundRequestJson,
  RefundResponse,
  TopUpResponse,
  Voucher,
} from "../types.js";
import { atomicToEerc, eercToAtomic } from "../units.js";
import type { CreditRecord, CreditStore, SettledVoucherRecord } from "./store.js";

/** Error with a stable machine-readable code and HTTP status, surfaced by the facilitator API. */
export class HushError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "HushError";
  }
}

export type FacilitatorEvent =
  | { type: "topup"; agent: Address; payer: Address; txHash: Hex; amount: bigint; creditedTotal: bigint }
  | { type: "call"; agent: Address; leaf: Hex; amount: bigint; cumulativeSpent: bigint; resource: string }
  | { type: "call:rejected"; agent: Address; reason: string; message: string }
  | { type: "batch"; batchId: bigint; root: Hex; txHash: Hex; voucherCount: number; dummy: boolean }
  | { type: "refund"; agent: Address; amount: bigint; txHash: Hex | null; reason: "requested" | "expired" }
  | { type: "direct"; agent: Address; txHash: Hex; amount: bigint };

export interface HushProviderServiceOptions {
  contracts: HushContracts;
  publicClient: PublicClient;
  /** The provider wallet (== payTo). Signs CreditReceipts, so receipts are provider-accountable. */
  providerSigner: TypedDataSigner;
  /** The same wallet's eERC account: decrypts incoming top-ups and sends refunds. */
  providerEerc: EercAccount;
  store: CreditStore;
  /** Gas key authorised via HushRegistry.setFacilitator to commit batches (may be the provider itself). */
  committer?: WalletClient<Transport, Chain, Account>;
  creditTtlSeconds?: number;
  /** Only serve agents registered in HushRegistry (so the owner kill switch always applies). Default true. */
  requireRegisteredAgent?: boolean;
  /** Maximum age of a hush-direct payment transaction. Default 10 minutes. */
  directMaxAgeSeconds?: number;
  now?: () => number;
  onEvent?: (e: FacilitatorEvent) => void;
}

type VerifyResult =
  | { ok: true; voucher: Voucher; increment: bigint; credit: CreditRecord }
  | { ok: false; code: string; message: string; agent?: Address };

/**
 * The provider-side brain of hush-credit: decrypts top-ups, issues signed receipts, verifies and settles vouchers,
 * refunds unused or expired credit privately, and commits voucher batches to HushLedger.
 *
 * Trust model (see README): the provider holds prepaid credit. Mitigations: provider-signed receipts, on-chain
 * Merkle commitments the agent can verify, private refunds, automatic expiry refunds, and public flagging.
 */
export class HushProviderService {
  readonly provider: Address;
  readonly contracts: HushContracts;
  private readonly opts: HushProviderServiceOptions;
  private readonly domain: TypedDataDomain;
  private readonly locks = new Map<string, Promise<unknown>>();
  private tokenIdCache: bigint | undefined;
  private committing = false;

  constructor(opts: HushProviderServiceOptions) {
    this.opts = opts;
    this.contracts = opts.contracts;
    this.provider = getAddress(opts.providerSigner.address);
    if (!isAddressEqual(this.provider, opts.providerEerc.address)) {
      throw new Error("providerSigner and providerEerc must be the same wallet");
    }
    this.domain = hushDomain(opts.contracts.chainId, opts.contracts.hushLedger);
  }

  get store() {
    return this.opts.store;
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private get ttlMs() {
    return (this.opts.creditTtlSeconds ?? DEFAULT_CREDIT_TTL_SECONDS) * 1000;
  }

  // ───────────────────────────── credit ─────────────────────────────

  /** Unauthenticated read — for the facilitator's own use. HTTP callers must go through `authorizedCreditState`. */
  async creditState(agent: Address): Promise<CreditStateJson> {
    const [credit, frozen] = await Promise.all([this.opts.store.getCredit(getAddress(agent), this.provider), this.isFrozen(agent)]);
    return this.toJson(credit, frozen);
  }

  /**
   * Credit for `agent`, only for the agent itself or its registered owner. `auth` is the CREDIT_AUTH_HEADER value,
   * `<issuedAt>.<signature>` over a CreditQuery. Without this check, polling an agent's `settledCumulative` would
   * reveal every call it makes and what it spends.
   */
  async authorizedCreditState(agent: Address, auth: string | undefined): Promise<CreditStateJson> {
    const [issuedAtRaw, signature] = (auth ?? "").split(".");
    if (!issuedAtRaw || !/^\d+$/.test(issuedAtRaw) || !signature?.startsWith("0x")) {
      throw new HushError("unauthorized", "credit queries must be signed by the agent or its owner", 401);
    }
    const issuedAt = BigInt(issuedAtRaw);
    const age = Math.floor(this.now() / 1000) - Number(issuedAt);
    if (age > CREDIT_QUERY_MAX_AGE_SECONDS || age < -60) throw new HushError("expired_request", "credit query expired or from the future", 401);

    const query = { agent: getAddress(agent), provider: this.provider, issuedAt };
    const signer = await recoverCreditQuerySigner(this.domain, query, signature as Hex).catch(() => undefined);
    const owner = signer && !isAddressEqual(signer, query.agent) ? await this.agentOwner(query.agent) : undefined;
    if (!signer || !(isAddressEqual(signer, query.agent) || (owner && isAddressEqual(owner, signer)))) {
      throw new HushError("unauthorized", "credit queries must be signed by the agent or its owner", 401);
    }
    return this.creditState(query.agent);
  }

  toJson(c: CreditRecord, frozen = false): CreditStateJson {
    return {
      agent: c.agent,
      provider: c.provider,
      creditedTotal: c.creditedTotal.toString(),
      refundedTotal: c.refundedTotal.toString(),
      settledCumulative: c.settledCumulative.toString(),
      available: available(c).toString(),
      lastNonce: c.lastNonce.toString(),
      lastTopUpAt: c.lastTopUpAt,
      expiresAt: c.lastTopUpAt === null ? null : c.lastTopUpAt + this.ttlMs,
      frozen,
    };
  }

  // ───────────────────────────── top-ups ─────────────────────────────

  /**
   * Decrypts a private top-up straight from calldata (receiver PCT, constrained by the transfer circuit), credits
   * the beneficiary and returns a provider-signed CreditReceipt. The encrypted memo lets an owner's treasury pay
   * for one of its agents — accepted only if HushRegistry says the payer owns that agent.
   */
  async processTopUp(claimedAgent: Address | undefined, txHash: Hex): Promise<TopUpResponse> {
    if (await this.opts.store.hasTopUp(txHash)) throw new HushError("duplicate_topup", "top-up already credited", 409);
    if (await this.opts.store.hasDirectPayment(txHash)) throw new HushError("duplicate_topup", "transaction already used as a direct payment", 409);

    let incoming: Awaited<ReturnType<EercAccount["decryptIncoming"]>>;
    try {
      incoming = await this.opts.providerEerc.decryptIncoming(txHash);
    } catch (err) {
      throw new HushError("invalid_topup", (err as Error).message);
    }
    const { transfer, units, memo } = incoming;
    if (transfer.tokenId !== (await this.tokenId())) throw new HushError("invalid_topup", "top-up is not hUSDC");
    const amount = eercToAtomic(units, this.contracts.eercDecimals);
    if (amount === 0n) throw new HushError("invalid_topup", "zero-amount top-up");

    const payer = getAddress(transfer.from);
    let beneficiary = payer;
    if (memo?.startsWith(TOPUP_MEMO_PREFIX)) {
      const target = getAddress(memo.slice(TOPUP_MEMO_PREFIX.length));
      if (!isAddressEqual(target, payer)) {
        const owner = await this.agentOwner(target);
        if (!owner || !isAddressEqual(owner, payer)) {
          throw new HushError("unauthorized_payer", `${payer} is not the registered owner of agent ${target}`, 403);
        }
      }
      beneficiary = target;
    }
    if (claimedAgent && !isAddressEqual(claimedAgent, beneficiary)) {
      throw new HushError("agent_mismatch", `top-up credits ${beneficiary}, not ${claimedAgent}`);
    }

    return this.withLock(beneficiary, async () => {
      if (await this.opts.store.hasTopUp(txHash)) throw new HushError("duplicate_topup", "top-up already credited", 409);
      const credit = await this.opts.store.getCredit(beneficiary, this.provider);
      const now = this.now();
      const updated: CreditRecord = { ...credit, creditedTotal: credit.creditedTotal + amount, lastTopUpAt: now };
      const receipt = {
        agent: beneficiary,
        provider: this.provider,
        creditedTotal: updated.creditedTotal,
        topupTxHash: txHash,
        issuedAt: BigInt(Math.floor(now / 1000)),
      };
      const signature = await signCreditReceipt(this.opts.providerSigner, this.domain, receipt);

      await this.opts.store.addTopUp({
        txHash,
        agent: beneficiary,
        provider: this.provider,
        payer,
        amount,
        blockNumber: transfer.blockNumber,
        receipt: receiptToJson(receipt),
        signature,
        createdAt: now,
      });
      await this.opts.store.putCredit(updated);
      this.emit({ type: "topup", agent: beneficiary, payer, txHash, amount, creditedTotal: updated.creditedTotal });
      return { receipt: receiptToJson(receipt), signature, credit: this.toJson(updated), amount: amount.toString(), payer };
    });
  }

  // ───────────────────────────── vouchers ─────────────────────────────

  /** All checks for a hush-credit voucher. Pure read — settle() re-runs it under the agent lock. */
  async verifyVoucher(payload: HushCreditPayload, req: PaymentRequirements, resourceUrl?: string): Promise<VerifyResult> {
    let voucher: Voucher;
    try {
      voucher = voucherFromJson(payload.voucher);
    } catch {
      return { ok: false, code: "invalid_payload", message: "malformed voucher" };
    }
    const agent = getAddress(voucher.agent);
    const fail = (code: string, message: string): VerifyResult => ({ ok: false, code, message, agent });

    if (req.scheme !== HUSH_CREDIT) return fail("unsupported_scheme", `expected ${HUSH_CREDIT}`);
    if (!isAddressEqual(voucher.provider, this.provider) || !isAddressEqual(req.payTo as Address, this.provider)) {
      return fail("wrong_provider", "voucher is not for this provider");
    }
    if (resourceUrl && voucher.requestHash !== requestHashFor(resourceUrl)) {
      return fail("request_mismatch", "voucher requestHash does not match the requested resource");
    }
    if (voucher.expiry * 1000n < BigInt(this.now())) return fail("voucher_expired", "voucher expired");

    const sigOk = await verifyTypedSignature(this.opts.publicClient, {
      address: agent,
      domain: this.domain,
      types: VOUCHER_TYPES,
      primaryType: "Voucher",
      message: { ...voucher },
      signature: payload.signature,
    });
    if (!sigOk) return fail("invalid_signature", "voucher not signed by the agent");

    const credit = await this.opts.store.getCredit(agent, this.provider);
    if (voucher.nonce <= credit.lastNonce) return fail("stale_nonce", `nonce ${voucher.nonce} ≤ last settled ${credit.lastNonce}`);
    const increment = voucher.cumulativeSpent - credit.settledCumulative;
    if (increment < BigInt(req.amount)) return fail("underpaid", `voucher adds ${increment}, price is ${req.amount}`);
    if (voucher.cumulativeSpent > credit.creditedTotal - credit.refundedTotal) {
      return fail("insufficient_credit", "top up first: voucher exceeds prepaid credit");
    }
    if (credit.lastTopUpAt !== null && this.now() > credit.lastTopUpAt + this.ttlMs) {
      return fail("credit_expired", "credit expired — it will be refunded");
    }
    if ((this.opts.requireRegisteredAgent ?? true) && !(await this.isAgent(agent))) {
      return fail("agent_not_registered", "agent is not registered in HushRegistry");
    }
    // Read on every call — never cached — so the owner's kill switch takes effect on the very next request.
    if (await this.isFrozen(agent)) return fail("agent_frozen", "agent frozen by its owner");

    return { ok: true, voucher, increment, credit };
  }

  /** Records a verified voucher as consumed. It lands in the next Merkle batch committed to HushLedger. */
  async settleVoucher(payload: HushCreditPayload, req: PaymentRequirements, resourceUrl?: string) {
    const agent = getAddress(payload.voucher.agent);
    return this.withLock(agent, async () => {
      const v = await this.verifyVoucher(payload, req, resourceUrl);
      if (!v.ok) {
        this.emit({ type: "call:rejected", agent, reason: v.code, message: v.message });
        return v;
      }
      const leaf = voucherLeaf({ voucher: v.voucher, signature: payload.signature });
      const updated: CreditRecord = { ...v.credit, settledCumulative: v.voucher.cumulativeSpent, lastNonce: v.voucher.nonce };
      const record: SettledVoucherRecord = {
        leaf,
        agent,
        provider: this.provider,
        voucher: payload.voucher,
        signature: payload.signature,
        amount: v.increment,
        resource: resourceUrl ?? "",
        settledAt: this.now(),
        batchId: null,
        proof: null,
      };
      await this.opts.store.addSettledVoucher(record);
      await this.opts.store.putCredit(updated);
      this.emit({ type: "call", agent, leaf, amount: v.increment, cumulativeSpent: v.voucher.cumulativeSpent, resource: record.resource });
      return { ok: true as const, leaf, increment: v.increment, credit: updated };
    });
  }

  // ───────────────────────────── hush-direct ─────────────────────────────

  async verifyDirect(txHash: Hex, req: PaymentRequirements) {
    if ((await this.opts.store.hasDirectPayment(txHash)) || (await this.opts.store.hasTopUp(txHash))) {
      return { ok: false as const, code: "duplicate_payment", message: "transaction already used" };
    }
    let incoming: Awaited<ReturnType<EercAccount["decryptIncoming"]>>;
    try {
      incoming = await this.opts.providerEerc.decryptIncoming(txHash);
    } catch (err) {
      return { ok: false as const, code: "invalid_payment", message: (err as Error).message };
    }
    const agent = getAddress(incoming.transfer.from);
    const amount = eercToAtomic(incoming.units, this.contracts.eercDecimals);
    if (amount < BigInt(req.amount)) return { ok: false as const, code: "underpaid", message: `paid ${amount}, price ${req.amount}`, agent };
    const block = await this.opts.publicClient.getBlock({ blockNumber: incoming.transfer.blockNumber });
    const maxAge = BigInt(this.opts.directMaxAgeSeconds ?? 600);
    if (BigInt(Math.floor(this.now() / 1000)) - block.timestamp > maxAge) {
      return { ok: false as const, code: "payment_too_old", message: "payment transaction is too old", agent };
    }
    if (await this.isFrozen(agent)) return { ok: false as const, code: "agent_frozen", message: "agent frozen by its owner", agent };
    return { ok: true as const, agent, amount };
  }

  async settleDirect(txHash: Hex, req: PaymentRequirements, resourceUrl?: string) {
    return this.withLock(`direct:${txHash}`, async () => {
      const v = await this.verifyDirect(txHash, req);
      if (!v.ok) return v;
      await this.opts.store.addDirectPayment({
        txHash,
        agent: v.agent,
        provider: this.provider,
        amount: v.amount,
        resource: resourceUrl ?? "",
        settledAt: this.now(),
      });
      this.emit({ type: "direct", agent: v.agent, txHash, amount: v.amount });
      return v;
    });
  }

  // ───────────────────────────── refunds ─────────────────────────────

  /** Agent (or its registered owner) asks for unspent credit back. Returned via a private eERC transfer. */
  async requestRefund(requestJson: RefundRequestJson, signature: Hex): Promise<RefundResponse> {
    const request = refundRequestFromJson(requestJson);
    if (!isAddressEqual(request.provider, this.provider)) throw new HushError("wrong_provider", "refund request is for another provider");
    if (request.deadline * 1000n < BigInt(this.now())) throw new HushError("expired_request", "refund request expired");
    const signer = await recoverRefundRequestSigner(this.domain, request, signature).catch(() => undefined);
    const owner = signer && !isAddressEqual(signer, request.agent) ? await this.agentOwner(request.agent) : undefined;
    if (!signer || !(isAddressEqual(signer, request.agent) || (owner && isAddressEqual(owner, signer)))) {
      throw new HushError("invalid_signature", "refund must be signed by the agent or its owner", 401);
    }
    return this.refundAgent(getAddress(request.agent), "requested");
  }

  /** Returns all refundable credit (floored to whole eERC units) to the agent via a private transfer. */
  async refundAgent(agent: Address, reason: "requested" | "expired"): Promise<RefundResponse> {
    return this.withLock(agent, async () => {
      const credit = await this.opts.store.getCredit(agent, this.provider);
      const units = atomicToEerc(available(credit), this.contracts.eercDecimals);
      const amount = eercToAtomic(units, this.contracts.eercDecimals);
      if (units === 0n) return { txHash: null, amount: "0", credit: this.toJson(credit) };

      // Reserve before proving (~5 s), so no voucher can spend credit that is already on its way back.
      const reserved: CreditRecord = { ...credit, refundedTotal: credit.refundedTotal + amount };
      await this.opts.store.putCredit(reserved);
      const id = `${agent}-${this.now()}`;
      try {
        const { txHash } = await this.opts.providerEerc.transfer(agent, units, REFUND_MEMO);
        await this.opts.store.addRefund({ id, agent, provider: this.provider, amount, txHash, reason, status: "sent", createdAt: this.now() });
        this.emit({ type: "refund", agent, amount, txHash, reason });
        return { txHash, amount: amount.toString(), credit: this.toJson(reserved) };
      } catch (err) {
        await this.opts.store.putCredit(credit);
        await this.opts.store.addRefund({ id, agent, provider: this.provider, amount, txHash: null, reason, status: "failed", createdAt: this.now() });
        throw new HushError("refund_failed", (err as Error).message, 502);
      }
    });
  }

  /** Refunds every credit whose last top-up is older than the credit TTL. Run periodically. */
  async expireCredits(): Promise<RefundResponse[]> {
    const out: RefundResponse[] = [];
    for (const c of await this.opts.store.listCredits(this.provider)) {
      if (c.lastTopUpAt === null || this.now() <= c.lastTopUpAt + this.ttlMs) continue;
      if (atomicToEerc(available(c), this.contracts.eercDecimals) === 0n) continue;
      out.push(await this.refundAgent(c.agent, "expired"));
    }
    return out;
  }

  // ───────────────────────────── batches ─────────────────────────────

  /**
   * Merkle-izes every consumed-but-uncommitted voucher and commits the root to HushLedger. With nothing to commit it
   * still commits a random root (indistinguishable from a real one), so commit timing reveals no activity.
   */
  async commitBatch(): Promise<{ batchId: bigint; root: Hex; txHash: Hex; voucherCount: number; dummy: boolean } | null> {
    const committer = this.opts.committer;
    if (!committer) throw new Error("commitBatch needs a `committer` wallet");
    if (this.committing) return null;
    this.committing = true;
    try {
      const vouchers = await this.opts.store.listUnbatchedVouchers(this.provider);
      const latest = await this.opts.publicClient.readContract({
        address: this.contracts.hushLedger,
        abi: hushLedgerAbi,
        functionName: "latestBatchId",
        args: [this.provider],
      });
      const batchId = latest + 1n;

      const proofs = new Map<string, Hex[]>();
      let root: Hex;
      if (vouchers.length === 0) {
        root = keccak256(toHex(globalThis.crypto.getRandomValues(new Uint8Array(32))));
      } else {
        const values = vouchers.map((v) =>
          voucherLeafValues({ voucher: voucherFromJson(v.voucher), signature: v.signature }).map((x) =>
            typeof x === "bigint" ? x.toString() : x,
          ),
        );
        const tree = StandardMerkleTree.of(values, [...LEAF_TYPES]);
        root = tree.root as Hex;
        for (const [i, v] of vouchers.entries()) proofs.set(v.leaf.toLowerCase(), tree.getProof(i) as Hex[]);
      }

      const txHash = await committer.writeContract({
        address: this.contracts.hushLedger,
        abi: hushLedgerAbi,
        functionName: "commitBatch",
        args: [this.provider, batchId, root],
      });
      const receipt = await this.opts.publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new Error(`commitBatch reverted: ${txHash}`);

      const dummy = vouchers.length === 0;
      await this.opts.store.addBatch(
        { provider: this.provider, batchId, root, txHash, voucherCount: vouchers.length, dummy, committedAt: this.now() },
        proofs,
      );
      this.emit({ type: "batch", batchId, root, txHash, voucherCount: vouchers.length, dummy });
      return { batchId, root, txHash, voucherCount: vouchers.length, dummy };
    } finally {
      this.committing = false;
    }
  }

  async proofFor(leaf: Hex) {
    const v = await this.opts.store.getVoucher(leaf);
    if (!v || v.batchId === null || !v.proof) return undefined;
    const batch = await this.opts.store.getBatch(this.provider, v.batchId);
    if (!batch) return undefined;
    return { leaf: v.leaf, provider: this.provider, batchId: v.batchId.toString(), root: batch.root, proof: v.proof, commitTx: batch.txHash };
  }

  /** Unspent incoming eERC transfers on the provider account (eERC caps this at 300). */
  async pendingIncoming(): Promise<number> {
    return (await this.opts.providerEerc.balance()).pendingIncoming;
  }

  // ───────────────────────────── registry reads ─────────────────────────────

  async isFrozen(agent: Address): Promise<boolean> {
    return this.opts.publicClient.readContract({
      address: this.contracts.hushRegistry,
      abi: hushRegistryAbi,
      functionName: "isFrozen",
      args: [getAddress(agent)],
    });
  }

  private readonly knownAgents = new Set<string>();
  async isAgent(agent: Address): Promise<boolean> {
    if (this.knownAgents.has(agent.toLowerCase())) return true;
    const ok = await this.opts.publicClient.readContract({
      address: this.contracts.hushRegistry,
      abi: hushRegistryAbi,
      functionName: "isAgent",
      args: [getAddress(agent)],
    });
    if (ok) this.knownAgents.add(agent.toLowerCase());
    return ok;
  }

  async agentOwner(agent: Address): Promise<Address | undefined> {
    const a = await this.opts.publicClient.readContract({
      address: this.contracts.hushRegistry,
      abi: hushRegistryAbi,
      functionName: "getAgent",
      args: [getAddress(agent)],
    });
    return a.registeredAt === 0n ? undefined : a.owner;
  }

  private async tokenId(): Promise<bigint> {
    this.tokenIdCache ??= await this.opts.publicClient.readContract({
      address: this.contracts.encryptedErc,
      abi: encryptedErcAbi,
      functionName: "tokenIds",
      args: [this.contracts.usdc],
    });
    return this.tokenIdCache;
  }

  /** Serializes all credit mutations per key (agent), so read-check-write sequences are atomic. */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const k = key.toLowerCase();
    const prev = this.locks.get(k) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(k, tail);
    void tail.then(() => {
      if (this.locks.get(k) === tail) this.locks.delete(k);
    });
    return run;
  }

  private emit(e: FacilitatorEvent) {
    try {
      this.opts.onEvent?.(e);
    } catch {
      // listeners never break payments
    }
  }
}

export const available = (c: CreditRecord) => c.creditedTotal - c.refundedTotal - c.settledCumulative;
