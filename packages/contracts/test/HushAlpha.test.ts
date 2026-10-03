import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import type { HushAlpha } from "../typechain-types";

// Must match HushAlpha's typehash strings and the SDK's alpha typed data.
const TYPES = {
  Quote: {
    Quote: [
      { name: "quoteId", type: "bytes32" },
      { name: "desk", type: "address" },
      { name: "agent", type: "address" },
      { name: "ticker", type: "bytes32" },
      { name: "side", type: "uint8" },
      { name: "size", type: "uint64" },
      { name: "price", type: "uint256" },
      { name: "notional", type: "uint256" },
      { name: "expiry", type: "uint64" },
    ],
  },
  FillReceipt: {
    FillReceipt: [
      { name: "quoteId", type: "bytes32" },
      { name: "desk", type: "address" },
      { name: "agent", type: "address" },
      { name: "ticker", type: "bytes32" },
      { name: "side", type: "uint8" },
      { name: "size", type: "uint64" },
      { name: "price", type: "uint256" },
      { name: "filledAt", type: "uint64" },
    ],
  },
  PositionStatement: {
    PositionStatement: [
      { name: "desk", type: "address" },
      { name: "agent", type: "address" },
      { name: "ticker", type: "bytes32" },
      { name: "position", type: "uint64" },
      { name: "avgCost", type: "uint256" },
      { name: "seq", type: "uint64" },
      { name: "issuedAt", type: "uint64" },
    ],
  },
  SignalRecord: {
    SignalRecord: [
      { name: "provider", type: "address" },
      { name: "ticker", type: "bytes32" },
      { name: "direction", type: "uint8" },
      { name: "confidenceBps", type: "uint16" },
      { name: "price", type: "uint256" },
      { name: "issuedAt", type: "uint64" },
      { name: "horizonSec", type: "uint64" },
    ],
  },
};

const EPOCH = 600;
const NVDA = ethers.encodeBytes32String("NVDA");

