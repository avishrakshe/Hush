import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { HTTPRequestContext } from "@x402/core/server";
import type { PaymentPayload } from "@x402/core/types";

/**
 * The payment a client echoed back on its paid retry, if any. A DynamicPrice runs again on that retry and must return
 * the same requirements the client accepted — for the desk, the quote it was offered — so it reads them from here.
 */
export function echoedPayment(context: HTTPRequestContext): PaymentPayload | undefined {
  if (!context.paymentHeader) return undefined;
  try {
    return decodePaymentSignatureHeader(context.paymentHeader);
  } catch {
    return undefined;
  }
}
