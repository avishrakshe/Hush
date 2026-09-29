/**
 * Browser-safe subpath (`@hush/x402/contracts`): ABIs and public deployments only. The root entry also exports the
 * eERC account, which drags in snarkjs and the eERC SDK — too heavy for a landing page or a server route.
 */
export { encryptedErcAbi, registrarAbi, hushRegistryAbi, hushLedgerAbi, mockUsdcAbi } from "./generated/abis.js";
export { HUSH_DEPLOYMENTS } from "./generated/deployments.js";
export type { HushContracts } from "./types.js";
