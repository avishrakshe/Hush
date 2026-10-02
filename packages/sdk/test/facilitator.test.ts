import type { PaymentRequirements } from "@x402/core/types";
import { type Address, type Hex, keccak256, stringToBytes, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CREDIT_QUERY_MAX_AGE_SECONDS,
  type HushContracts,
  creditAuthHeader,
  hushDomain,
  isValidCreditReceipt,
  receiptFromJson,
  refundRequestToJson,
  requestHashFor,
  signRefundRequest,
  signVoucher,
  verifyMerkleProof,
  voucherToJson,
} from "../src/index.js";
import { HushProviderService, MemoryCreditStore } from "../src/facilitator/index.js";
import type { EercAccount } from "../src/eerc/account.js";

// Well-known Hardhat test keys — never use outside tests.
const agent = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const provider = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const owner = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const stranger = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");

const contracts: HushContracts = {
  chainId: 43113,
  eercDecimals: 2,
  startBlock: 1,
  encryptedErc: "0x9Aa48Af8C613e8fEA7Ef8c8BB859A0a8C52F2396",
  registrar: "0x9F674A79fcEc3B472A35895ab6a4FA870200B34b",
  usdc: "0x77a5b64985b910652826183213d12bf3dc2DeCF7",
  hushRegistry: "0x8CdEaaF16304a6E03002b90a6029b8E79e221ef6",
  hushLedger: "0x1D6ee5d0AA41f191A361C4306EbCc9E2Aa387577",
};
const domain = hushDomain(contracts.chainId, contracts.hushLedger);
const RESOURCE = "http://localhost:4021/api/feed";
const PRICE = 20_000n; // $0.02
const req = {
  scheme: "hush-credit",
  network: "eip155:43113",
  asset: contracts.usdc,
  amount: PRICE.toString(),
  payTo: provider.address,
  maxTimeoutSeconds: 60,
  extra: {},
} as PaymentRequirements;
const txHash = (s: string) => keccak256(stringToBytes(s));

