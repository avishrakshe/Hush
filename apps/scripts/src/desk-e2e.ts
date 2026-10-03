/**
 * V2 end-to-end check: the Hush Desk (hush-rfq) against a running desk + facilitator.
 *
 *   402 = desk-signed quote (verified on HushAlpha) · input checks before the paywall · private buy (top-up, voucher,
 *   signed fill + statement, no per-trade tx) · replay + expired-quote refusal · signed positions · trade policy ·
 *   kill switch · sell → proceeds to credit · settle-out (what observer/agent/auditor see) · public `exact` path ·
 *   desk vouchers in a HushLedger batch · the agent's own audit of the desk
 *
 * Usage: pnpm desk-e2e[:local]    (needs bootstrap, the price bot, the facilitator and `pnpm desk[:local]` running)
 */
import { NETWORK, URLS, loadContracts, publicClient, txLink, wallet } from "@hush/config";
import {
  HUSH_RFQ,
  type Quote,
  alphaDomain,
  eercToAtomic,
  fillFromJson,
  formatShares,
  formatUsdc,
  freezeAgent,
  hushAlphaAbi,
  mockStockAbi,
  quoteFromJson,
  quoteRequestHash,
  readEercTransfer,
  unfreezeAgent,
} from "@hush/x402";
import { HushDeskClient, createHushFetch, parseCreditExtra, parseRfqExtra } from "@hush/x402/client";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { type Hex, parseAbi, parseEventLogs } from "viem";

const contracts = loadContracts();
const DESK = URLS.desk;
const ADMIN = process.env.DESK_ADMIN_TOKEN ?? process.env.PROVIDER_ADMIN_TOKEN ?? "";
const atlas = wallet("ATLAS");
const veil = wallet("VEIL");
const owner = wallet("OWNER");
const auditor = wallet("AUDITOR");

