import { formatUnits } from "viem";
import { USDC_DECIMALS } from "./constants.js";

/**
 * x402 prices and vouchers are in USDC atomic units (6 dp) — the unit every x402 tool understands.
 * eERC balances use fewer decimals (2 on the reference deployment) to keep proofs/decryption cheap,
 * so 1 eERC unit (0.01 hUSDC) = 10^4 USDC atomic units.
 */
export function eercScale(eercDecimals: number): bigint {
  if (eercDecimals > USDC_DECIMALS) throw new Error(`eERC decimals ${eercDecimals} > USDC decimals`);
  return 10n ** BigInt(USDC_DECIMALS - eercDecimals);
}

/** USDC atomic → eERC units, rounding down (the remainder stays as credit). */
export function atomicToEerc(atomic: bigint, eercDecimals: number): bigint {
  return atomic / eercScale(eercDecimals);
}

export function eercToAtomic(units: bigint, eercDecimals: number): bigint {
  return units * eercScale(eercDecimals);
}

/** USDC atomic → eERC units; throws unless exactly representable (used for top-up / direct-payment amounts). */
export function atomicToEercExact(atomic: bigint, eercDecimals: number): bigint {
  const scale = eercScale(eercDecimals);
  if (atomic % scale !== 0n) {
    throw new Error(`${formatUsdc(atomic)} is not a multiple of the eERC unit (${formatUsdc(scale)})`);
  }
  return atomic / scale;
}

export const formatUsdc = (atomic: bigint) => `${formatUnits(atomic, USDC_DECIMALS)} USDC`;
export const formatHusdc = (atomic: bigint) => `${formatUnits(atomic, USDC_DECIMALS)} hUSDC`;
