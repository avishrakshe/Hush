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
// Log scans in RPC-sized ranges (Fuji's public RPC caps getLogs at 100 blocks).
export { MAX_LOG_RANGE, blockRanges, getLogsChunked, type BlockRange } from "./logs.js";
export { formatShares, parseShares, alphaDomain, signalFromJson, signalToJson, signalTyped } from "./alpha.js";
// Proof of Alpha verification is viem-only, so a browser can check a provider's record itself.
export {
  AlphaChain,
  epochDigest,
  epochOf,
  leafHash,
  leafTime,
  nextHead,
  verifyProof,
  commitDeadline,
  gradeSignal,
  summarize,
  checkProvider,
  chooseProvider,
  type AlphaPolicy,
  type ProviderAlphaInfo,
  type ProviderCheck,
  type AlphaClaims,
  type AlphaLeaf,
  type AlphaLeafKind,
  type AlphaProof,
  type GradedCall,
  type ProofReport,
  type VerifyOptions,
} from "./proofOfAlpha.js";
// So are trade reports (an agent's desk-signed record, checked against HushLedger).
export { verifyTradeReport, type TradeReport, type TradeReportFill, type TradeReportResult, type TickerSummary } from "./tradeReport.js";
export { DIRECTION } from "./constants.js";
export type { SignalRecord, SignalRecordJson } from "./types.js";
