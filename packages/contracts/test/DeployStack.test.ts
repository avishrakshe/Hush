import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { deployHushStack, EERC_DECIMALS } from "../scripts/lib/deployStack";

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
});
