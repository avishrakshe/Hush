import {
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  stringToBytes,
} from "viem";
import { AGENT_CONSENT_TYPES } from "./constants.js";
import type { TypedDataSigner } from "./eip712.js";
import { receiptToJson } from "./eip712.js";
import { hushRegistryAbi } from "./generated/abis.js";
import type { SignedCreditReceipt } from "./types.js";

type Writer = WalletClient<Transport, Chain, Account>;
type Reader = Pick<PublicClient, "waitForTransactionReceipt" | "readContract">;

async function send(reader: Reader, hash: Hex, label: string) {
  const r = await reader.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  return hash;
}

/** EIP-712 consent an agent signs so `owner` can register it (blocks griefing freezes by strangers). */
export function signAgentConsent(agent: TypedDataSigner, args: { registry: Address; chainId: number; owner: Address; deadline: bigint }) {
  return agent.signTypedData({
    domain: { name: "HushRegistry", version: "1", chainId: args.chainId, verifyingContract: args.registry },
    types: AGENT_CONSENT_TYPES,
    primaryType: "AgentConsent",
    message: { agent: agent.address, owner: args.owner, deadline: args.deadline },
  });
}

export async function registerAgent(
  owner: Writer,
  reader: Reader,
  args: { registry: Address; agent: Address; metadataURI: string; deadline: bigint; consent: Hex },
) {
  const hash = await owner.writeContract({
    address: args.registry,
    abi: hushRegistryAbi,
    functionName: "registerAgent",
    args: [args.agent, args.metadataURI, args.deadline, args.consent],
  });
  return send(reader, hash, "registerAgent");
}

/** Kill switch: facilitators reject every payment from a frozen agent from the next call on. Owner only. */
export async function freezeAgent(owner: Writer, reader: Reader, registry: Address, agent: Address) {
  return send(reader, await owner.writeContract({ address: registry, abi: hushRegistryAbi, functionName: "freezeAgent", args: [agent] }), "freezeAgent");
}

export async function unfreezeAgent(owner: Writer, reader: Reader, registry: Address, agent: Address) {
  return send(reader, await owner.writeContract({ address: registry, abi: hushRegistryAbi, functionName: "unfreezeAgent", args: [agent] }), "unfreezeAgent");
}

/** The provider advertises the BabyJubJub key its top-ups are encrypted to (checked against the eERC Registrar). */
export async function registerProvider(
  provider: Writer,
  reader: Reader,
  args: { registry: Address; name: string; endpoint: string; pricePerCall: bigint; eercPublicKey: readonly bigint[] },
) {
  const [x, y] = args.eercPublicKey;
  if (x === undefined || y === undefined) throw new Error("eercPublicKey must be [x, y]");
  const key = encodeAbiParameters(parseAbiParameters("uint256, uint256"), [x, y]);
  const hash = await provider.writeContract({
    address: args.registry,
    abi: hushRegistryAbi,
    functionName: "registerProvider",
    args: [args.name, args.endpoint, args.pricePerCall, key],
  });
  return send(reader, hash, "registerProvider");
}

export async function setFacilitator(provider: Writer, reader: Reader, registry: Address, facilitator: Address) {
  return send(reader, await provider.writeContract({ address: registry, abi: hushRegistryAbi, functionName: "setFacilitator", args: [facilitator] }), "setFacilitator");
}

/** Hash that anchors off-chain evidence (e.g. a signed CreditReceipt the provider didn't honour) in a flag. */
export function evidenceHash(evidence: string | SignedCreditReceipt): Hex {
  const text = typeof evidence === "string" ? evidence : JSON.stringify({ receipt: receiptToJson(evidence.receipt), signature: evidence.signature });
  return keccak256(stringToBytes(text));
}

/** Public reputation signal against a provider. One flag per (flagger, provider, evidence). */
export async function flagProvider(flagger: Writer, reader: Reader, registry: Address, provider: Address, evidence: string | SignedCreditReceipt) {
  const hash = evidenceHash(evidence);
  const txHash = await send(
    reader,
    await flagger.writeContract({ address: registry, abi: hushRegistryAbi, functionName: "flagProvider", args: [provider, hash] }),
    "flagProvider",
  );
  return { txHash, evidenceHash: hash };
}
