import type { PaymentRequirements } from "@x402/core/types";
import { type Address, type Hex, encodeAbiParameters, encodeEventTopics, erc20Abi, keccak256, stringToBytes, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type HushContracts,
  type Quote,
  alphaDomain,
  fillFromJson,
  fillTyped,
  hushDomain,
  quoteRequestHash,
  quoteToJson,
  quoteTyped,
  settleOutToJson,
  settleOutTyped,
  signVoucher,
  statementFromJson,
  statementTyped,
  tickerToBytes32,
  voucherToJson,
} from "../src/index.js";
import { HushDeskService, HushProviderService, MemoryCreditStore, MemoryDeskStore } from "../src/facilitator/index.js";
import type { EercAccount } from "../src/eerc/account.js";

// Well-known Hardhat test keys — never use outside tests.
const agent = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const desk = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const owner = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const stranger = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");

const NVDA_TOKEN = "0xd4F3f123C3432FB85B8e57f1ABBAef54829470F2" as Address;
const contracts: HushContracts = {
  chainId: 43113,
  eercDecimals: 2,
  startBlock: 1,
  encryptedErc: "0x9Aa48Af8C613e8fEA7Ef8c8BB859A0a8C52F2396",
  registrar: "0x9F674A79fcEc3B472A35895ab6a4FA870200B34b",
  usdc: "0x77a5b64985b910652826183213d12bf3dc2DeCF7",
  hushRegistry: "0x8CdEaaF16304a6E03002b90a6029b8E79e221ef6",
  hushLedger: "0x1D6ee5d0AA41f191A361C4306EbCc9E2Aa387577",
  stockOracle: "0x61B554EE20BbAe5456c795a106BAdEAEdf655236",
  stocks: { NVDA: NVDA_TOKEN },
  hushAlpha: "0x1111111111111111111111111111111111111111",
};
const hush = hushDomain(contracts.chainId, contracts.hushLedger);
const alpha = alphaDomain(contracts.chainId, contracts.hushAlpha!);
const txHash = (s: string) => keccak256(stringToBytes(s));
const ORACLE_PRICE = 180_004_321n; // $180.004321

