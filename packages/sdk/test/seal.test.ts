import { describe, expect, it } from "vitest";
import { EercAccount, type HushContracts, isRecipient, seal, unseal } from "../src/index.js";

const contracts = { chainId: 43113, eercDecimals: 2 } as HushContracts;

/** Offline eERC account: real BabyJubJub/Poseidon crypto from the official SDK, no chain access needed. */
const account = (address: `0x${string}`, decryptionKey: string) =>
  new EercAccount({
    publicClient: {} as never,
    walletClient: { account: { address } } as never,
    contracts,
    circuits: {} as never,
    decryptionKey,
  });

const agent = account("0x3904E8aB9977C33C6E5033a439a8b059948DFA65", "0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0");
const owner = account("0x5E1B893014F3C34337e1F1cD0440ae3C83AA31D0", "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809");
const auditor = account("0x2963cc7a873EC23BBd298EE79115a377275f6319", "2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b");
const outsider = account("0x11636AC8e8Ae873E1F240d0B6d948d9Ea4d54cfD", "3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c");

describe("seal / unseal (Poseidon-ECDH key wrap to eERC keys + AES-256-GCM)", () => {
  it("only the owner and the auditor can open an agent's sealed event", async () => {
    const event = JSON.stringify({ type: "payment", amount: "20000", resource: "https://provider/api/feed", nonce: 7 });
    const sealed = await seal(agent, [owner.publicKey, auditor.publicKey], event);

    expect(sealed.ciphertext).not.toContain("payment");
    expect(sealed.recipients).toHaveLength(2);
    expect(await unseal(owner, sealed)).toBe(event);
    expect(await unseal(auditor, sealed)).toBe(event);
    expect(isRecipient(outsider, sealed)).toBe(false);
    await expect(unseal(outsider, sealed)).rejects.toThrow(/not a recipient/);
  });

  it("detects tampering (AES-GCM authentication)", async () => {
    const sealed = await seal(agent, [owner.publicKey], "hello owner");
    const last = sealed.ciphertext.slice(-2) === "00" ? "01" : "00";
    await expect(unseal(owner, { ...sealed, ciphertext: `${sealed.ciphertext.slice(0, -2)}${last}` as `0x${string}` })).rejects.toThrow();
  });
});
