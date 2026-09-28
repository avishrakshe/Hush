import { HTTPFacilitatorClient } from "@x402/core/server";
import type { Network, Price } from "@x402/core/types";
import { convertToTokenAmount } from "@x402/core/utils";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import type { RequestHandler } from "express";
import type { Address } from "viem";
import { EXACT, HUSH_CREDIT, HUSH_DIRECT, USDC_DECIMALS, toCaip2 } from "../constants.js";
import type { HushContracts } from "../types.js";
import { HushCreditServerScheme, HushDirectServerScheme } from "./schemes.js";

export type HushScheme = typeof EXACT | typeof HUSH_CREDIT | typeof HUSH_DIRECT;

export interface HushRoute {
  /** "$0.02", 0.02, or { amount: "20000", asset } (USDC atomic). */
  price: Price;
  description?: string;
  mimeType?: string;
}

export interface HushMiddlewareOptions {
  /** Provider address that receives payments (and whose eERC key receives top-ups). */
  payTo: Address;
  contracts: HushContracts;
  /** Facilitator URL the provider server calls for /verify and /settle. */
  facilitatorUrl: string;
  /** Facilitator URL advertised to agents for top-ups and proofs (defaults to facilitatorUrl). */
  publicFacilitatorUrl?: string;
  /** e.g. { "GET /api/feed": { price: "$0.02" } } */
  routes: Record<string, HushRoute>;
  /** Offered schemes, in preference order. Default: all three. */
  schemes?: HushScheme[];
  /** Smallest top-up accepted for hush-credit (USDC atomic). Default 1 USDC. */
  minTopUp?: bigint;
  creditTtlSeconds?: number;
  /** EIP-712 domain of the USDC token, used by x402 `exact` (EIP-3009). Default: Hush MockUSDC. */
  usdcDomain?: { name: string; version: string };
}

/**
 * One line gives an Express provider all three schemes:
 *   app.use(hushMiddleware({ payTo, contracts, facilitatorUrl, routes: { "GET /api/feed": { price: "$0.02" } } }))
 * Built on the official x402 v2 resource server, so standard x402 clients can still pay with `exact`.
 */
export function hushMiddleware(opts: HushMiddlewareOptions): RequestHandler {
  const network: Network = toCaip2(opts.contracts.chainId);
  const schemes = opts.schemes ?? [HUSH_CREDIT, EXACT, HUSH_DIRECT];
  const usdcDomain = opts.usdcDomain ?? { name: "Hush Test USDC", version: "1" };

  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: opts.facilitatorUrl }));
  if (schemes.includes(EXACT)) {
    // "$0.02" → the deployment's USDC, with the EIP-712 domain EIP-3009 signatures need.
    const exact = new ExactEvmScheme().registerMoneyParser(async (amount) => ({
      amount: convertToTokenAmount(String(amount), USDC_DECIMALS),
      asset: opts.contracts.usdc,
      extra: { name: usdcDomain.name, version: usdcDomain.version },
    }));
    server.register(network, exact);
  }
  if (schemes.includes(HUSH_CREDIT)) {
    server.register(
      network,
      new HushCreditServerScheme({
        contracts: opts.contracts,
        facilitatorUrl: opts.publicFacilitatorUrl ?? opts.facilitatorUrl,
        minTopUp: opts.minTopUp,
        creditTtlSeconds: opts.creditTtlSeconds,
      }),
    );
  }
  if (schemes.includes(HUSH_DIRECT)) server.register(network, new HushDirectServerScheme({ contracts: opts.contracts }));

  const routes = Object.fromEntries(
    Object.entries(opts.routes).map(([route, cfg]) => [
      route,
      {
        accepts: schemes.map((scheme) => ({ scheme, price: cfg.price, network, payTo: opts.payTo })),
        description: cfg.description,
        mimeType: cfg.mimeType ?? "application/json",
      },
    ]),
  );
  return paymentMiddleware(routes, server);
}
