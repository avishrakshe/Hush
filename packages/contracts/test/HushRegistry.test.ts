import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import type { HushRegistry } from "../typechain-types";

const PROVIDER_KEY = [123n, 456n] as const;
const encodeKey = (k: readonly [bigint, bigint]) => ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], k);

describe("HushRegistry", () => {
  async function deployFixture() {
    const [deployer, provider, owner, agent, stranger, facilitator] = await ethers.getSigners();
    const eercRegistrar = await ethers.deployContract("MockEERCRegistrar");
    const registry = await ethers.deployContract("HushRegistry", [await eercRegistrar.getAddress()]);
    await eercRegistrar.setUserPublicKey(provider!.address, [...PROVIDER_KEY]);
    return { registry, eercRegistrar, deployer: deployer!, provider: provider!, owner: owner!, agent: agent!, stranger: stranger!, facilitator: facilitator! };
  }

  async function signConsent(registry: HushRegistry, agentSigner: Awaited<ReturnType<typeof ethers.getSigners>>[number], ownerAddr: string, deadline: bigint) {
    const { chainId } = await ethers.provider.getNetwork();
    return agentSigner.signTypedData(
      { name: "HushRegistry", version: "1", chainId, verifyingContract: await registry.getAddress() },
      { AgentConsent: [{ name: "agent", type: "address" }, { name: "owner", type: "address" }, { name: "deadline", type: "uint256" }] },
      { agent: agentSigner.address, owner: ownerAddr, deadline },
    );
  }

  async function withProviderFixture() {
    const f = await deployFixture();
    await f.registry.connect(f.provider).registerProvider("PriceFeed", "https://feed.example/api", 20_000n, encodeKey(PROVIDER_KEY));
    return f;
  }

  async function withAgentFixture() {
    const f = await withProviderFixture();
    const deadline = BigInt(await time.latest()) + 3600n;
    const sig = await signConsent(f.registry, f.agent, f.owner.address, deadline);
    await f.registry.connect(f.owner).registerAgent(f.agent.address, "ipfs://veil", deadline, sig);
    return f;
  }

  describe("providers", () => {
    it("registers a provider whose key matches the eERC Registrar", async () => {
      const { registry, provider } = await loadFixture(deployFixture);
      await expect(registry.connect(provider).registerProvider("PriceFeed", "https://feed.example/api", 20_000n, encodeKey(PROVIDER_KEY)))
        .to.emit(registry, "ProviderRegistered")
        .withArgs(provider.address, "PriceFeed", "https://feed.example/api", 20_000n, encodeKey(PROVIDER_KEY));

      const p = await registry.getProvider(provider.address);
      expect(p.name).to.equal("PriceFeed");
      expect(p.pricePerCall).to.equal(20_000n);
      expect(p.eercPublicKey).to.equal(encodeKey(PROVIDER_KEY));
      expect(await registry.isProvider(provider.address)).to.equal(true);
      expect(await registry.getProviders()).to.deep.equal([provider.address]);
    });

    it("rejects double registration, empty names and malformed keys", async () => {
      const { registry, provider } = await loadFixture(withProviderFixture);
      await expect(registry.connect(provider).registerProvider("X", "e", 1n, encodeKey(PROVIDER_KEY))).to.be.revertedWithCustomError(registry, "AlreadyRegistered");

      const { registry: fresh, provider: p2 } = await loadFixture(deployFixture);
      await expect(fresh.connect(p2).registerProvider("", "e", 1n, encodeKey(PROVIDER_KEY))).to.be.revertedWithCustomError(fresh, "EmptyName");
      await expect(fresh.connect(p2).registerProvider("X", "e", 1n, "0x1234")).to.be.revertedWithCustomError(fresh, "InvalidPublicKey");
    });

    it("requires eERC registration and the exact eERC key", async () => {
      const { registry, stranger, provider } = await loadFixture(deployFixture);
      await expect(registry.connect(stranger).registerProvider("X", "e", 1n, encodeKey(PROVIDER_KEY))).to.be.revertedWithCustomError(registry, "NotRegistered");
      await expect(registry.connect(provider).registerProvider("X", "e", 1n, encodeKey([1n, 2n]))).to.be.revertedWithCustomError(registry, "EercKeyMismatch");
    });

    it("skips the eERC check when deployed without a registrar", async () => {
      const [, anyone] = await ethers.getSigners();
      const registry = await ethers.deployContract("HushRegistry", [ethers.ZeroAddress]);
      await expect(registry.connect(anyone!).registerProvider("X", "e", 1n, encodeKey([1n, 2n]))).to.emit(registry, "ProviderRegistered");
    });

    it("lets only the provider update itself and set its facilitator", async () => {
      const { registry, provider, facilitator, stranger } = await loadFixture(withProviderFixture);
      await expect(registry.connect(stranger).updateProvider("e", 1n)).to.be.revertedWithCustomError(registry, "NotRegistered");
      await expect(registry.connect(provider).updateProvider("https://new", 30_000n)).to.emit(registry, "ProviderUpdated").withArgs(provider.address, "https://new", 30_000n);

      expect(await registry.isAuthorizedCommitter(provider.address, facilitator.address)).to.equal(false);
      await expect(registry.connect(provider).setFacilitator(facilitator.address)).to.emit(registry, "FacilitatorSet").withArgs(provider.address, facilitator.address);
      expect(await registry.isAuthorizedCommitter(provider.address, facilitator.address)).to.equal(true);
      expect(await registry.isAuthorizedCommitter(provider.address, provider.address)).to.equal(true);
      expect(await registry.isAuthorizedCommitter(provider.address, stranger.address)).to.equal(false);
      expect(await registry.isAuthorizedCommitter(stranger.address, stranger.address)).to.equal(false);

      await registry.connect(provider).setFacilitator(ethers.ZeroAddress);
      expect(await registry.isAuthorizedCommitter(provider.address, facilitator.address)).to.equal(false);
    });
  });

  describe("agents", () => {
    it("registers an agent with the agent's EIP-712 consent", async () => {
      const { registry, owner, agent } = await loadFixture(withProviderFixture);
      const deadline = BigInt(await time.latest()) + 3600n;
      const sig = await signConsent(registry, agent, owner.address, deadline);
      expect(await registry.agentConsentDigest(agent.address, owner.address, deadline)).to.equal(
        ethers.TypedDataEncoder.hash(
          { name: "HushRegistry", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await registry.getAddress() },
          { AgentConsent: [{ name: "agent", type: "address" }, { name: "owner", type: "address" }, { name: "deadline", type: "uint256" }] },
          { agent: agent.address, owner: owner.address, deadline },
        ),
      );

      await expect(registry.connect(owner).registerAgent(agent.address, "ipfs://veil", deadline, sig))
        .to.emit(registry, "AgentRegistered")
        .withArgs(agent.address, owner.address, "ipfs://veil");
      const a = await registry.getAgent(agent.address);
      expect(a.owner).to.equal(owner.address);
      expect(a.frozen).to.equal(false);
      expect(await registry.getAgentsByOwner(owner.address)).to.deep.equal([agent.address]);
    });

    it("blocks someone else from claiming an agent (consent bound to the owner)", async () => {
      const { registry, owner, agent, stranger } = await loadFixture(withProviderFixture);
      const deadline = BigInt(await time.latest()) + 3600n;
      const sigForOwner = await signConsent(registry, agent, owner.address, deadline);
      // A front-runner replaying the owner's consent from another account must fail.
      await expect(registry.connect(stranger).registerAgent(agent.address, "x", deadline, sigForOwner)).to.be.revertedWithCustomError(registry, "InvalidConsent");
      // A consent signed by the wrong key must fail.
      const forged = await signConsent(registry, stranger, owner.address, deadline);
      await expect(registry.connect(owner).registerAgent(agent.address, "x", deadline, forged)).to.be.revertedWithCustomError(registry, "InvalidConsent");
    });

    it("rejects expired consent and double registration; allows self-registration", async () => {
      const { registry, owner, agent, stranger } = await loadFixture(withAgentFixture);
      await expect(registry.connect(owner).registerAgent(agent.address, "x", 0n, "0x")).to.be.revertedWithCustomError(registry, "AlreadyRegistered");

      const past = BigInt(await time.latest()) - 1n;
      const sig = await signConsent(registry, stranger, owner.address, past);
      await expect(registry.connect(owner).registerAgent(stranger.address, "x", past, sig)).to.be.revertedWithCustomError(registry, "ConsentExpired");

      await expect(registry.connect(stranger).registerAgent(stranger.address, "self", 0n, "0x")).to.emit(registry, "AgentRegistered").withArgs(stranger.address, stranger.address, "self");
    });

    it("kill switch: only the owner can freeze and unfreeze", async () => {
      const { registry, owner, agent, stranger } = await loadFixture(withAgentFixture);
      expect(await registry.isFrozen(agent.address)).to.equal(false);

      await expect(registry.connect(stranger).freezeAgent(agent.address)).to.be.revertedWithCustomError(registry, "NotAgentOwner");
      await expect(registry.connect(owner).freezeAgent(agent.address)).to.emit(registry, "AgentFrozen").withArgs(agent.address, owner.address);
      expect(await registry.isFrozen(agent.address)).to.equal(true);

      await expect(registry.connect(stranger).unfreezeAgent(agent.address)).to.be.revertedWithCustomError(registry, "NotAgentOwner");
      await expect(registry.connect(owner).unfreezeAgent(agent.address)).to.emit(registry, "AgentUnfrozen").withArgs(agent.address, owner.address);
      expect(await registry.isFrozen(agent.address)).to.equal(false);

      await expect(registry.connect(owner).freezeAgent(stranger.address)).to.be.revertedWithCustomError(registry, "NotRegistered");
    });
  });

  describe("flagging", () => {
    it("counts one flag per (flagger, provider, evidence)", async () => {
      const { registry, provider, owner, stranger } = await loadFixture(withProviderFixture);
      const evidenceA = ethers.id("receipt-0x01 not honoured");
      const evidenceB = ethers.id("receipt-0x02 not honoured");

      await expect(registry.connect(owner).flagProvider(provider.address, evidenceA)).to.emit(registry, "ProviderFlagged").withArgs(provider.address, owner.address, evidenceA, 1);
      await expect(registry.connect(owner).flagProvider(provider.address, evidenceA)).to.be.revertedWithCustomError(registry, "AlreadyFlagged");
      await expect(registry.connect(owner).flagProvider(provider.address, evidenceB)).to.emit(registry, "ProviderFlagged").withArgs(provider.address, owner.address, evidenceB, 2);
      await expect(registry.connect(stranger).flagProvider(provider.address, evidenceA)).to.emit(registry, "ProviderFlagged").withArgs(provider.address, stranger.address, evidenceA, 3);

      expect((await registry.getProvider(provider.address)).flagCount).to.equal(3);
      expect(await registry.hasFlagged(owner.address, provider.address, evidenceA)).to.equal(true);
      expect(await registry.hasFlagged(stranger.address, provider.address, evidenceB)).to.equal(false);
    });

    it("rejects unknown providers and empty evidence", async () => {
      const { registry, provider, owner, stranger } = await loadFixture(withProviderFixture);
      await expect(registry.connect(owner).flagProvider(stranger.address, ethers.id("x"))).to.be.revertedWithCustomError(registry, "NotRegistered");
      await expect(registry.connect(owner).flagProvider(provider.address, ethers.ZeroHash)).to.be.revertedWithCustomError(registry, "EmptyEvidence");
    });
  });
});