describe("HushAlpha", () => {
  async function fixture() {
    const [desk, agent, provider, committer, stranger] = await ethers.getSigners();
    const alpha = await ethers.deployContract("HushAlpha", [EPOCH]);
    return { alpha, desk: desk!, agent: agent!, provider: provider!, committer: committer!, stranger: stranger! };
  }

  const domain = async (alpha: HushAlpha) => ({
    name: "HushAlpha",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await alpha.getAddress(),
  });

  /** Moves the chain into the middle of a fresh epoch and returns the epoch that just closed. */
  async function intoNextEpoch(alpha: HushAlpha) {
    const now = await time.latest();
    await time.increaseTo((Math.floor(now / EPOCH) + 1) * EPOCH + 30);
    return (await alpha.currentEpoch()) - 1n;
  }

  describe("EIP-712 records", () => {
    it("hashes all four record types exactly like ethers and checks the right signer", async () => {
      const { alpha, desk, agent, provider, stranger } = await loadFixture(fixture);
      const d = await domain(alpha);
      const now = BigInt(await time.latest());
      const quote = {
        quoteId: ethers.id("q1"),
        desk: desk.address,
        agent: agent.address,
        ticker: NVDA,
        side: 1,
        size: 10n,
        price: 180_250_000n,
        notional: 18_025_000n,
        expiry: now + 15n,
      };
      const fill = { quoteId: quote.quoteId, desk: desk.address, agent: agent.address, ticker: NVDA, side: 1, size: 10n, price: quote.price, filledAt: now };
      const statement = { desk: desk.address, agent: agent.address, ticker: NVDA, position: 10n, avgCost: quote.price, seq: 1n, issuedAt: now };
      const signal = { provider: provider.address, ticker: NVDA, direction: 1, confidenceBps: 7100, price: 182_330_000n, issuedAt: now, horizonSec: 1200n };

      // Typechain gives each method its own struct type; the runtime shape is what this table checks.
      type Hash = (v: object) => Promise<string>;
      type Valid = (v: object, sig: string) => Promise<boolean>;
      const cases: { name: keyof typeof TYPES; value: Record<string, unknown>; signer: typeof desk; hash: Hash; valid: Valid }[] = [
        { name: "Quote", value: quote, signer: desk, hash: alpha.hashQuote as unknown as Hash, valid: alpha.isValidQuoteSignature as unknown as Valid },
        { name: "FillReceipt", value: fill, signer: desk, hash: alpha.hashFillReceipt as unknown as Hash, valid: alpha.isValidFillReceiptSignature as unknown as Valid },
        {
          name: "PositionStatement",
          value: statement,
          signer: desk,
          hash: alpha.hashPositionStatement as unknown as Hash,
          valid: alpha.isValidPositionStatementSignature as unknown as Valid,
        },
        { name: "SignalRecord", value: signal, signer: provider, hash: alpha.hashSignalRecord as unknown as Hash, valid: alpha.isValidSignalRecordSignature as unknown as Valid },
      ];

      for (const c of cases) {
        const types = TYPES[c.name];
        expect(await c.hash(c.value), c.name).to.equal(ethers.TypedDataEncoder.hash(d, types, c.value));
        const sig = await c.signer.signTypedData(d, types, c.value);
        expect(await c.valid(c.value, sig), `${c.name} signed by its issuer`).to.equal(true);
        const forged = await stranger.signTypedData(d, types, c.value);
        expect(await c.valid(c.value, forged), `${c.name} signed by someone else`).to.equal(false);
      }
      // Tampering with a signed field breaks the signature.
      const sig = await desk.signTypedData(d, TYPES.Quote, quote);
      expect(await alpha.isValidQuoteSignature({ ...quote, notional: 1n }, sig)).to.equal(false);
    });

    it("binds records to this deployment (no cross-deployment replay)", async () => {
      const { alpha, desk, agent } = await loadFixture(fixture);
      const other = await ethers.deployContract("HushAlpha", [EPOCH]);
      const fill = { quoteId: ethers.id("q"), desk: desk.address, agent: agent.address, ticker: NVDA, side: 1, size: 1n, price: 1n, filledAt: 1n };
      const sig = await desk.signTypedData(await domain(alpha), TYPES.FillReceipt, fill);
      expect(await alpha.isValidFillReceiptSignature(fill, sig)).to.equal(true);
      expect(await other.isValidFillReceiptSignature(fill, sig)).to.equal(false);
    });
  });

  describe("chain heads", () => {
    it("accepts the epoch that just closed, from the subject or its committer", async () => {
      const { alpha, provider, committer } = await loadFixture(fixture);
      const e1 = await intoNextEpoch(alpha);
      await expect(alpha.connect(provider).commitChainHead(provider.address, e1, ethers.id("head-1")))
        .to.emit(alpha, "ChainHeadCommitted")
        .withArgs(provider.address, e1, ethers.id("head-1"), provider.address);

      await alpha.connect(provider).setCommitter(committer.address);
      const e2 = await intoNextEpoch(alpha);
      await alpha.connect(committer).commitChainHead(provider.address, e2, ethers.id("head-2"));

      expect(await alpha.getChainHead(provider.address, e1)).to.equal(ethers.id("head-1"));
      expect(await alpha.getChainHead(provider.address, e2)).to.equal(ethers.id("head-2"));
      expect(await alpha.firstEpoch(provider.address)).to.equal(e1);
      expect(await alpha.latestEpoch(provider.address)).to.equal(e2);
    });

    it("rejects the current epoch, older epochs and future epochs (no back-dating, no pre-committing)", async () => {
      const { alpha, provider } = await loadFixture(fixture);
      const closed = await intoNextEpoch(alpha);
      const current = closed + 1n;
      for (const epoch of [current, closed - 1n, closed - 10n, current + 1n]) {
        await expect(alpha.connect(provider).commitChainHead(provider.address, epoch, ethers.id("h")))
          .to.be.revertedWithCustomError(alpha, "WrongEpoch")
          .withArgs(epoch, closed);
      }
      // Once the window has passed, an epoch can never be written again.
      await intoNextEpoch(alpha);
      await expect(alpha.connect(provider).commitChainHead(provider.address, closed, ethers.id("late"))).to.be.revertedWithCustomError(
        alpha,
        "WrongEpoch",
      );
    });

    it("commits each epoch once, never an empty head, and only for authorised keys", async () => {
      const { alpha, provider, committer, stranger } = await loadFixture(fixture);
      const e = await intoNextEpoch(alpha);
      await expect(alpha.connect(stranger).commitChainHead(provider.address, e, ethers.id("h"))).to.be.revertedWithCustomError(alpha, "NotAuthorized");
      await expect(alpha.connect(provider).commitChainHead(provider.address, e, ethers.ZeroHash)).to.be.revertedWithCustomError(alpha, "EmptyHead");
      await alpha.connect(provider).commitChainHead(provider.address, e, ethers.id("h"));
      await expect(alpha.connect(provider).commitChainHead(provider.address, e, ethers.id("rewrite")))
        .to.be.revertedWithCustomError(alpha, "AlreadyCommitted")
        .withArgs(e);

      // A revoked committer loses access.
      await alpha.connect(provider).setCommitter(committer.address);
      await alpha.connect(provider).setCommitter(ethers.ZeroAddress);
      const next = await intoNextEpoch(alpha);
      await expect(alpha.connect(committer).commitChainHead(provider.address, next, ethers.id("h2"))).to.be.revertedWithCustomError(alpha, "NotAuthorized");
    });

    it("rejects a zero epoch length", async () => {
      const factory = await ethers.getContractFactory("HushAlpha");
      await expect(factory.deploy(0)).to.be.revertedWithCustomError(factory, "ZeroEpochLen");
    });
  });
});