function setup(opts: { inventory?: bigint } = {}) {
  const now = { t: Date.now() };
  const state = {
    frozen: new Set<string>(),
    agents: new Map<string, Address>([[agent.address.toLowerCase(), owner.address]]),
    oracle: { price: ORACLE_PRICE, at: BigInt(Math.floor(now.t / 1000) - 30) },
  };
  const publicClient = {
    async readContract({ functionName, args }: { functionName: string; args: readonly unknown[] }) {
      const a = String(args?.[0] ?? "").toLowerCase();
      switch (functionName) {
        case "isFrozen":
          return state.frozen.has(a);
        case "isAgent":
          return state.agents.has(a);
        case "getAgent": {
          const o = state.agents.get(a);
          return { owner: o ?? "0x0000000000000000000000000000000000000000", metadataURI: "", frozen: false, registeredAt: o ? 1n : 0n };
        }
        case "tokenIds":
          return 1n;
        case "latestPrice":
          return [state.oracle.price, state.oracle.at, 7n];
        case "balanceOf":
          return 1_000n * 10n ** 18n;
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
    verifyTypedData: (args: Parameters<typeof verifyTypedData>[0]) => verifyTypedData(args),
    async waitForTransactionReceipt() {
      return { status: "success" };
    },
    async getTransactionReceipt({ hash }: { hash: Hex }) {
      const r = chainTxs.get(hash);
      if (!r) throw new Error("transaction not found");
      return { status: "success", blockNumber: r.blockNumber, logs: r.logs };
    },
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      return { timestamp: blockTimes.get(blockNumber) ?? BigInt(Math.floor(now.t / 1000)) };
    },
  };
  // Public token transfers the desk can look up (for public sells).
  const chainTxs = new Map<string, { blockNumber: bigint; logs: unknown[] }>();
  const blockTimes = new Map<bigint, bigint>();
  const payouts: { to: Address; amount: bigint }[] = [];
  const deskWallet = {
    async writeContract({ args }: { args: readonly unknown[] }) {
      const [to, amount] = args as [Address, bigint];
      payouts.push({ to, amount });
      return txHash(`payout-${payouts.length}`);
    },
  };

  // One fake eERC account for the desk: decrypts hUSDC top-ups, holds encrypted hNVDA inventory, sends settle-outs.
  const incoming = new Map<string, { from: Address; units: bigint }>();
  const sent: { to: Address; units: bigint; memo?: string; token?: Address }[] = [];
  const failTransfers = { on: false };
  const eerc = {
    address: desk.address,
    async decryptIncoming(hash: Hex) {
      const t = incoming.get(hash);
      if (!t) throw new Error("not a top-up");
      return { transfer: { txHash: hash, from: t.from, to: desk.address, tokenId: 1n, blockNumber: 10n, publicSignals: [], logs: [] }, units: t.units };
    },
    async balance() {
      return { encrypted: [], decrypted: opts.inventory ?? 10_000n, pendingIncoming: 0 };
    },
    async transfer(to: Address, units: bigint, memo?: string, token?: Address) {
      if (failTransfers.on) throw new Error("receiver not registered in eERC");
      sent.push({ to, units, memo, token });
      return { txHash: txHash(`settle-${sent.length}`), blockNumber: 12n };
    },
  } as unknown as EercAccount;

  const service = new HushProviderService({
    contracts,
    publicClient: publicClient as never,
    providerSigner: desk,
    providerEerc: eerc,
    store: new MemoryCreditStore(),
    creditTtlSeconds: 3600,
    now: () => now.t,
  });
  const store = new MemoryDeskStore();
  const deskService = new HushDeskService({
    service,
    signer: desk,
    contracts,
    publicClient: publicClient as never,
    store,
    deskEerc: eerc,
    deskWallet: deskWallet as never,
    now: () => now.t,
  });
  return { now, state, service, desk: deskService, store, incoming, sent, failTransfers, chainTxs, blockTimes, payouts };
}

/** Records a public ERC-20 Transfer on the fake chain and returns its tx hash. */
function publicTransfer(s: ReturnType<typeof setup>, label: string, args: { from: Address; to: Address; value: bigint; token?: Address; at?: bigint }) {
  const hash = txHash(label);
  const blockNumber = BigInt(s.chainTxs.size + 100);
  s.chainTxs.set(hash, {
    blockNumber,
    logs: [
      {
        address: args.token ?? NVDA_TOKEN,
        topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: args.from, to: args.to } }),
        data: encodeAbiParameters([{ type: "uint256" }], [args.value]),
        blockNumber,
        transactionHash: hash,
        logIndex: 0,
      },
    ],
  });
  if (args.at !== undefined) s.blockTimes.set(blockNumber, args.at);
  return hash;
}

type S = ReturnType<typeof setup>;

async function fund(s: S, units = 10_000n) {
  s.incoming.set(txHash(`topup-${units}`), { from: agent.address, units });
  await s.service.processTopUp(agent.address, txHash(`topup-${units}`));
}

function requirementsFor(q: Quote, signature: Hex, amount = q.notional): PaymentRequirements {
  return {
    scheme: "hush-rfq",
    network: "eip155:43113",
    asset: contracts.usdc,
    amount: amount.toString(),
    payTo: desk.address,
    maxTimeoutSeconds: 60,
    extra: { quote: quoteToJson(q), quoteSignature: signature },
  } as PaymentRequirements;
}

/** The agent's voucher for a quote: next nonce, cumulative + notional, bound to the quote digest. */
async function voucherFor(s: S, q: Quote, overrides: Partial<{ add: bigint; requestHash: Hex; signer: typeof agent }> = {}) {
  const credit = await s.service.creditState(agent.address);
  const v = {
    agent: agent.address,
    provider: desk.address,
    cumulativeSpent: BigInt(credit.settledCumulative) + (overrides.add ?? q.notional),
    nonce: BigInt(credit.lastNonce) + 1n,
    requestHash: overrides.requestHash ?? quoteRequestHash(alpha, q),
    expiry: BigInt(Math.floor(s.now.t / 1000) + 300),
  };
  return { voucher: voucherToJson(v), signature: await signVoucher(overrides.signer ?? agent, hush, v) };
}

