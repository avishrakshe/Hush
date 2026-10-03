import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { deployHushStack, deployStockStack, EERC_DECIMALS, STOCK_FAUCET_CAP, STOCKS } from "../scripts/lib/deployStack";

// Smoke test for the exact routine `pnpm deploy:fuji` runs: the whole stack deploys and is wired together.
describe("deployHushStack", () => {
  it("deploys eERC (converter, prod verifiers) + MockUSDC + HushRegistry + HushLedger, correctly wired", async () => {
    const d = await deployHushStack(hre);
    const c = d.contracts;

    const eerc = await ethers.getContractAt("EncryptedERC", c.EncryptedERC.address);
    expect(await eerc.isConverter()).to.equal(true);
    expect(await eerc.decimals()).to.equal(EERC_DECIMALS);
    expect(await eerc.registrar()).to.equal(c.Registrar.address);
    expect(await eerc.transferVerifier()).to.equal(c.TransferVerifier.address);
    // No auditor yet: every deposit/transfer reverts until the owner sets one.
    expect(await eerc.isAuditorKeySet()).to.equal(false);

    const registry = await ethers.getContractAt("HushRegistry", c.HushRegistry.address);
    expect(await registry.eercRegistrar()).to.equal(c.Registrar.address);
    const ledger = await ethers.getContractAt("HushLedger", c.HushLedger.address);
    expect(await ledger.registry()).to.equal(c.HushRegistry.address);

    for (const [name, info] of Object.entries(c)) {
      expect(await ethers.provider.getCode(info.address), name).to.not.equal("0x");
    }
  });

  it("deployStockStack adds the oracle (seeded) and one 18-dp MockStock per ticker", async () => {
    const s = await deployStockStack(hre);
    const oracle = await ethers.getContractAt("MockStockOracle", s.MockStockOracle.address);
    for (const def of STOCKS) {
      const stock = await ethers.getContractAt("MockStock", s[def.symbol].address);
      expect(await stock.symbol()).to.equal(def.symbol);
      expect(await stock.decimals()).to.equal(18);
      expect(await stock.faucetCap()).to.equal(STOCK_FAUCET_CAP);
      expect(ethers.decodeBytes32String(await stock.ticker())).to.equal(def.ticker);
      expect((await oracle.latestPrice(ethers.encodeBytes32String(def.ticker)))[0]).to.equal(def.seedPrice);
    }
  });
});