/** Minimal chain: HushRegistry state + HushLedger batch ids + signature verification. */
function fakeChain() {
  const state = {
    frozen: new Set<string>(),
    agents: new Map<string, Address>([[agent.address.toLowerCase(), owner.address]]),
    latestBatchId: 0n,
    commits: [] as { batchId: bigint; root: Hex }[],
  };
  const publicClient = {
    async readContract({ functionName, args }: { functionName: string; args: readonly unknown[] }) {
      const a = String(args?.[0] ?? "").toLowerCase();
      switch (functionName) {
        case "isFrozen":
          return state.frozen.has(a);
        case "isAgent":
          return state.agents.has(a);
        case "getAgent": {
          const o = state.agents.get(a);
          return { owner: o ?? "0x0000000000000000000000000000000000000000", metadataURI: "", frozen: false, registeredAt: o ? 1n : 0n };
        }
        case "tokenIds":
          return 1n;
        case "latestBatchId":
          return state.latestBatchId;
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
    verifyTypedData: (args: Parameters<typeof verifyTypedData>[0]) => verifyTypedData(args),
    async waitForTransactionReceipt() {
      return { status: "success" };
    },
    async getBlock() {
      return { timestamp: BigInt(Math.floor(Date.now() / 1000)) };
    },
  };
  const committer = {
    async writeContract({ args }: { args: readonly unknown[] }) {
      const [, batchId, root] = args as [Address, bigint, Hex];
      state.latestBatchId = batchId;
      state.commits.push({ batchId, root });
      return txHash(`commit-${batchId}`);
    },
  };
  return { state, publicClient, committer };
}

/** Stand-in for the provider's eERC account: "decrypts" pre-registered transfers and records refunds. */
function fakeEerc() {
  const incoming = new Map<string, { from: Address; units: bigint; memo?: string }>();
  const sent: { to: Address; units: bigint; memo?: string }[] = [];
  const eerc = {
    address: provider.address,
    async decryptIncoming(hash: Hex) {
      const t = incoming.get(hash);
      if (!t) throw new Error("not an eERC transfer to the provider");
      return { transfer: { txHash: hash, from: t.from, to: provider.address, tokenId: 1n, blockNumber: 10n, publicSignals: [], logs: [] }, units: t.units, memo: t.memo };
    },
    async transfer(to: Address, units: bigint, memo?: string) {
      sent.push({ to, units, memo });
      return { txHash: txHash(`refund-${sent.length}`), blockNumber: 11n };
    },
  };
  return { eerc: eerc as unknown as EercAccount, incoming, sent };
}

function setup(now = { t: Date.now() }) {
  const chain = fakeChain();
  const e = fakeEerc();
  const store = new MemoryCreditStore();
  const service = new HushProviderService({
    contracts,
    publicClient: chain.publicClient as never,
    providerSigner: provider,
    providerEerc: e.eerc,
    store,
    committer: chain.committer as never,
    creditTtlSeconds: 3600,
    now: () => now.t,
  });
  return { ...chain, ...e, store, service, now };
}

async function signed(n: bigint, cumulative: bigint, overrides: Partial<Parameters<typeof signVoucher>[2]> = {}, signer = agent) {
  const v = {
    agent: agent.address,
    provider: provider.address,
    cumulativeSpent: cumulative,
    nonce: n,
    requestHash: requestHashFor(RESOURCE),
    expiry: BigInt(Math.floor(Date.now() / 1000) + 300),
    ...overrides,
  };
  return { voucher: voucherToJson(v), signature: await signVoucher(signer, domain, v) };
}

describe("HushProviderService — top-ups & receipts", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it("credits a decrypted top-up and returns a provider-signed receipt", async () => {
    s.incoming.set(txHash("t1"), { from: agent.address, units: 500n });
    const res = await s.service.processTopUp(agent.address, txHash("t1"));
    expect(res.amount).toBe("5000000");
    expect(res.credit.available).toBe("5000000");
    const receipt = receiptFromJson(res.receipt);
    expect(receipt.creditedTotal).toBe(5_000_000n);
    expect(await isValidCreditReceipt(domain, receipt, res.signature)).toBe(true);

    s.incoming.set(txHash("t2"), { from: agent.address, units: 1000n });
    const res2 = await s.service.processTopUp(agent.address, txHash("t2"));
    expect(receiptFromJson(res2.receipt).creditedTotal).toBe(15_000_000n); // cumulative, monotonic
  });

  it("rejects replays and transfers that aren't eERC top-ups", async () => {
    s.incoming.set(txHash("t1"), { from: agent.address, units: 500n });
    await s.service.processTopUp(agent.address, txHash("t1"));
    await expect(s.service.processTopUp(agent.address, txHash("t1"))).rejects.toMatchObject({ code: "duplicate_topup" });
    await expect(s.service.processTopUp(agent.address, txHash("nope"))).rejects.toMatchObject({ code: "invalid_topup" });
  });

  it("owner treasury can fund its agent via the encrypted memo; strangers cannot", async () => {
    s.incoming.set(txHash("o1"), { from: owner.address, units: 500n, memo: `hush:topup:v1:agent=${agent.address.toLowerCase()}` });
    const res = await s.service.processTopUp(undefined, txHash("o1"));
    expect(res.receipt.agent).toBe(agent.address);
    expect(res.payer).toBe(owner.address);

    s.incoming.set(txHash("x1"), { from: stranger.address, units: 500n, memo: `hush:topup:v1:agent=${agent.address.toLowerCase()}` });
    await expect(s.service.processTopUp(undefined, txHash("x1"))).rejects.toMatchObject({ code: "unauthorized_payer" });
  });
});

describe("HushProviderService — credit reads are private", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(async () => {
    s = setup();
    s.incoming.set(txHash("t1"), { from: agent.address, units: 100n });
    await s.service.processTopUp(agent.address, txHash("t1"));
  });
  const auth = (signer: typeof agent, forProvider: Address = provider.address) =>
    creditAuthHeader(signer, domain, agent.address, forProvider);

  it("answers the agent and its registered owner", async () => {
    expect((await s.service.authorizedCreditState(agent.address, await auth(agent))).available).toBe("1000000");
    expect((await s.service.authorizedCreditState(agent.address, await auth(owner))).available).toBe("1000000");
  });

  it("refuses unsigned, stranger-signed, stale and wrong-provider queries", async () => {
    await expect(s.service.authorizedCreditState(agent.address, undefined)).rejects.toMatchObject({ code: "unauthorized", status: 401 });
    await expect(s.service.authorizedCreditState(agent.address, await auth(stranger))).rejects.toMatchObject({ code: "unauthorized" });
    await expect(s.service.authorizedCreditState(agent.address, await auth(agent, stranger.address))).rejects.toMatchObject({ code: "unauthorized" });
    const fresh = await auth(agent);
    s.now.t += (CREDIT_QUERY_MAX_AGE_SECONDS + 5) * 1000;
    await expect(s.service.authorizedCreditState(agent.address, fresh)).rejects.toMatchObject({ code: "expired_request" });
  });
});

