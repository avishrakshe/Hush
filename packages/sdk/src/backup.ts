import { type Address, bytesToHex, hexToBytes } from "viem";

/**
 * Owner-encrypted backup of an agent's eERC decryption key.
 *
 * The key is normally re-derivable from the agent wallet's signature, so the wallet is the primary backup. This
 * covers the other cases (ephemeral agent keys, hardware wallets with non-deterministic signing, custody hand-over).
 * Losing BOTH the wallet and this backup means the encrypted balance can never be decrypted or spent again.
 *
 * Format: PBKDF2-SHA256 (600k iterations) → AES-256-GCM, via WebCrypto (Node ≥ 20 and browsers).
 */
export interface KeyBackup {
  v: 1;
  address: Address;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: `0x${string}`;
  iv: `0x${string}`;
  ciphertext: `0x${string}`;
}

const ITERATIONS = 600_000;
const subtle = () => globalThis.crypto.subtle;

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number) {
  const base = await subtle().importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt), iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function exportKeyBackup(decryptionKey: string, address: Address, passphrase: string): Promise<KeyBackup> {
  if (passphrase.length < 12) throw new Error("use a passphrase of at least 12 characters");
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  // The wallet address is bound as AES-GCM additional data: a backup can't be passed off as another agent's.
  const ciphertext = await subtle().encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(address.toLowerCase()) },
    key,
    new TextEncoder().encode(decryptionKey),
  );
  return {
    v: 1,
    address,
    kdf: "PBKDF2-SHA256",
    iterations: ITERATIONS,
    salt: bytesToHex(salt),
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(new Uint8Array(ciphertext)),
  };
}

/** Returns the decryption key; pass it as `decryptionKey` to EercAccount. Throws on a wrong passphrase. */
export async function importKeyBackup(backup: KeyBackup, passphrase: string): Promise<string> {
  if (backup.v !== 1 || backup.kdf !== "PBKDF2-SHA256") throw new Error("unsupported backup format");
  const key = await deriveKey(passphrase, hexToBytes(backup.salt), backup.iterations);
  try {
    const plain = await subtle().decrypt(
      { name: "AES-GCM", iv: new Uint8Array(hexToBytes(backup.iv)), additionalData: new TextEncoder().encode(backup.address.toLowerCase()) },
      key,
      new Uint8Array(hexToBytes(backup.ciphertext)),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error("wrong passphrase or corrupted backup");
  }
}