async function buy(s: S, size: bigint) {
  const { quote, signature } = await s.desk.quote({ agent: agent.address, ticker: "NVDA", side: "buy", size });
  const r = await s.desk.settleRfq(await voucherFor(s, quote), requirementsFor(quote, signature));
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r;
}

describe("Hush Desk — quotes", () => {
  it("quotes oracle ± spread rounded to the cent in the desk's favour, desk-signed, live 15 s", async () => {
    const s = setup();
    const b = await s.desk.quote({ agent: agent.address, ticker: "nvda", side: "buy", size: 10n });
    const sl = await s.desk.quote({ agent: agent.address, ticker: "NVDA", side: "sell", size: 10n });
    // 180.004321 × 1.001 = 180.18432… → 180.19 (up) · 180.004321 × 0.999 = 179.82431… → 179.82 (down)
    expect(b.quote.price).toBe(180_190_000n);
    expect(sl.quote.price).toBe(179_820_000n);
    expect(b.quote.notional).toBe(18_019_000n); // 0.10 share × $180.19
    expect(b.quote.ticker).toBe(tickerToBytes32("NVDA"));
    expect(Number(b.quote.expiry) - Math.floor(s.now.t / 1000)).toBe(15);
    expect(await quoteTyped.isValid(alpha, b.quote, b.signature)).toBe(true);
  });

  it("refuses unknown tickers, bad sizes and a stale oracle", async () => {
    const s = setup();
    await expect(s.desk.quote({ agent: agent.address, ticker: "AAPL", side: "buy", size: 1n })).rejects.toMatchObject({ code: "unknown_ticker" });
    await expect(s.desk.quote({ agent: agent.address, ticker: "NVDA", side: "buy", size: 0n })).rejects.toMatchObject({ code: "invalid_size" });
    s.state.oracle.at -= 3_600n;
    await expect(s.desk.quote({ agent: agent.address, ticker: "NVDA", side: "buy", size: 1n })).rejects.toMatchObject({ code: "oracle_stale" });
  });
});

