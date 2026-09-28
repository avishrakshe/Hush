import { type Address, type Hex, type Log, type PublicClient, decodeFunctionData, isAddressEqual, parseEventLogs } from "viem";
import { TRANSFER_SIGNALS } from "../constants.js";
import { encryptedErcAbi } from "../generated/abis.js";
import type { HushContracts } from "../types.js";

/** An eERC private transfer, read back from chain. Contains no plaintext amount — only ciphertexts. */
export interface EercTransfer {
  txHash: Hex;
  blockNumber: bigint;
  from: Address;
  to: Address;
  tokenId: bigint;
  /** Groth16 public signals (32). Amount ciphertexts for sender, receiver and auditor live in here. */
  publicSignals: readonly bigint[];
  logs: readonly Log[];
}

/** Fetches and decodes a successful `EncryptedERC.transfer` transaction. Throws for anything else. */
export async function readEercTransfer(
  publicClient: Pick<PublicClient, "getTransaction" | "getTransactionReceipt">,
  contracts: Pick<HushContracts, "encryptedErc">,
  txHash: Hex,
): Promise<EercTransfer> {
  const [tx, receipt] = await Promise.all([
    publicClient.getTransaction({ hash: txHash }),
    publicClient.getTransactionReceipt({ hash: txHash }),
  ]);
  if (receipt.status !== "success") throw new Error(`transaction ${txHash} reverted`);
  if (!tx.to || !isAddressEqual(tx.to, contracts.encryptedErc)) throw new Error(`${txHash} is not an eERC transaction`);

  const { functionName, args } = decodeFunctionData({ abi: encryptedErcAbi, data: tx.input });
  if (functionName !== "transfer" || !args) throw new Error(`${txHash} is not an eERC private transfer`);
  const [to, tokenId, proof] = args as unknown as [Address, bigint, { publicSignals: readonly bigint[] }];

  return {
    txHash,
    blockNumber: receipt.blockNumber,
    from: tx.from,
    to,
    tokenId,
    publicSignals: proof.publicSignals,
    logs: receipt.logs,
  };
}

export const receiverPct = (t: Pick<EercTransfer, "publicSignals">) =>
  t.publicSignals.slice(TRANSFER_SIGNALS.receiverPct[0], TRANSFER_SIGNALS.receiverPct[1]);

export const auditorPct = (t: Pick<EercTransfer, "publicSignals">) =>
  t.publicSignals.slice(TRANSFER_SIGNALS.auditorPct[0], TRANSFER_SIGNALS.auditorPct[1]);

/** Whether the transfer carries an eERC encrypted-metadata message (PrivateMessage event). */
export function hasPrivateMessage(t: Pick<EercTransfer, "logs">, contracts: Pick<HushContracts, "encryptedErc">): boolean {
  return (
    parseEventLogs({ abi: encryptedErcAbi, eventName: "PrivateMessage", logs: [...t.logs] }).filter((l) =>
      isAddressEqual(l.address, contracts.encryptedErc),
    ).length > 0
  );
}