const results: { check: string; result: "PASS" | "FAIL"; detail: string }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function check(name: string, fn: () => Promise<string>) {
  process.stdout.write(`▸ ${name} … `);
  try {
    const detail = await fn();
    results.push({ check: name, result: "PASS", detail });
    console.log(`PASS  ${detail}`);
  } catch (err) {
    const detail = (err as Error).message.split("\n")[0]!.slice(0, 200);
    results.push({ check: name, result: "FAIL", detail });
    console.log(`FAIL  ${detail}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const rfqUrl = (agent: string, size = "0.10", ticker = "NVDA") => `${DESK}/rfq?ticker=${ticker}&side=buy&size=${size}&agent=${agent}`;
const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

/** Records the PAYMENT-SIGNATURE of the last paid request, so the replay check can resend it verbatim. */
let lastPayment: { url: string; header: string } | undefined;
const recordingFetch: typeof fetch = async (input, init) => {
  const req = new Request(input, init);
  const header = req.headers.get("PAYMENT-SIGNATURE");
  if (header) lastPayment = { url: req.url, header };
  return fetch(req);
};

async function main() {
  console.log(`Hush V2 desk e2e on ${NETWORK} · desk ${DESK}\n`);
  assert(contracts.hushAlpha && contracts.stocks?.NVDA, "deployment has no HushAlpha / mock stocks");
  const alpha = alphaDomain(contracts.chainId, contracts.hushAlpha);
  const NVDA = contracts.stocks.NVDA;

  const veilEerc = await veil.eerc(contracts).init();
  const veilPay = createHushFetch({
    mode: "hush-credit",
    wallet: veil.account,
    eercClient: veilEerc,
    publicClient: publicClient as never,
    privacy: { topUpChunks: [20_000_000n], jitterMs: [0, 0] }, // every desk top-up is exactly 20 hUSDC
    fetch: recordingFetch,
  });
  const desk = new HushDeskClient({ deskUrl: DESK, hush: veilPay, signer: veil.account });

  // ── setup: make sure Veil can afford a few trades (owner treasury → Veil, private) ──
  await check("setup: Veil holds enough private hUSDC for desk top-ups", async () => {
    const want = 4_000n; // 40 hUSDC in eERC units
    const bal = await veilEerc.balance();
    if (bal.decrypted >= want) return `Veil holds ${formatUsdc(eercToAtomic(bal.decrypted, contracts.eercDecimals))}`;
    const ownerEerc = owner.eerc(contracts);
    const needed = want - bal.decrypted;
    if ((await ownerEerc.balance()).decrypted < needed) await ownerEerc.deposit(100_000_000n); // treasury: 100 USDC → hUSDC (public deposit)
    const { txHash } = await ownerEerc.transfer(veil.address, needed);
    return `owner allocated ${formatUsdc(eercToAtomic(needed, contracts.eercDecimals))} privately ${txLink(txHash)}`;
  });

  // ── 1. the 402 is the quote ──
  let probeQuote: Quote | undefined;
  await check("402 offers hush-rfq + exact with one desk-signed quote (checked on HushAlpha)", async () => {
    const res = await fetch(rfqUrl(veil.address));
    assert(res.status === 402, `expected 402, got ${res.status}`);
    const required = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED") ?? "");
    const rfq = required.accepts.find((a) => a.scheme === HUSH_RFQ);
    const exact = required.accepts.find((a) => a.scheme === "exact");
    assert(rfq && exact, `offered ${required.accepts.map((a) => a.scheme).join(", ")}`);
    const extra = parseRfqExtra(rfq.extra);
    const q = quoteFromJson(extra.quote);
    assert((exact.extra as { quote?: { quoteId?: string } }).quote?.quoteId === q.quoteId, "the two schemes carry different quotes");
    assert(q.notional === (q.size * q.price) / 100n && rfq.amount === q.notional.toString(), "notional mismatch");
    const onchain = await publicClient.readContract({ address: contracts.hushAlpha!, abi: hushAlphaAbi, functionName: "isValidQuoteSignature", args: [q, extra.quoteSignature] });
    assert(onchain, "HushAlpha rejected the desk's quote signature");
    probeQuote = q;
    return `${formatShares(q.size)} NVDA @ $${Number(q.price) / 1e6} = ${formatUsdc(q.notional)} · expires in ${Number(q.expiry) - Math.floor(Date.now() / 1000)}s`;
  });

  await check("malformed requests are refused before the paywall (no 402, nothing to pay)", async () => {
    const bad = [rfqUrl(veil.address, "0.10", "AAPL"), rfqUrl(veil.address, "0.001"), `${DESK}/rfq?ticker=NVDA&side=buy&size=0.10`, `${DESK}/rfq?ticker=NVDA&side=sell&size=0.10&agent=${veil.address}`];
    const codes = await Promise.all(bad.map(async (u) => (await fetch(u)).status));
    assert(codes.every((c) => c === 400), `got ${codes.join(", ")}`);
    return "unknown ticker · <0.01 share · no agent · sell on /rfq → 400";
  });

  // ── 2. private buy ──
  let firstBuy: Awaited<ReturnType<HushDeskClient["buy"]>> | undefined;
  await check("Veil buys 0.10 NVDA via hush-rfq: private top-up once, then a voucher — fill + statement desk-signed", async () => {
    await desk.ensureCredit((probeQuote?.notional ?? 20_000_000n) * 2n);
    const nonceBefore = await publicClient.getTransactionCount({ address: veil.address });
    const t0 = performance.now();
    firstBuy = await desk.buy("NVDA", "0.10");
    const ms = Math.round(performance.now() - t0);
    const nonceAfter = await publicClient.getTransactionCount({ address: veil.address });
    assert(nonceAfter === nonceBefore, `Veil sent ${nonceAfter - nonceBefore} transaction(s) for the trade`);
    const okFill = await publicClient.readContract({ address: contracts.hushAlpha!, abi: hushAlphaAbi, functionName: "isValidFillReceiptSignature", args: [firstBuy.fill, firstBuy.signedFill.signature] });
    const okStmt = await publicClient.readContract({
      address: contracts.hushAlpha!,
      abi: hushAlphaAbi,
      functionName: "isValidPositionStatementSignature",
      args: [firstBuy.statement, firstBuy.signedStatement.signature],
    });
    assert(okFill && okStmt, "HushAlpha rejected the fill or statement signature");
    return `${ms} ms, 0 on-chain txs for the trade · position ${formatShares(firstBuy.statement.position)} NVDA (seq ${firstBuy.statement.seq}) · fill + statement verify on HushAlpha`;
  });

  await check("replaying the same paid request is refused (quote filled once)", async () => {
    assert(lastPayment, "no paid request recorded");
    const res = await fetch(lastPayment.url, { headers: { "PAYMENT-SIGNATURE": lastPayment.header } });
    assert(res.status === 402, `replay got ${res.status}`);
    return `replay → 402 ${(decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED") ?? "").error ?? "").slice(0, 60)}`;
  });

  await check("an expired quote is not filled: paying it gets a fresh 402 instead", async () => {
    const res = await fetch(rfqUrl(veil.address, "0.01"));
    const required = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED") ?? "");
    const req = required.accepts.find((a) => a.scheme === HUSH_RFQ) as PaymentRequirements;
    const extra = parseRfqExtra(req.extra);
    const stale = quoteFromJson(extra.quote);
    await sleep((Number(stale.expiry) - Math.floor(Date.now() / 1000) + 2) * 1000);
    const credit = veilPay.credit!;
    const payload = await credit.createVoucherPayment(req.payTo as Hex, { extra: parseCreditExtra(req.extra), chainId: contracts.chainId }, stale.notional, quoteRequestHash(alpha, stale), "e2e:stale", {
      allowTopUp: false,
      recordPayment: false,
    });
    const header = encodePaymentSignatureHeader({ x402Version: 2, resource: required.resource, accepted: req, payload: payload as never });
    const paid = await fetch(rfqUrl(veil.address, "0.01"), { headers: { "PAYMENT-SIGNATURE": header } });
    await credit.finishVoucher(payload, { ok: false, reason: "expired quote (expected)" });
    assert(paid.status === 402, `expired quote got ${paid.status}`);
    const fresh = decodePaymentRequiredHeader(paid.headers.get("PAYMENT-REQUIRED") ?? "").accepts.find((a) => a.scheme === HUSH_RFQ);
    assert(fresh && parseRfqExtra(fresh.extra).quote.quoteId !== stale.quoteId, "no fresh quote offered");
    return "stale quote → 402 with a new quote; nothing filled";
  });

  // ── 3. custody reads + policy + kill switch ──
  await check("positions are private: unsigned → 401; Veil's signed read → desk-signed statement", async () => {
    const unsigned = await fetch(`${DESK}/positions/${veil.address}`);
    assert(unsigned.status === 401, `unsigned → ${unsigned.status}`);
    const p = await desk.positions();
    const nvda = p.find((x) => x.ticker === "NVDA");
    assert(nvda && nvda.position === firstBuy?.statement.position, `positions ${JSON.stringify(p.map((x) => [x.ticker, x.position.toString()]))}`);
    return `NVDA ${formatShares(nvda.position)} @ avg $${Number(nvda.avgCost) / 1e6} (seq ${nvda.seq})`;
  });

  await check("trade policy blocks an over-limit buy before anything is signed", async () => {
    const strict = createHushFetch({ mode: "hush-credit", wallet: veil.account, eercClient: veilEerc, tradePolicy: { maxNotionalPerTrade: 1_000_000n, allowedTickers: ["NVDA"] } });
    const strictDesk = new HushDeskClient({ deskUrl: DESK, hush: strict, signer: veil.account });
    const signedBefore = (await strict.store.listVouchers()).length;
    const err = await strictDesk.buy("NVDA", "0.10").then(() => undefined, (e: Error) => e);
    assert(err && /per-trade max/.test(err.message), `expected a policy refusal, got ${err?.message ?? "a fill"}`);
    assert((await strict.store.listVouchers()).length === signedBefore, "a voucher was signed anyway");
    return "notional > $1 per trade → refused, 0 vouchers signed";
  });

  await check("kill switch: a frozen agent cannot trade; unfreezing restores it", async () => {
    const r = { registry: contracts.hushRegistry };
    await freezeAgent(owner.walletClient, publicClient, r.registry, veil.address);
    try {
      const err = await desk.buy("NVDA", "0.01").then(() => undefined, (e: Error) => e);
      assert(err && /frozen/i.test(err.message), `frozen agent got ${err?.message ?? "a fill"}`);
    } finally {
      await unfreezeAgent(owner.walletClient, publicClient, r.registry, veil.address);
    }
    const again = await desk.buy("NVDA", "0.01");
    return `frozen → refused · unfrozen → filled again (position ${formatShares(again.statement.position)})`;
  });

  // ── 4. sell + settle-out ──
  await check("Veil sells 0.03 NVDA: signed order, proceeds credited to desk credit, position drops", async () => {
    const before = BigInt((await desk.creditState()).available);
    const sold = await desk.sell("NVDA", "0.03");
    const after = BigInt((await desk.creditState()).available);
    assert(after - before === sold.proceeds, `credit grew ${after - before}, proceeds ${sold.proceeds}`);
    return `proceeds ${formatUsdc(sold.proceeds)} → available ${formatUsdc(after)} · position ${formatShares(sold.statement.position)} (seq ${sold.statement.seq})`;
  });

  await check("settle-out 0.02 NVDA: one private eERC transfer — observer sees asset + addresses, not size", async () => {
    const { statement } = await desk.settleOut("NVDA", "0.02");
    const run = await fetch(`${DESK}/admin/settle-outs`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } });
    assert(run.ok, `trigger failed: ${run.status}`);
    let txHash: Hex | null = null;
    for (let i = 0; i < 30 && !txHash; i++) {
      txHash = (await desk.settleOuts()).find((s) => s.status === "sent" && s.size === "0.02")?.txHash ?? null;
      if (!txHash) await sleep(2_000);
    }
    assert(txHash, "settle-out never sent");
    const t = await readEercTransfer(publicClient as never, contracts, txHash);
    const hNvdaId = await publicClient.readContract({ address: contracts.encryptedErc, abi: parseAbi(["function tokenIds(address) view returns (uint256)"]), functionName: "tokenIds", args: [NVDA] });
    assert(t.tokenId === hNvdaId, `transfer tokenId ${t.tokenId}, hNVDA is ${hNvdaId}`);
    const mine = await veilEerc.decryptIncoming(txHash);
    const audited = await auditor.eerc(contracts).auditorDecrypt(txHash);
    assert(mine.units === 2n && audited.units === 2n, `decrypted ${mine.units} / audited ${audited.units}`);
    return `observer: ${t.from.slice(0, 8)}… → ${t.to.slice(0, 8)}… tokenId ${t.tokenId} (hNVDA), amount hidden · Veil + auditor decrypt 0.02 · position ${formatShares(statement.position)}  ${txLink(txHash)}`;
  });

  // ── 5. the public baseline ──
  await check("Atlas buys 0.10 NVDA via exact: USDC and mNVDA both move publicly (what Mirror will read)", async () => {
    const atlasPay = createHushFetch({ mode: "public", wallet: atlas.account, publicClient: publicClient as never });
    const before = await publicClient.readContract({ address: NVDA, abi: mockStockAbi, functionName: "balanceOf", args: [atlas.address] });
    const res = await atlasPay.fetch(rfqUrl(atlas.address));
    if (res.status !== 200) throw new Error(`status ${res.status}: ${await res.text()}`);
    const settle = JSON.parse(Buffer.from(res.headers.get("PAYMENT-RESPONSE") ?? "", "base64").toString()) as { transaction: Hex };
    const receipt = await publicClient.getTransactionReceipt({ hash: settle.transaction });
    const [usdc] = parseEventLogs({ abi: transferAbi, logs: receipt.logs });
    const after = await publicClient.readContract({ address: NVDA, abi: mockStockAbi, functionName: "balanceOf", args: [atlas.address] });
    assert(usdc && after - before === 10n ** 17n, `mNVDA +${after - before}`);
    return `observer sees ${formatUsdc(usdc.args.value)} Atlas → desk ${txLink(settle.transaction)} and +0.10 mNVDA desk → Atlas`;
  });

  // ── 6. accountability ──
  await check("desk vouchers (buys + sell order) land in a HushLedger batch and verify on-chain", async () => {
    const res = await fetch(`${DESK}/admin/commit`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } });
    if (!res.ok) throw new Error(`commit failed: ${res.status} ${await res.text()}`);
    const v = await veilPay.credit!.verifyMyVouchers();
    assert(v.failed.length === 0, `${v.failed.length} vouchers failed inclusion`);
    assert(v.verified >= 3, `only ${v.verified} verified (${v.pending} pending)`);
    return `${v.verified} desk vouchers proven via HushLedger.verifyVoucherInclusion`;
  });

  await check("Veil audits the desk: statements signed, seq increasing, positions = own fills − sells − settle-outs", async () => {
    const audit = await desk.verifyPositions();
    assert(audit.ok, audit.issues.join("; "));
    const fills = (await veilPay.store.listFills()).map((f) => fillFromJson(f.fill));
    const nvda = audit.positions.find((p) => p.ticker === "NVDA");
    return `${fills.length} fills · NVDA ${formatShares(nvda?.position ?? 0n)} matches · ${(await veilPay.store.listStatements()).length} statements held`;
  });

  veilPay.credit?.stop();
  console.log();
  console.table(results.map(({ check, result }) => ({ check, result })));
  const failed = results.filter((r) => r.result === "FAIL").length;
  console.log(failed ? `${failed} check(s) FAILED` : `all ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
