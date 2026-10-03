import { decodePaymentResponseHeader } from "@x402/core/http";
import { type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient, erc20Abi, getAddress, isAddressEqual } from "viem";
import { alphaDomain, formatShares, parseShares, quoteFromJson, quoteToJson, quoteTyped } from "../alpha.js";
import { CENTISHARE, type StockTicker } from "../constants.js";
import { isStockTicker } from "../stocks.js";
import type { HushContracts, SignedFillJson, SignedQuoteJson } from "../types.js";
import type { HushFetch } from "./hushFetch.js";

export interface PublicTrade {
  ticker: StockTicker;
  side: "buy" | "sell";
  /** 0.01-share units. */
  size: bigint;
  /** USDC atomic per share. */
  price: bigint;
  /** USDC atomic. */
  notional: bigint;
  /** buy: the EIP-3009 USDC payment · sell: the desk's USDC payout. */
  paymentTx: Hex;
  /** sell: the seller's token transfer to the desk. (buy deliveries come from the desk.) */
  transferTx?: Hex;
  fill?: SignedFillJson;
}

export interface HushPublicDeskOptions {
  deskUrl: string;
  /** createHushFetch({ mode: "public", ... }) — pays desk quotes with x402 `exact`. */
  pay: HushFetch;
  /** The trader's wallet (sends the token transfer of a public sell). */
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient: Pick<PublicClient, "waitForTransactionReceipt">;
  contracts: HushContracts;
  fetch?: typeof fetch;
}

/**
 * The public baseline at the Hush Desk — what an agent without Hush (Atlas) or a copycat (Mirror) uses. Buys pay a
 * desk quote with x402 `exact` and receive plain tokens; sells transfer plain tokens and receive USDC. Every leg is a
 * public transfer: asset, size, price and direction are readable by anyone watching the chain.
 */
export class HushPublicDesk {
  readonly agent: Address;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: HushPublicDeskOptions) {
    if (!opts.contracts.hushAlpha || !opts.contracts.stocks) throw new Error("HushPublicDesk needs HushAlpha and the mock stocks");
    this.agent = getAddress(opts.walletClient.account.address);
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  private url(path: string) {
    return new URL(path, this.opts.deskUrl.endsWith("/") ? this.opts.deskUrl : `${this.opts.deskUrl}/`).toString();
  }

  private ticker(value: string): StockTicker {
    const t = value.toUpperCase();
    if (!isStockTicker(t) || !this.opts.contracts.stocks?.[t]) throw new Error(`unknown ticker ${value}`);
    return t;
  }

  /** Buy plain tokens: pay the desk's 402 quote with public USDC (EIP-3009); the desk delivers before responding. */
  async buy(ticker: string, shares: string | number): Promise<PublicTrade> {
    const t = this.ticker(ticker);
    const size = parseShares(shares);
    const url = this.url(`rfq?${new URLSearchParams({ ticker: t, side: "buy", size: formatShares(size), agent: this.agent })}`);
    const res = await this.opts.pay.fetch(url);
    const header = res.headers.get("PAYMENT-RESPONSE");
    if (res.status !== 200 || !header) throw new Error(`public buy failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const settled = decodePaymentResponseHeader(header);
    // The amount paid is the quote's notional; createHushFetch records every `exact` payment with its resource.
    const payment = (await this.opts.pay.store.listPayments()).filter((p) => p.resource === url).at(-1);
    const notional = BigInt(payment?.amount ?? settled.amount ?? 0);
    return { ticker: t, side: "buy", size, price: (notional * 100n) / size, notional, paymentTx: settled.transaction as Hex };
  }

  /** Sell plain tokens: take a signed sell quote, transfer the tokens to the desk, claim the USDC. */
  async sell(ticker: string, shares: string | number): Promise<PublicTrade> {
    const t = this.ticker(ticker);
    const size = parseShares(shares);
    const q = new URLSearchParams({ ticker: t, side: "sell", size: formatShares(size), agent: this.agent });
    const res = await this.fetchFn(this.url(`quote?${q}`));
    const signed = (await res.json()) as SignedQuoteJson & { error?: string };
    if (!res.ok) throw new Error(`sell quote failed: ${signed.error ?? res.status}`);
    const quote = quoteFromJson(signed.quote);
    const domain = alphaDomain(this.opts.contracts.chainId, this.opts.contracts.hushAlpha!);
    if (!(await quoteTyped.isValid(domain, quote, signed.signature)) || !isAddressEqual(quote.agent, this.agent) || quote.size !== size) {
      throw new Error("sell quote not signed by the desk for this trade");
    }

    const transferTx = await this.opts.walletClient.writeContract({
      address: this.opts.contracts.stocks![t]!,
      abi: erc20Abi,
      functionName: "transfer",
      args: [quote.desk, size * CENTISHARE],
    });
    const receipt = await this.opts.publicClient.waitForTransactionReceipt({ hash: transferTx });
    if (receipt.status !== "success") throw new Error(`token transfer reverted: ${transferTx}`);

    const claim = await this.fetchFn(this.url("public-sell"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quote: quoteToJson(quote), quoteSignature: signed.signature, txHash: transferTx }),
    });
    const body = (await claim.json()) as { fill: SignedFillJson; payoutTx: Hex; error?: string };
    if (!claim.ok) throw new Error(`public sell claim failed: ${body.error ?? claim.status} (tokens sent in ${transferTx})`);
    return { ticker: t, side: "sell", size, price: quote.price, notional: quote.notional, paymentTx: body.payoutTx, transferTx, fill: body.fill };
  }
}
