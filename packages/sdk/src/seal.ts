import { type Hex, bytesToHex, hexToBytes, pad, toHex } from "viem";
import type { EercAccount } from "./eerc/account.js";

/**
 * Encrypted message addressed to one or more eERC public keys (e.g. an agent's owner and the eERC auditor).
 *
 * Hybrid construction: a fresh AES-256-GCM key encrypts the payload; the key is split into two 128-bit halves and each
 * half is wrapped with eERC's own Poseidon-ECDH PCT to every recipient's BabyJubJub key. Recipients open it with the
 * eERC key they already have — no new key material, and the same primitive eERC uses for encrypted amounts.
 */
export interface Sealed {
  v: 1;
  alg: "poseidon-ecdh+aes-256-gcm";
  iv: Hex;
  ciphertext: Hex;
  recipients: { publicKey: [Hex, Hex]; key: [Hex[], Hex[]] }[];
}

const subtle = () => globalThis.crypto.subtle;
const hexPct = (pct: bigint[]) => pct.map((x) => toHex(x));

export async function seal(encryptor: EercAccount, recipientKeys: readonly (readonly bigint[])[], plaintext: string): Promise<Sealed> {
  if (recipientKeys.length === 0) throw new Error("seal needs at least one recipient");
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const aes = await subtle().importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(plaintext)));
  const halves = [raw.slice(0, 16), raw.slice(16)].map((b) => BigInt(bytesToHex(b)));

  const recipients = await Promise.all(
    recipientKeys.map(async (pk) => {
      const [k1, k2] = await Promise.all(halves.map((h) => encryptor.encryptPCT(h, pk)));
      return { publicKey: [toHex(pk[0]!), toHex(pk[1]!)] as [Hex, Hex], key: [hexPct(k1!), hexPct(k2!)] as [Hex[], Hex[]] };
    }),
  );
  return { v: 1, alg: "poseidon-ecdh+aes-256-gcm", iv: bytesToHex(iv), ciphertext: bytesToHex(ciphertext), recipients };
}

/** Whether `account` is one of the sealed message's recipients. */
export function isRecipient(account: EercAccount, sealed: Sealed): boolean {
  const [x, y] = account.publicKey;
  return sealed.recipients.some((r) => BigInt(r.publicKey[0]) === x && BigInt(r.publicKey[1]) === y);
}

/** Opens a sealed message with the recipient's eERC account (its decryption key must be initialised). */
export async function unseal(account: EercAccount, sealed: Sealed): Promise<string> {
  const [x, y] = account.publicKey;
  const entry = sealed.recipients.find((r) => BigInt(r.publicKey[0]) === x && BigInt(r.publicKey[1]) === y);
  if (!entry) throw new Error("this eERC key is not a recipient of the sealed message");
  const raw = new Uint8Array(32);
  entry.key.forEach((pct, i) => raw.set(hexToBytes(pad(toHex(account.decryptPCT(pct.map((v) => BigInt(v)))), { size: 16 })), i * 16));
  const aes = await subtle().importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const plain = await subtle().decrypt(
    { name: "AES-GCM", iv: new Uint8Array(hexToBytes(sealed.iv)) },
    aes,
    new Uint8Array(hexToBytes(sealed.ciphertext)),
  );
  return new TextDecoder().decode(plain);
}
