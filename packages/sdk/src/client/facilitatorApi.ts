import type { Address, Hex } from "viem";
import type { CreditStateJson, RefundRequestJson, RefundResponse, TopUpResponse, VoucherProofJson } from "../types.js";

export class FacilitatorApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FacilitatorApiError";
  }
}

/** Typed client for the Hush-specific facilitator endpoints (top-ups, credit, refunds, proofs). */
export class HushFacilitatorApi {
  constructor(
    readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchFn(new URL(path, this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`), {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (!res.ok) throw new FacilitatorApiError(res.status, body.code ?? "error", body.error ?? `${res.status} ${res.statusText}`);
    return body as T;
  }

  credit(agent: Address, provider: Address) {
    return this.request<CreditStateJson>(`credit/${agent}?provider=${provider}`);
  }

  /** Ask the provider's facilitator to decrypt a private top-up and credit it. Returns a provider-signed receipt. */
  topUp(agent: Address, txHash: Hex) {
    return this.request<TopUpResponse>("topup", { method: "POST", body: JSON.stringify({ agent, txHash }) });
  }

  refund(request: RefundRequestJson, signature: Hex) {
    return this.request<RefundResponse>("refund", { method: "POST", body: JSON.stringify({ request, signature }) });
  }

  /** Merkle proof for a consumed voucher; 404 until the voucher's batch is committed on-chain. */
  async proof(leaf: Hex): Promise<VoucherProofJson | null> {
    try {
      return await this.request<VoucherProofJson>(`proof/${leaf}`);
    } catch (err) {
      if (err instanceof FacilitatorApiError && err.status === 404) return null;
      throw err;
    }
  }
}
