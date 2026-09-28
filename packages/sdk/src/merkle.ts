import { type Hex, concat, encodeAbiParameters, hexToBigInt, keccak256, parseAbiParameters } from "viem";
import type { SignedVoucher } from "./types.js";

const LEAF_PARAMS = parseAbiParameters("address, address, uint256, uint64, bytes32, uint64, bytes");

/** Leaf values in LEAF_TYPES order (what the facilitator feeds to StandardMerkleTree). */
export function voucherLeafValues({ voucher: v, signature }: SignedVoucher) {
  return [v.agent, v.provider, v.cumulativeSpent, v.nonce, v.requestHash, v.expiry, signature] as const;
}

/**
 * keccak256(keccak256(abi.encode(voucher fields, signature))) — identical to HushLedger.voucherLeaf and
 * OZ StandardMerkleTree. The double hash is the second-preimage guard: no voucher can hash to an internal node.
 */
export function voucherLeaf(signed: SignedVoucher): Hex {
  return keccak256(keccak256(encodeAbiParameters(LEAF_PARAMS, voucherLeafValues(signed))));
}

/** OZ MerkleProof.processProof: commutative keccak of sorted pairs. Lets clients check proofs without a node. */
export function processProof(leaf: Hex, proof: readonly Hex[]): Hex {
  let computed = leaf;
  for (const sibling of proof) {
    computed =
      hexToBigInt(computed) < hexToBigInt(sibling) ? keccak256(concat([computed, sibling])) : keccak256(concat([sibling, computed]));
  }
  return computed;
}

export const verifyMerkleProof = (root: Hex, leaf: Hex, proof: readonly Hex[]) =>
  processProof(leaf, proof).toLowerCase() === root.toLowerCase();
