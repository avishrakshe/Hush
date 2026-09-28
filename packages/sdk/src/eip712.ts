import {
  type Address,
  type Hex,
  type PublicClient,
  type TypedDataDomain,
  hashTypedData,
  isAddressEqual,
  keccak256,
  recoverTypedDataAddress,
  stringToBytes,
} from "viem";
import { CREDIT_RECEIPT_TYPES, EIP712_NAME, EIP712_VERSION, REFUND_REQUEST_TYPES, VOUCHER_TYPES } from "./constants.js";
import type {
  CreditReceipt,
  CreditReceiptJson,
  RefundRequest,
  RefundRequestJson,
  Voucher,
  VoucherJson,
} from "./types.js";

/**
 * Anything that can sign EIP-712 typed data — a viem LocalAccount (`privateKeyToAccount`) works as-is; for a browser
 * wallet pass `{ address, signTypedData: (a) => walletClient.signTypedData({ account, ...a }) }`.
 * Same loose shape x402's ClientEvmSigner uses, so one object serves both.
 */
export interface TypedDataSigner {
  readonly address: Address;
  signTypedData(args: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<Hex>;
}

/** Hush EIP-712 domain. verifyingContract = HushLedger binds signatures to one deployment on one chain. */
export function hushDomain(chainId: number, hushLedger: Address): TypedDataDomain {
  return { name: EIP712_NAME, version: EIP712_VERSION, chainId, verifyingContract: hushLedger };
}

/** Binds a voucher to the exact resource it paid for (the agent keeps this for its own audit trail). */
export const requestHashFor = (resourceUrl: string): Hex => keccak256(stringToBytes(resourceUrl));

// ─── vouchers ───

export function signVoucher(signer: TypedDataSigner, domain: TypedDataDomain, voucher: Voucher): Promise<Hex> {
  return signer.signTypedData({ domain: { ...domain }, types: VOUCHER_TYPES, primaryType: "Voucher", message: { ...voucher } });
}

export const hashVoucher = (domain: TypedDataDomain, voucher: Voucher): Hex =>
  hashTypedData({ domain, types: VOUCHER_TYPES, primaryType: "Voucher", message: voucher });

export const recoverVoucherSigner = (domain: TypedDataDomain, voucher: Voucher, signature: Hex): Promise<Address> =>
  recoverTypedDataAddress({ domain, types: VOUCHER_TYPES, primaryType: "Voucher", message: voucher, signature });

// ─── credit receipts ───

export function signCreditReceipt(signer: TypedDataSigner, domain: TypedDataDomain, receipt: CreditReceipt): Promise<Hex> {
  return signer.signTypedData({
    domain: { ...domain },
    types: CREDIT_RECEIPT_TYPES,
    primaryType: "CreditReceipt",
    message: { ...receipt },
  });
}

export const recoverCreditReceiptSigner = (domain: TypedDataDomain, receipt: CreditReceipt, signature: Hex) =>
  recoverTypedDataAddress({ domain, types: CREDIT_RECEIPT_TYPES, primaryType: "CreditReceipt", message: receipt, signature });

/** A receipt is only worth something if the provider named in it signed it. */
export async function isValidCreditReceipt(domain: TypedDataDomain, receipt: CreditReceipt, signature: Hex): Promise<boolean> {
  try {
    return isAddressEqual(await recoverCreditReceiptSigner(domain, receipt, signature), receipt.provider);
  } catch {
    return false;
  }
}

// ─── refund requests ───

export function signRefundRequest(signer: TypedDataSigner, domain: TypedDataDomain, request: RefundRequest): Promise<Hex> {
  return signer.signTypedData({
    domain: { ...domain },
    types: REFUND_REQUEST_TYPES,
    primaryType: "RefundRequest",
    message: { ...request },
  });
}

export const recoverRefundRequestSigner = (domain: TypedDataDomain, request: RefundRequest, signature: Hex) =>
  recoverTypedDataAddress({ domain, types: REFUND_REQUEST_TYPES, primaryType: "RefundRequest", message: request, signature });

/**
 * Signature check that also accepts ERC-1271 smart-account agents when a public client is available
 * (viem's verifyTypedData handles EOA, 1271 and 6492). Falls back to plain ECDSA recovery.
 */
export async function verifyTypedSignature(
  publicClient: Pick<PublicClient, "verifyTypedData"> | undefined,
  args: {
    address: Address;
    domain: TypedDataDomain;
    types: Record<string, readonly { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
    signature: Hex;
  },
): Promise<boolean> {
  try {
    if (publicClient) {
      // biome-ignore lint: viem's generic typed-data params are narrower than our runtime shape
      return await publicClient.verifyTypedData(args as any);
    }
    const recovered = await recoverTypedDataAddress(args as Parameters<typeof recoverTypedDataAddress>[0]);
    return isAddressEqual(recovered, args.address);
  } catch {
    return false;
  }
}

// ─── JSON codecs ───

export const voucherToJson = (v: Voucher): VoucherJson => ({
  agent: v.agent,
  provider: v.provider,
  cumulativeSpent: v.cumulativeSpent.toString(),
  nonce: v.nonce.toString(),
  requestHash: v.requestHash,
  expiry: v.expiry.toString(),
});

export const voucherFromJson = (v: VoucherJson): Voucher => ({
  agent: v.agent,
  provider: v.provider,
  cumulativeSpent: BigInt(v.cumulativeSpent),
  nonce: BigInt(v.nonce),
  requestHash: v.requestHash,
  expiry: BigInt(v.expiry),
});

export const receiptToJson = (r: CreditReceipt): CreditReceiptJson => ({
  agent: r.agent,
  provider: r.provider,
  creditedTotal: r.creditedTotal.toString(),
  topupTxHash: r.topupTxHash,
  issuedAt: r.issuedAt.toString(),
});

export const receiptFromJson = (r: CreditReceiptJson): CreditReceipt => ({
  agent: r.agent,
  provider: r.provider,
  creditedTotal: BigInt(r.creditedTotal),
  topupTxHash: r.topupTxHash,
  issuedAt: BigInt(r.issuedAt),
});

export const refundRequestToJson = (r: RefundRequest): RefundRequestJson => ({
  agent: r.agent,
  provider: r.provider,
  deadline: r.deadline.toString(),
});

export const refundRequestFromJson = (r: RefundRequestJson): RefundRequest => ({
  agent: r.agent,
  provider: r.provider,
  deadline: BigInt(r.deadline),
});
