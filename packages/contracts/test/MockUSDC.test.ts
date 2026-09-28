import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import type { MockUSDC } from "../typechain-types";

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

describe("MockUSDC (EIP-3009 for the x402 exact baseline)", () => {
  async function deployFixture() {
    const [payer, payee, relayer] = await ethers.getSigners();
    const usdc = await ethers.deployContract("MockUSDC");
    await usdc.mint(payer!.address, 100_000_000n); // 100 USDC
    return { usdc, payer: payer!, payee: payee!, relayer: relayer! };
  }

  async function signAuth(usdc: MockUSDC, from: Signer, to: string, value: bigint, overrides: Partial<{ validAfter: bigint; validBefore: bigint; nonce: string }> = {}) {
    const now = BigInt(await time.latest());
    const auth = {
      from: from.address,
      to,
      value,
      validAfter: overrides.validAfter ?? now - 60n,
      validBefore: overrides.validBefore ?? now + 600n,
      nonce: overrides.nonce ?? ethers.hexlify(ethers.randomBytes(32)),
    };
    const { chainId } = await ethers.provider.getNetwork();
    // Domain built from name()/version(), exactly how x402 clients build it.
    const domain = { name: await usdc.name(), version: await usdc.version(), chainId, verifyingContract: await usdc.getAddress() };
    const signature = await from.signTypedData(domain, AUTH_TYPES, auth);
    return { auth, signature };
  }

  it("has USDC-like metadata and a capped faucet", async () => {
    const { usdc, payee } = await loadFixture(deployFixture);
    expect(await usdc.decimals()).to.equal(6);
    expect(await usdc.symbol()).to.equal("USDC");
    expect(await usdc.version()).to.equal("1");
    const limit = await usdc.FAUCET_LIMIT();
    await expect(usdc.mint(payee.address, limit + 1n)).to.be.revertedWithCustomError(usdc, "FaucetLimitExceeded");
  });

  it("settles transferWithAuthorization via the bytes-signature overload (relayer pays gas)", async () => {
    const { usdc, payer, payee, relayer } = await loadFixture(deployFixture);
    const { auth, signature } = await signAuth(usdc, payer, payee.address, 20_000n);
    await expect(
      usdc.connect(relayer)["transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)"](
        auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, signature,
      ),
    ).to.changeTokenBalances(usdc, [payer, payee], [-20_000n, 20_000n]);
    expect(await usdc.authorizationState(payer.address, auth.nonce)).to.equal(true);
  });

  it("settles via the v/r/s overload and rejects replays", async () => {
    const { usdc, payer, payee, relayer } = await loadFixture(deployFixture);
    const { auth, signature } = await signAuth(usdc, payer, payee.address, 20_000n);
    const { v, r, s } = ethers.Signature.from(signature);
    const call = () =>
      usdc.connect(relayer)["transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)"](
        auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, v, r, s,
      );
    await expect(call()).to.emit(usdc, "AuthorizationUsed").withArgs(payer.address, auth.nonce);
    await expect(call()).to.be.revertedWithCustomError(usdc, "AuthorizationUsedOrCanceled");
  });

  it("accepts yParity (0/1) in place of v", async () => {
    const { usdc, payer, payee } = await loadFixture(deployFixture);
    const { auth, signature } = await signAuth(usdc, payer, payee.address, 1n);
    const sig = ethers.Signature.from(signature);
    await expect(
      usdc["transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)"](
        auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, sig.yParity, sig.r, sig.s,
      ),
    ).to.emit(usdc, "AuthorizationUsed");
  });

  it("enforces the validity window and the signer", async () => {
    const { usdc, payer, payee, relayer } = await loadFixture(deployFixture);
    const now = BigInt(await time.latest());
    const bytesOverload = "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)" as const;

    const early = await signAuth(usdc, payer, payee.address, 1n, { validAfter: now + 1000n, validBefore: now + 2000n });
    await expect(usdc[bytesOverload](early.auth.from, early.auth.to, 1n, early.auth.validAfter, early.auth.validBefore, early.auth.nonce, early.signature)).to.be.revertedWithCustomError(usdc, "AuthorizationNotYetValid");

    const late = await signAuth(usdc, payer, payee.address, 1n, { validAfter: 0n, validBefore: now - 1n });
    await expect(usdc[bytesOverload](late.auth.from, late.auth.to, 1n, late.auth.validAfter, late.auth.validBefore, late.auth.nonce, late.signature)).to.be.revertedWithCustomError(usdc, "AuthorizationExpired");

    const forged = await signAuth(usdc, relayer, payee.address, 1n);
    await expect(usdc[bytesOverload](payer.address, payee.address, 1n, forged.auth.validAfter, forged.auth.validBefore, forged.auth.nonce, forged.signature)).to.be.revertedWithCustomError(usdc, "InvalidSignature");
  });

  it("receiveWithAuthorization must be called by the payee; cancelAuthorization burns the nonce", async () => {
    const { usdc, payer, payee, relayer } = await loadFixture(deployFixture);
    const { chainId } = await ethers.provider.getNetwork();
    const domain = { name: await usdc.name(), version: await usdc.version(), chainId, verifyingContract: await usdc.getAddress() };
    const now = BigInt(await time.latest());
    const auth = { from: payer.address, to: payee.address, value: 5n, validAfter: now - 1n, validBefore: now + 600n, nonce: ethers.id("n1") };
    const sig = await payer.signTypedData(domain, { ReceiveWithAuthorization: AUTH_TYPES.TransferWithAuthorization }, auth);
    const recv = "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)" as const;
    await expect(usdc.connect(relayer)[recv](auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, sig)).to.be.revertedWithCustomError(usdc, "CallerMustBePayee");
    await expect(usdc.connect(payee)[recv](auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, sig)).to.changeTokenBalance(usdc, payee, 5n);

    const nonce = ethers.id("n2");
    const cancelSig = await payer.signTypedData(domain, { CancelAuthorization: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }] }, { authorizer: payer.address, nonce });
    await expect(usdc["cancelAuthorization(address,bytes32,bytes)"](payer.address, nonce, cancelSig)).to.emit(usdc, "AuthorizationCanceled");
    expect(await usdc.authorizationState(payer.address, nonce)).to.equal(true);
  });
});
