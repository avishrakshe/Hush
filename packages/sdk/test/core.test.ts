import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  LEAF_TYPES,
  exportKeyBackup,
  hushDomain,
  importKeyBackup,
  isValidCreditReceipt,
  receiptFromJson,
  receiptToJson,
  recoverVoucherSigner,
  requestHashFor,
  signCreditReceipt,
  signVoucher,
  verifyMerkleProof,
  voucherFromJson,
  voucherLeaf,
  voucherLeafValues,
  voucherToJson,
} from "../src/index.js";
import { MemoryHushStore, PolicyViolation, assertPolicy, pickTopUpChunk } from "../src/client/index.js";
import { atomicToEerc, atomicToEercExact, eercToAtomic } from "../src/units.js";

const agent = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const provider = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const stranger = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const LEDGER = "0x1D6ee5d0AA41f191A361C4306EbCc9E2Aa387577";
const domain = hushDomain(43113, LEDGER);

const voucher = (n: bigint) => ({
  agent: agent.address,
  provider: provider.address,
  cumulativeSpent: 20_000n * n,
  nonce: n,
  requestHash: requestHashFor(`http://localhost:4021/api/feed#${n}`),
  expiry: 2_000_000_000n,
});

describe("vouchers (EIP-712)", () => {
  it("signs and recovers the agent", async () => {
    const v = voucher(1n);
    const sig = await signVoucher(agent, domain, v);
    expect(await recoverVoucherSigner(domain, v, sig)).toBe(agent.address);
  });

  it("any field change or another deployment breaks the signature", async () => {
    const v = voucher(1n);
    const sig = await signVoucher(agent, domain, v);
    expect(await recoverVoucherSigner(domain, { ...v, cumulativeSpent: 1n }, sig)).not.toBe(agent.address);
    expect(await recoverVoucherSigner(hushDomain(43114, LEDGER), v, sig)).not.toBe(agent.address);
  });

  it("round-trips through JSON without losing bigints", () => {
    const v = voucher(7n);
    expect(voucherFromJson(voucherToJson(v))).toEqual(v);
  });
});

describe("credit receipts", () => {
  const receipt = {
    agent: agent.address,
    provider: provider.address,
    creditedTotal: 5_000_000n,
    topupTxHash: requestHashFor("tx"),
    issuedAt: 1_700_000_000n,
  };

  it("are valid only when signed by the provider named in them", async () => {
    const good = await signCreditReceipt(provider, domain, receipt);
    expect(await isValidCreditReceipt(domain, receipt, good)).toBe(true);
    const forged = await signCreditReceipt(stranger, domain, receipt);
    expect(await isValidCreditReceipt(domain, receipt, forged)).toBe(false);
    expect(await isValidCreditReceipt(domain, { ...receipt, creditedTotal: 9_000_000n }, good)).toBe(false);
  });

  it("round-trip JSON", () => {
    expect(receiptFromJson(receiptToJson(receipt))).toEqual(receipt);
  });
});

describe("merkle leaves", () => {
  it("match OZ StandardMerkleTree (and therefore HushLedger.voucherLeaf)", async () => {
    const signed = await Promise.all([1n, 2n, 3n, 4n, 5n].map(async (n) => ({ voucher: voucher(n), signature: await signVoucher(agent, domain, voucher(n)) })));
    const values = signed.map((s) => voucherLeafValues(s).map((x) => (typeof x === "bigint" ? x.toString() : x)));
    const tree = StandardMerkleTree.of(values, [...LEAF_TYPES]);
    for (const [i, s] of signed.entries()) {
      expect(voucherLeaf(s)).toBe(tree.leafHash(values[i]!));
      expect(verifyMerkleProof(tree.root as `0x${string}`, voucherLeaf(s), tree.getProof(i) as `0x${string}`[])).toBe(true);
    }
    const tampered = { ...signed[0]!, voucher: { ...signed[0]!.voucher, cumulativeSpent: 1n } };
    expect(verifyMerkleProof(tree.root as `0x${string}`, voucherLeaf(tampered), tree.getProof(0) as `0x${string}`[])).toBe(false);
  });
});

describe("eERC key backup (owner-encrypted)", () => {
  it("round-trips with the right passphrase and fails otherwise", async () => {
    const key = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b";
    const backup = await exportKeyBackup(key, agent.address, "correct horse battery staple");
    expect(backup.ciphertext).not.toContain(key);
    expect(await importKeyBackup(backup, "correct horse battery staple")).toBe(key);
    await expect(importKeyBackup(backup, "wrong passphrase!!")).rejects.toThrow(/wrong passphrase/);
    // bound to the agent address: re-labelling the backup breaks it
    await expect(importKeyBackup({ ...backup, address: stranger.address }, "correct horse battery staple")).rejects.toThrow();
  });
});

describe("units", () => {
  it("converts between USDC atomic (6 dp) and eERC units (2 dp)", () => {
    expect(atomicToEerc(5_000_000n, 2)).toBe(500n);
    expect(eercToAtomic(500n, 2)).toBe(5_000_000n);
    expect(atomicToEerc(20_001n, 2)).toBe(2n); // floors
    expect(() => atomicToEercExact(20_001n, 2)).toThrow();
  });
});

describe("privacy: fixed top-up chunks", () => {
  const chunks = [5_000_000n, 10_000_000n];
  it("picks the smallest chunk that covers the need and the provider minimum", () => {
    expect(pickTopUpChunk(20_000n, 1_000_000n, chunks)).toBe(5_000_000n);
    expect(pickTopUpChunk(6_000_000n, 1_000_000n, chunks)).toBe(10_000_000n);
    expect(pickTopUpChunk(1n, 7_000_000n, chunks)).toBe(10_000_000n);
    expect(pickTopUpChunk(25_000_000n, 1n, chunks)).toBe(30_000_000n); // multiples of the largest
  });
});

describe("spend policy", () => {
  it("enforces allowlist, per-call max and daily cap before signing", async () => {
    const store = new MemoryHushStore();
    const policy = { allowedProviders: [provider.address], maxPerCall: 50_000n, dailyCap: 100_000n };
    await expect(assertPolicy(policy, store, stranger.address, 1n)).rejects.toThrow(PolicyViolation);
    await expect(assertPolicy(policy, store, provider.address, 60_000n)).rejects.toThrow(/per-call/);
    await assertPolicy(policy, store, provider.address, 40_000n);
    await store.addPayment({ id: "a", scheme: "hush-credit", provider: provider.address, amount: "80000", resource: "", at: Date.now() });
    await expect(assertPolicy(policy, store, provider.address, 40_000n)).rejects.toThrow(/daily cap/);
    // yesterday's spend doesn't count
    const store2 = new MemoryHushStore();
    await store2.addPayment({ id: "b", scheme: "exact", provider: provider.address, amount: "99000", resource: "", at: Date.now() - 86_400_000 * 2 });
    await assertPolicy(policy, store2, provider.address, 40_000n);
  });
});