describe("Hush Desk — hush-rfq buys", () => {
  let s: S;
  beforeEach(async () => {
    s = setup();
    await fund(s); // 100 hUSDC credit at the desk
  });

  it("fills: the voucher pays exactly the notional, the position is booked, fill + statement are desk-signed", async () => {
    const r = await buy(s, 10n);
    const credit = await s.service.creditState(agent.address);
    expect(credit.settledCumulative).toBe(r.quote.notional.toString());

    const fill = fillFromJson(r.fill.fill);
    expect(await fillTyped.isValid(alpha, fill, r.fill.signature)).toBe(true);
    expect([fill.quoteId, fill.size, fill.price]).toEqual([r.quote.quoteId, 10n, r.quote.price]);

    const st = statementFromJson(r.statement.statement);
    expect(await statementTyped.isValid(alpha, st, r.statement.signature)).toBe(true);
    expect([st.position, st.avgCost, st.seq]).toEqual([10n, r.quote.price, 1n]);
    // The voucher waits for the next HushLedger batch like any hush-credit voucher.
    expect((await s.service.store.listUnbatchedVouchers(desk.address)).map((v) => v.leaf)).toContain(r.leaf);
  });

  it("rejects replays, expired quotes, quotes for other agents and quotes the desk didn't sign", async () => {
    const { quote, signature } = await s.desk.quote({ agent: agent.address, ticker: "NVDA", side: "buy", size: 10n });
    const paid = await voucherFor(s, quote);
    expect((await s.desk.settleRfq(paid, requirementsFor(quote, signature))).ok).toBe(true);
    // Same payment again, and a fresh voucher for the same quote.
    expect(await s.desk.settleRfq(paid, requirementsFor(quote, signature))).toMatchObject({ ok: false, code: "quote_used" });
    expect(await s.desk.settleRfq(await voucherFor(s, quote), requirementsFor(quote, signature))).toMatchObject({ ok: false, code: "quote_used" });

    const late = await s.desk.quote({ agent: agent.address, ticker: "NVDA", side: "buy", size: 1n });
    s.now.t += 16_000;
    expect(await s.desk.verifyRfq(await voucherFor(s, late.quote), requirementsFor(late.quote, late.signature))).toMatchObject({ code: "quote_expired" });

    const theirs = await s.desk.quote({ agent: stranger.address, ticker: "NVDA", side: "buy", size: 1n });
    expect(await s.desk.verifyRfq(await voucherFor(s, theirs.quote), requirementsFor(theirs.quote, theirs.signature))).toMatchObject({
      code: "quote_agent_mismatch",
    });

    const mine = await s.desk.quote({ agent: agent.address, ticker: "NVDA", side: "buy", size: 1n });
    const forged = await quoteTyped.sign(stranger, alpha, mine.quote);
    expect(await s.desk.verifyRfq(await voucherFor(s, mine.quote), requirementsFor(mine.quote, forged))).toMatchObject({ code: "invalid_quote" });
    const cheaper = { ...mine.quote, price: 1_000_000n, notional: 10_000n };
    expect(await s.desk.verifyRfq(await voucherFor(s, cheaper), requirementsFor(cheaper, mine.signature))).toMatchObject({ code: "invalid_quote" });
  });

  it("the voucher must pay the full notional and be bound to this quote", async () => {
    const { quote, signature } = await s.desk.quote({ agent: agent.address, ticker: "NVDA", side: "buy", size: 10n });
    const req = requirementsFor(quote, signature);
    expect(await s.desk.verifyRfq(await voucherFor(s, quote, { add: quote.notional - 1n }), req)).toMatchObject({ code: "underpaid" });
    expect(await s.desk.verifyRfq(await voucherFor(s, quote, { requestHash: txHash("other quote") }), req)).toMatchObject({ code: "request_mismatch" });
    expect(await s.desk.verifyRfq(await voucherFor(s, quote), requirementsFor(quote, signature, 1n))).toMatchObject({ code: "amount_mismatch" });
    expect(await s.desk.verifyRfq(await voucherFor(s, quote, { signer: stranger }), req)).toMatchObject({ code: "invalid_signature" });
    expect((await s.desk.verifyRfq(await voucherFor(s, quote), req)).ok).toBe(true);
  });

  it("refuses a trade the agent's credit can't cover", async () => {
    const big = await s.desk.quote({ agent: agent.address, ticker: "NVDA", side: "buy", size: 1_000n }); // ~$1,802 > $100 credit
    expect(await s.desk.verifyRfq(await voucherFor(s, big.quote), requirementsFor(big.quote, big.signature))).toMatchObject({ code: "insufficient_credit" });
  });

  it("frozen agents cannot trade (buy or sell)", async () => {
    await buy(s, 10n);
    s.state.frozen.add(agent.address.toLowerCase());
    const b = await s.desk.quote({ agent: agent.address, ticker: "NVDA", side: "buy", size: 1n });
    expect(await s.desk.settleRfq(await voucherFor(s, b.quote), requirementsFor(b.quote, b.signature))).toMatchObject({ ok: false, code: "agent_frozen" });
    const sl = await s.desk.quote({ agent: agent.address, ticker: "NVDA", side: "sell", size: 1n });
    await expect(s.desk.sell({ quote: quoteToJson(sl.quote), signature: sl.signature }, await voucherFor(s, sl.quote, { add: 0n }))).rejects.toMatchObject({
      code: "agent_frozen",
    });
  });

  it("keeps custody fully backed by the desk's encrypted inventory", async () => {
    const small = setup({ inventory: 30n });
    await fund(small);
    await buy(small, 25n);
    const more = await small.desk.quote({ agent: agent.address, ticker: "NVDA", side: "buy", size: 10n });
    expect(await small.desk.verifyRfq(await voucherFor(small, more.quote), requirementsFor(more.quote, more.signature))).toMatchObject({
      code: "desk_capacity",
    });
  });
});