describe("HushProviderService — voucher verification", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(async () => {
    s = setup();
    s.incoming.set(txHash("t1"), { from: agent.address, units: 100n }); // 1.00 hUSDC
    await s.service.processTopUp(agent.address, txHash("t1"));
  });

  it("accepts a valid voucher, settles it, and rejects its replay", async () => {
    const p = await signed(1n, PRICE);
    expect((await s.service.verifyVoucher(p, req, RESOURCE)).ok).toBe(true);
    const settled = await s.service.settleVoucher(p, req, RESOURCE);
    expect(settled.ok).toBe(true);
    const credit = await s.service.creditState(agent.address);
    expect(credit.settledCumulative).toBe(PRICE.toString());
    expect(credit.available).toBe((1_000_000n - PRICE).toString());
    expect(await s.service.verifyVoucher(p, req, RESOURCE)).toMatchObject({ ok: false, code: "stale_nonce" });
  });

  it.each([
    ["invalid_signature", () => signed(1n, PRICE, {}, stranger)],
    ["wrong_provider", () => signed(1n, PRICE, { provider: stranger.address })],
    ["voucher_expired", () => signed(1n, PRICE, { expiry: 1n })],
    ["underpaid", () => signed(1n, PRICE - 1n)],
    ["insufficient_credit", () => signed(1n, 2_000_000n)],
    ["request_mismatch", () => signed(1n, PRICE, { requestHash: requestHashFor("http://evil/other") })],
  ])("rejects %s", async (code, make) => {
    expect(await s.service.verifyVoucher(await make(), req, RESOURCE)).toMatchObject({ ok: false, code });
  });

  it("kill switch: a frozen agent is rejected on the very next call", async () => {
    expect((await s.service.verifyVoucher(await signed(1n, PRICE), req, RESOURCE)).ok).toBe(true);
    s.state.frozen.add(agent.address.toLowerCase());
    expect(await s.service.verifyVoucher(await signed(1n, PRICE), req, RESOURCE)).toMatchObject({ ok: false, code: "agent_frozen" });
  });

  it("rejects unregistered agents and expired credit", async () => {
    s.state.agents.clear();
    expect(await s.service.verifyVoucher(await signed(1n, PRICE), req, RESOURCE)).toMatchObject({ ok: false, code: "agent_not_registered" });
    s.state.agents.set(agent.address.toLowerCase(), owner.address);
    s.now.t += 3601_000;
    expect(await s.service.verifyVoucher(await signed(1n, PRICE, { expiry: BigInt(Math.floor(s.now.t / 1000) + 60) }), req, RESOURCE)).toMatchObject({
      ok: false,
      code: "credit_expired",
    });
  });
});

describe("HushProviderService — refunds, expiry, batches", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(async () => {
    s = setup();
    s.incoming.set(txHash("t1"), { from: agent.address, units: 500n }); // 5.00
    await s.service.processTopUp(agent.address, txHash("t1"));
    await s.service.settleVoucher(await signed(1n, 30_000n), req, RESOURCE); // spend 0.03
  });

  it("refunds unspent credit (floored to eERC units) privately to the agent", async () => {
    const request = { agent: agent.address, provider: provider.address, deadline: BigInt(Math.floor(Date.now() / 1000) + 60) };
    const res = await s.service.requestRefund(refundRequestToJson(request), await signRefundRequest(agent, domain, request));
    expect(res.amount).toBe("4970000"); // 5.00 - 0.03
    expect(s.sent).toEqual([{ to: agent.address, units: 497n, memo: "hush:refund:v1" }]);
    expect(res.credit.available).toBe("0");
    // nothing left → no second transfer
    expect((await s.service.refundAgent(agent.address, "requested")).txHash).toBeNull();
  });

  it("only the agent or its owner can request a refund", async () => {
    const request = { agent: agent.address, provider: provider.address, deadline: BigInt(Math.floor(Date.now() / 1000) + 60) };
    await expect(s.service.requestRefund(refundRequestToJson(request), await signRefundRequest(stranger, domain, request))).rejects.toMatchObject({
      code: "invalid_signature",
    });
    const res = await s.service.requestRefund(refundRequestToJson(request), await signRefundRequest(owner, domain, request));
    expect(res.amount).toBe("4970000");
  });

  it("auto-refunds credit after the TTL", async () => {
    expect(await s.service.expireCredits()).toHaveLength(0);
    s.now.t += 3601_000;
    const [r] = await s.service.expireCredits();
    expect(r?.amount).toBe("4970000");
    expect((await s.store.listRefunds())[0]).toMatchObject({ reason: "expired", status: "sent" });
  });

  it("commits vouchers as a Merkle batch whose proofs verify; pads idle periods with dummy roots", async () => {
    await s.service.settleVoucher(await signed(2n, 50_000n), req, RESOURCE);
    const batch = await s.service.commitBatch();
    expect(batch).toMatchObject({ batchId: 1n, voucherCount: 2, dummy: false });
    for (const v of await s.store.listVouchers()) {
      const p = await s.service.proofFor(v.leaf);
      expect(p && verifyMerkleProof(p.root, v.leaf, p.proof)).toBe(true);
      expect(p?.root).toBe(s.state.commits[0]!.root);
    }
    const idle = await s.service.commitBatch();
    expect(idle).toMatchObject({ batchId: 2n, voucherCount: 0, dummy: true });
    expect(s.state.commits[1]!.root).not.toBe(s.state.commits[0]!.root);
  });
});
