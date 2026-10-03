/**
 * Browser-safe subpath (`@hush/x402/contracts`): ABIs and public deployments only. The root entry also exports the
 * eERC account, which drags in snarkjs and the eERC SDK — too heavy for a landing page or a server route.
 */
export {
  encryptedErcAbi,
  registrarAbi,
  hushRegistryAbi,
  hushLedgerAbi,
  mockUsdcAbi,
  mockStockAbi,
  mockStockOracleAbi,
  hushAlphaAbi,
} from "./generated/abis.js";
export { HUSH_DEPLOYMENTS } from "./generated/deployments.js";
export type { HushContracts } from "./types.js";
export { STOCK_TICKERS, type StockTicker, STOCK_DECIMALS, ORACLE_PRICE_DECIMALS, CENTISHARE } from "./constants.js";
export { isStockTicker, tickerToBytes32, bytes32ToTicker, formatPrice, stockContracts, latestRound, roundAt, recentRounds, type OracleRound } from "./stocks.js";
// Reading what an observer sees of an eERC transfer needs only viem + the ABI (no eERC SDK).
export { readEercTransfer, type EercTransfer } from "./eerc/calldata.js";
export { formatShares, parseShares } from "./alpha.js";
