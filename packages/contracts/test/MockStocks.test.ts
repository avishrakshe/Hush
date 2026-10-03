import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

const NVDA = ethers.encodeBytes32String("NVDA");
const TSLA = ethers.encodeBytes32String("TSLA");
const SHARE = 10n ** 18n;
const usd = (dollars: number) => BigInt(Math.round(dollars * 1e6));

describe("MockStock (faucet capped per address)", () => {
  async function fixture() {
    const [owner, alice, bob] = await ethers.getSigners();
    const stock = await ethers.deployContract("MockStock", ["Hush Mock NVDA", "mNVDA", NVDA, 10n * SHARE]);
    return { stock, owner: owner!, alice: alice!, bob: bob! };
  }

  it("is an 18-decimal token that knows its oracle ticker", async () => {
    const { stock } = await loadFixture(fixture);
    expect(await stock.decimals()).to.equal(18);
    expect(await stock.symbol()).to.equal("mNVDA");
    expect(await stock.ticker()).to.equal(NVDA);
  });

  it("caps the faucet per address over its lifetime, not per call", async () => {
    const { stock, alice, bob } = await loadFixture(fixture);
    await stock.connect(alice).faucet(6n * SHARE);
    await stock.connect(alice).faucet(4n * SHARE);
    expect(await stock.balanceOf(alice.address)).to.equal(10n * SHARE);
    await expect(stock.connect(alice).faucet(1n))
      .to.be.revertedWithCustomError(stock, "FaucetCapExceeded")
      .withArgs(1n, 0n);
    // Another address has its own allowance.
    await stock.connect(bob).faucet(10n * SHARE);
    expect(await stock.faucetMinted(bob.address)).to.equal(10n * SHARE);
  });

  it("rejects a single faucet call above the cap and reports what is left", async () => {
    const { stock, alice } = await loadFixture(fixture);
    await stock.connect(alice).faucet(3n * SHARE);
    await expect(stock.connect(alice).faucet(8n * SHARE))
      .to.be.revertedWithCustomError(stock, "FaucetCapExceeded")
      .withArgs(8n * SHARE, 7n * SHARE);
  });

  it("lets only the owner mint inventory, outside the faucet cap", async () => {
    const { stock, owner, alice } = await loadFixture(fixture);
    await stock.connect(owner).mint(alice.address, 1_000n * SHARE);
    expect(await stock.balanceOf(alice.address)).to.equal(1_000n * SHARE);
    expect(await stock.faucetMinted(alice.address)).to.equal(0n);
    await expect(stock.connect(alice).mint(alice.address, 1n)).to.be.revertedWithCustomError(stock, "OwnableUnauthorizedAccount");
  });
});

describe("MockStockOracle (round history + getPriceAt)", () => {
  async function fixture() {
    const [owner, bot, stranger] = await ethers.getSigners();
    const oracle = await ethers.deployContract("MockStockOracle");
    await oracle.setUpdater(bot!.address, true);
    return { oracle, owner: owner!, bot: bot!, stranger: stranger! };
  }

  /** Posts one round per entry, `gap` seconds apart; returns each round's block timestamp. */
  async function postSeries(oracle: Awaited<ReturnType<typeof fixture>>["oracle"], prices: bigint[], gap = 60) {
    const stamps: number[] = [];
    for (const p of prices) {
      await time.increase(gap);
      await oracle.postPrices([NVDA], [p]);
      stamps.push(await time.latest());
    }
    return stamps;
  }

  it("only the owner or an updater can post", async () => {
    const { oracle, bot, stranger } = await loadFixture(fixture);
    await expect(oracle.connect(stranger).postPrices([NVDA], [usd(180)])).to.be.revertedWithCustomError(oracle, "NotUpdater");
    await expect(oracle.connect(bot).postPrices([NVDA], [usd(180)])).to.emit(oracle, "PriceUpdated");
    await oracle.setUpdater(bot.address, false);
    await expect(oracle.connect(bot).postPrices([NVDA], [usd(181)])).to.be.revertedWithCustomError(oracle, "NotUpdater");
    await expect(oracle.connect(stranger).setUpdater(stranger.address, true)).to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
  });

  it("posts every ticker of a tick in one call, stamped with the block time", async () => {
    const { oracle, bot } = await loadFixture(fixture);
    await oracle.connect(bot).postPrices([NVDA, TSLA], [usd(180), usd(250)]);
    const now = await time.latest();
    const [p, ts, id] = await oracle.latestPrice(TSLA);
    expect([p, ts, id]).to.deep.equal([usd(250), BigInt(now), 0n]);
    expect(await oracle.getTickers()).to.deep.equal([NVDA, TSLA]);
    expect(await oracle.roundCount(NVDA)).to.equal(1n);
  });

  it("validates input: lengths, zero price, and one round per ticker per timestamp", async () => {
    const { oracle } = await loadFixture(fixture);
    await expect(oracle.postPrices([NVDA, TSLA], [usd(1)])).to.be.revertedWithCustomError(oracle, "LengthMismatch");
    await expect(oracle.postPrices([NVDA], [0n])).to.be.revertedWithCustomError(oracle, "ZeroPrice").withArgs(NVDA);
    // The same ticker twice in one call would create two rounds with one timestamp.
    await expect(oracle.postPrices([NVDA, NVDA], [usd(1), usd(2)]))
      .to.be.revertedWithCustomError(oracle, "RoundNotNewer")
      .withArgs(NVDA);
  });

  it("getPriceAt returns the latest round at or before the timestamp", async () => {
    const { oracle } = await loadFixture(fixture);
    const prices = [usd(180), usd(181.5), usd(179.25), usd(183), usd(184.1), usd(182), usd(185)];
    const t = await postSeries(oracle, prices);

    for (let i = 0; i < prices.length; i++) {
      // Exactly on a round, and one second before the next round.
      expect((await oracle.getPriceAt(NVDA, t[i]!))[0], `at round ${i}`).to.equal(prices[i]);
      expect((await oracle.getPriceAt(NVDA, t[i]! + 59))[0], `between ${i} and ${i + 1}`).to.equal(prices[i]);
    }
    const [price, roundTs, roundId] = await oracle.getPriceAt(NVDA, t[3]! + 30);
    expect([price, roundTs, roundId]).to.deep.equal([prices[3], BigInt(t[3]!), 3n]);
    // Far in the future: the last round.
    expect((await oracle.getPriceAt(NVDA, t[6]! + 86_400))[2]).to.equal(6n);
  });

  it("getPriceAt reverts before the first round and for unknown tickers", async () => {
    const { oracle } = await loadFixture(fixture);
    const [t0] = await postSeries(oracle, [usd(180)]);
    await expect(oracle.getPriceAt(NVDA, t0! - 1)).to.be.revertedWithCustomError(oracle, "NoPrice");
    await expect(oracle.getPriceAt(TSLA, t0!)).to.be.revertedWithCustomError(oracle, "NoPrice");
    await expect(oracle.latestPrice(TSLA)).to.be.revertedWithCustomError(oracle, "NoPrice");
    await expect(oracle.getRound(NVDA, 1)).to.be.revertedWithCustomError(oracle, "UnknownRound");
  });
});