describe("Hush Desk — statements, sells, settle-outs", () => {
  let s: S;
  beforeEach(async () => {
    s = setup();
    await fund(s);
  });

  async function settleOutRequest(size: bigint, signer = agent, requestId: Hex = txHash(`so-${Math.random()}`)) {
    const request = { requestId, agent: agent.address, desk: desk.address, ticker: tickerToBytes32("NVDA"), size, deadline: BigInt(Math.floor(s.now.t / 1000) + 300) };
    return { json: settleOutToJson(request), signature: await settleOutTyped.sign(signer, alpha, request) };
  }

  it("statements number every change; position and average cost add up across buys, sells and settle-outs", async () => {
    const b1 = await buy(s, 10n);
    s.state.oracle.price = 190_000_000n;
    const b2 = await buy(s, 20n);
    const avg = (10n * b1.quote.price + 20n * b2.quote.price) / 30n;
    expect(statementFromJson(b2.statement.statement)).toMatchObject({ position: 30n, avgCost: avg, seq: 2n });

    // Sell 0.05: a zero-increment voucher is the order; proceeds land in desk credit.
    const before = BigInt((await s.service.creditState(agent.address)).available);
    const sq = await s.desk.quote({ agent: agent.address, ticker: "NVDA", side: "sell", size: 5n });
    const sold = await s.desk.sell({ quote: quoteToJson(sq.quote), signature: sq.signature }, await voucherFor(s, sq.quote, { add: 0n }));
    expect(statementFromJson(sold.statement.statement)).toMatchObject({ position: 25n, avgCost: avg, seq: 3n });
    expect(BigInt(sold.credit.available)).toBe(before + sq.quote.notional);
    expect(sold.credit.proceedsTotal).toBe(sq.quote.notional.toString());

    // Settle out 0.05: leaves custody now (seq 4), one private hNVDA transfer of 5 eERC units on the next tick.
    const so = await settleOutRequest(5n);
    const queued = await s.desk.requestSettleOut(so.json, so.signature);
    expect(statementFromJson(queued.statement.statement)).toMatchObject({ position: 20n, seq: 4n });
    const [done] = await s.desk.processSettleOuts();
    expect(done).toMatchObject({ status: "sent", size: "0.05" });
    expect(s.sent).toEqual([{ to: agent.address, units: 5n, memo: "hush:settle-out:v1", token: NVDA_TOKEN }]);
  });

  it("a failed settle-out puts the shares back in custody under a new statement", async () => {
    await buy(s, 10n);
    const so = await settleOutRequest(4n);
    await s.desk.requestSettleOut(so.json, so.signature);
    s.failTransfers.on = true;
    const [done] = await s.desk.processSettleOuts();
    expect(done?.status).toBe("failed");
    const { statements } = await s.desk.positions(agent.address);
    expect(statementFromJson(statements[0]!.statement)).toMatchObject({ position: 10n, seq: 3n });
  });

  it("sells need the position, a sell quote and a voucher that adds nothing", async () => {
    await buy(s, 10n);
    const tooMuch = await s.desk.quote({ agent: agent.address, ticker: "NVDA", side: "sell", size: 11n });
    await expect(s.desk.sell({ quote: quoteToJson(tooMuch.quote), signature: tooMuch.signature }, await voucherFor(s, tooMuch.quote, { add: 0n }))).rejects.toMatchObject({
      code: "insufficient_position",
    });
    const sq = await s.desk.quote({ agent: agent.address, ticker: "NVDA", side: "sell", size: 5n });
    await expect(s.desk.sell({ quote: quoteToJson(sq.quote), signature: sq.signature }, await voucherFor(s, sq.quote, { add: 1n }))).rejects.toMatchObject({
      code: "invalid_order",
    });
    const buyQuote = await s.desk.quote({ agent: agent.address, ticker: "NVDA", side: "buy", size: 1n });
    await expect(s.desk.sell({ quote: quoteToJson(buyQuote.quote), signature: buyQuote.signature }, await voucherFor(s, buyQuote.quote, { add: 0n }))).rejects.toMatchObject({
      code: "invalid_quote",
    });
  });

  it("public sell: USDC is paid for the matching token transfer, once per transfer and per quote", async () => {
    const SHARE_CENT = 10n ** 16n;
    const q = await s.desk.quote({ agent: agent.address, ticker: "NVDA", side: "sell", size: 5n });
    const signed = { quote: quoteToJson(q.quote), signature: q.signature };
    const wrong = publicTransfer(s, "short", { from: agent.address, to: desk.address, value: 4n * SHARE_CENT });
    await expect(s.desk.publicSell(signed, wrong)).rejects.toMatchObject({ code: "invalid_transfer" });
    const other = publicTransfer(s, "from-stranger", { from: stranger.address, to: desk.address, value: 5n * SHARE_CENT });
    await expect(s.desk.publicSell(signed, other)).rejects.toMatchObject({ code: "invalid_transfer" });

    const tx = publicTransfer(s, "good", { from: agent.address, to: desk.address, value: 5n * SHARE_CENT });
    const { fill, payoutTx } = await s.desk.publicSell(signed, tx);
    expect(s.payouts).toEqual([{ to: agent.address, amount: q.quote.notional }]);
    expect(fillFromJson(fill.fill)).toMatchObject({ side: 2, size: 5n, price: q.quote.price });
    expect(payoutTx).toBe(txHash("payout-1"));

    const again = await s.desk.quote({ agent: agent.address, ticker: "NVDA", side: "sell", size: 5n });
    await expect(s.desk.publicSell({ quote: quoteToJson(again.quote), signature: again.signature }, tx)).rejects.toMatchObject({ code: "duplicate_transfer" });
    await expect(s.desk.publicSell(signed, publicTransfer(s, "second", { from: agent.address, to: desk.address, value: 5n * SHARE_CENT }))).rejects.toMatchObject({
      code: "quote_used",
    });
  });

  it("public sell: a transfer that landed before the quote expired is honoured even if the claim comes later", async () => {
    const q = await s.desk.quote({ agent: agent.address, ticker: "NVDA", side: "sell", size: 1n });
    const tx = publicTransfer(s, "in-time", { from: agent.address, to: desk.address, value: 10n ** 16n, at: q.quote.expiry - 5n });
    s.now.t += 60_000; // the claim arrives a minute later
    await s.desk.publicSell({ quote: quoteToJson(q.quote), signature: q.signature }, tx);
    const late = await s.desk.quote({ agent: agent.address, ticker: "NVDA", side: "sell", size: 1n });
    const lateTx = publicTransfer(s, "too-late", { from: agent.address, to: desk.address, value: 10n ** 16n, at: late.quote.expiry + 5n });
    await expect(s.desk.publicSell({ quote: quoteToJson(late.quote), signature: late.signature }, lateTx)).rejects.toMatchObject({ code: "quote_expired" });
  });

  it("settle-outs must be signed by the agent or its owner, once, within the position", async () => {
    await buy(s, 10n);
    const bad = await settleOutRequest(1n, stranger);
    await expect(s.desk.requestSettleOut(bad.json, bad.signature)).rejects.toMatchObject({ code: "invalid_signature" });
    const byOwner = await settleOutRequest(1n, owner, txHash("owner-request"));
    await s.desk.requestSettleOut(byOwner.json, byOwner.signature);
    await expect(s.desk.requestSettleOut(byOwner.json, byOwner.signature)).rejects.toMatchObject({ code: "duplicate_request" });
    const tooMuch = await settleOutRequest(100n);
    await expect(s.desk.requestSettleOut(tooMuch.json, tooMuch.signature)).rejects.toMatchObject({ code: "insufficient_position" });
  });
});
