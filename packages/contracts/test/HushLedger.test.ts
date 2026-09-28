import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { expect } from "chai";
import { ethers } from "hardhat";
import type { HushLedger } from "../typechain-types";

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

// Must match HushLedger.voucherLeaf and the SDK/facilitator tree encoding.
const LEAF_TYPES = ["address", "address", "uint256", "uint64", "bytes32", "uint64", "bytes"];

const VOUCHER_TYPES = {
  Voucher: [
    { name: "agent", type: "address" },
    { name: "provider", type: "address" },
    { name: "cumulativeSpent", type: "uint256" },
    { name: "nonce", type: "uint64" },
    { name: "requestHash", type: "bytes32" },
    { name: "expiry", type: "uint64" },
  ],
};
const RECEIPT_TYPES = {
  CreditReceipt: [
    { name: "agent", type: "address" },
    { name: "provider", type: "address" },
    { name: "creditedTotal", type: "uint256" },
    { name: "topupTxHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
};

interface Voucher {
  agent: string;
  provider: string;
  cumulativeSpent: bigint;
  nonce: bigint;
  requestHash: string;
  expiry: bigint;
}

describe("HushLedger", () => {
  async function deployFixture() {
    const [, provider, facilitator, agent, stranger, otherProvider] = await ethers.getSigners();
    const registry = await ethers.deployContract("HushRegistry", [ethers.ZeroAddress]);
    const ledger = await ethers.deployContract("HushLedger", [await registry.getAddress()]);
    const key = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [1n, 2n]);
    await registry.connect(provider!).registerProvider("PriceFeed", "https://feed", 20_000n, key);
    await registry.connect(provider!).setFacilitator(facilitator!.address);
    await registry.connect(otherProvider!).registerProvider("Other", "https://other", 1n, key);
    return {
      registry,
      ledger,
      provider: provider!,
      facilitator: facilitator!,
      agent: agent!,
      stranger: stranger!,
      otherProvider: otherProvider!,
    };
  }

  async function domain(ledger: HushLedger) {
    const { chainId } = await ethers.provider.getNetwork();
    return { name: "Hush", version: "1", chainId, verifyingContract: await ledger.getAddress() };
  }

  async function signVouchers(ledger: HushLedger, agent: Signer, provider: string, n: number) {
    const expiry = BigInt(await time.latest()) + 3600n;
    const out: { voucher: Voucher; signature: string }[] = [];
    for (let i = 1; i <= n; i++) {
      const voucher: Voucher = {
        agent: agent.address,
        provider,
        cumulativeSpent: 20_000n * BigInt(i), // running total: 0.02 USDC per call
        nonce: BigInt(i),
        requestHash: ethers.id(`GET /api/feed #${i}`),
        expiry,
      };
      out.push({ voucher, signature: await agent.signTypedData(await domain(ledger), VOUCHER_TYPES, voucher) });
    }
    return out;
  }

  const toLeafValues = ({ voucher: v, signature }: { voucher: Voucher; signature: string }) => [
    v.agent,
    v.provider,
    v.cumulativeSpent,
    v.nonce,
    v.requestHash,
    v.expiry,
    signature,
  ];

  describe("commitBatch", () => {
    it("accepts commits from the provider and its facilitator", async () => {
      const { ledger, provider, facilitator } = await loadFixture(deployFixture);
      const root1 = ethers.id("root-1");
      await expect(ledger.connect(provider).commitBatch(provider.address, 1, root1))
        .to.emit(ledger, "BatchCommitted")
        .withArgs(provider.address, 1, root1, provider.address);
      await expect(ledger.connect(facilitator).commitBatch(provider.address, 2, ethers.id("root-2")))
        .to.emit(ledger, "BatchCommitted")
        .withArgs(provider.address, 2, ethers.id("root-2"), facilitator.address);
      expect(await ledger.latestBatchId(provider.address)).to.equal(2);
      expect(await ledger.getRoot(provider.address, 1)).to.equal(root1);
    });

    it("rejects strangers, unregistered providers and other providers' facilitators", async () => {
      const { ledger, provider, stranger, facilitator, otherProvider } = await loadFixture(deployFixture);
      await expect(ledger.connect(stranger).commitBatch(provider.address, 1, ethers.id("r"))).to.be.revertedWithCustomError(ledger, "NotAuthorized");
      await expect(ledger.connect(stranger).commitBatch(stranger.address, 1, ethers.id("r"))).to.be.revertedWithCustomError(ledger, "NotAuthorized");
      await expect(ledger.connect(facilitator).commitBatch(otherProvider.address, 1, ethers.id("r"))).to.be.revertedWithCustomError(ledger, "NotAuthorized");
    });

    it("enforces strictly increasing batch ids per provider (gaps allowed)", async () => {
      const { ledger, provider, otherProvider } = await loadFixture(deployFixture);
      await expect(ledger.connect(provider).commitBatch(provider.address, 0, ethers.id("r"))).to.be.revertedWithCustomError(ledger, "NonIncreasingBatchId").withArgs(0, 0);
      await ledger.connect(provider).commitBatch(provider.address, 5, ethers.id("r5"));
      await expect(ledger.connect(provider).commitBatch(provider.address, 5, ethers.id("again"))).to.be.revertedWithCustomError(ledger, "NonIncreasingBatchId").withArgs(5, 5);
      await expect(ledger.connect(provider).commitBatch(provider.address, 4, ethers.id("older"))).to.be.revertedWithCustomError(ledger, "NonIncreasingBatchId").withArgs(4, 5);
      await ledger.connect(provider).commitBatch(provider.address, 9, ethers.id("r9"));
      // Sequences are independent per provider.
      await ledger.connect(otherProvider).commitBatch(otherProvider.address, 1, ethers.id("o1"));
      expect(await ledger.getRoot(provider.address, 5)).to.equal(ethers.id("r5"));
    });

    it("rejects an empty root", async () => {
      const { ledger, provider } = await loadFixture(deployFixture);
      await expect(ledger.connect(provider).commitBatch(provider.address, 1, ethers.ZeroHash)).to.be.revertedWithCustomError(ledger, "EmptyRoot");
    });
  });

  describe("inclusion proofs", () => {
    it("proves every voucher in a committed batch and nothing else", async () => {
      const { ledger, provider, agent, otherProvider } = await loadFixture(deployFixture);
      const signed = await signVouchers(ledger, agent, provider.address, 5);
      const tree = StandardMerkleTree.of(signed.map(toLeafValues), LEAF_TYPES);
      await ledger.connect(provider).commitBatch(provider.address, 1, tree.root);

      for (const [i, entry] of signed.entries()) {
        const leaf = tree.leafHash(toLeafValues(entry));
        // On-chain leaf helper must match the off-chain tree encoding.
        expect(await ledger.voucherLeaf(entry.voucher, entry.signature)).to.equal(leaf);
        expect(await ledger.verifyInclusion(provider.address, 1, leaf, tree.getProof(i))).to.equal(true);
      }

      const leaf0 = tree.leafHash(toLeafValues(signed[0]!));
      const proof0 = tree.getProof(0);
      // Wrong batch, wrong provider, uncommitted batch.
      expect(await ledger.verifyInclusion(provider.address, 2, leaf0, proof0)).to.equal(false);
      expect(await ledger.verifyInclusion(otherProvider.address, 1, leaf0, proof0)).to.equal(false);
      // A tampered voucher (e.g. a different charged amount) is not in the tree.
      const tampered = { ...signed[0]!, voucher: { ...signed[0]!.voucher, cumulativeSpent: 1n } };
      expect(await ledger.verifyInclusion(provider.address, 1, tree.leafHash(toLeafValues(tampered)), proof0)).to.equal(false);

      // Safe API: leaf derived on-chain from the signed voucher.
      expect(await ledger.verifyVoucherInclusion(1, signed[2]!.voucher, signed[2]!.signature, tree.getProof(2))).to.equal(true);
      expect(await ledger.verifyVoucherInclusion(1, tampered.voucher, tampered.signature, proof0)).to.equal(false);
      expect(await ledger.verifyVoucherInclusion(1, signed[0]!.voucher, signed[1]!.signature, proof0)).to.equal(false);
    });

    it("works for a single-leaf (e.g. padded empty) batch", async () => {
      const { ledger, provider, agent } = await loadFixture(deployFixture);
      const [entry] = await signVouchers(ledger, agent, provider.address, 1);
      const tree = StandardMerkleTree.of([toLeafValues(entry!)], LEAF_TYPES);
      await ledger.connect(provider).commitBatch(provider.address, 1, tree.root);
      expect(await ledger.verifyInclusion(provider.address, 1, tree.leafHash(toLeafValues(entry!)), [])).to.equal(true);
    });
  });

  describe("EIP-712 vouchers and receipts", () => {
    it("hashes vouchers exactly like ethers' typed-data encoder and checks the agent's signature", async () => {
      const { ledger, provider, agent, stranger } = await loadFixture(deployFixture);
      const [{ voucher, signature }] = await signVouchers(ledger, agent, provider.address, 1);
      expect(await ledger.hashVoucher(voucher)).to.equal(ethers.TypedDataEncoder.hash(await domain(ledger), VOUCHER_TYPES, voucher));
      expect(await ledger.isValidVoucherSignature(voucher, signature)).to.equal(true);

      const forged = await stranger.signTypedData(await domain(ledger), VOUCHER_TYPES, voucher);
      expect(await ledger.isValidVoucherSignature(voucher, forged)).to.equal(false);
      expect(await ledger.isValidVoucherSignature({ ...voucher, cumulativeSpent: 1n }, signature)).to.equal(false);
    });

    it("binds vouchers to this ledger deployment (no cross-deployment replay)", async () => {
      const { ledger, registry, provider, agent } = await loadFixture(deployFixture);
      const [{ voucher, signature }] = await signVouchers(ledger, agent, provider.address, 1);
      const otherLedger = await ethers.deployContract("HushLedger", [await registry.getAddress()]);
      expect(await otherLedger.isValidVoucherSignature(voucher, signature)).to.equal(false);
    });

    it("verifies provider-signed credit receipts", async () => {
      const { ledger, provider, agent, stranger } = await loadFixture(deployFixture);
      const receipt = {
        agent: agent.address,
        provider: provider.address,
        creditedTotal: 5_000_000n, // 5 USDC
        topupTxHash: ethers.id("topup-tx"),
        issuedAt: BigInt(await time.latest()),
      };
      expect(await ledger.hashCreditReceipt(receipt)).to.equal(ethers.TypedDataEncoder.hash(await domain(ledger), RECEIPT_TYPES, receipt));
      const sig = await provider.signTypedData(await domain(ledger), RECEIPT_TYPES, receipt);
      expect(await ledger.isValidCreditReceiptSignature(receipt, sig)).to.equal(true);
      const notProvider = await stranger.signTypedData(await domain(ledger), RECEIPT_TYPES, receipt);
      expect(await ledger.isValidCreditReceiptSignature(receipt, notProvider)).to.equal(false);
    });
  });
});
