/**
 * P3 end-to-end check against a running facilitator + provider-demo.
 *
 *   public `exact` (Atlas) · hush-credit (Veil): top-up + CreditReceipt + vouchers · v2 stock signal · signed credit reads · what the public sees ·
 *   Merkle batch + on-chain inclusion · spend policy · kill switch · flagging · refund · hush-direct ·
 *   privacy options (fixed chunks, jittered pre-emptive top-ups) · optional credit expiry
 *
 * Usage: pnpm e2e[:local] [--with-expiry]     (needs `pnpm bootstrap[:local]` and both services running)
 */
import { NETWORK, URLS, loadContracts, publicClient, txLink, wallet } from "@hush/config";
import {
  CREDIT_AUTH_HEADER,
  creditAuthHeader,
  eercToAtomic,
  evidenceHash,
  flagProvider,
  formatPrice,
  formatUsdc,
  freezeAgent,
  hushDomain,
  hushLedgerAbi,
  hushRegistryAbi,
  isValidCreditReceipt,
  readEercTransfer,
  receiptFromJson,
  refundRequestToJson,
  requestHashFor,
  roundAt,
  signRefundRequest,
  signVoucher,
  unfreezeAgent,
  voucherToJson,
} from "@hush/x402";
import { type HushClientEvent, HushFacilitatorApi, createHushFetch } from "@hush/x402/client";
import { decodePaymentResponseHeader } from "@x402/fetch";
import { type Hex, parseAbi, parseEventLogs } from "viem";

const WITH_EXPIRY = process.argv.includes("--with-expiry");
const FEED = `${URLS.provider}/api/feed`;
const contracts = loadContracts();
const atlas = wallet("ATLAS");
const veil = wallet("VEIL");
const owner = wallet("OWNER");
const provider = wallet("PROVIDER");
const auditor = wallet("AUDITOR");
const ADMIN = process.env.PROVIDER_ADMIN_TOKEN ?? "";

const results: { check: string; result: "PASS" | "FAIL"; detail: string }[] = [];
const events: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const secs = (t0: number) => `${((performance.now() - t0) / 1000).toFixed(2)}s`;

async function check(name: string, fn: () => Promise<string>) {
  process.stdout.write(`▸ ${name} … `);
  try {
    const detail = await fn();
    results.push({ check: name, result: "PASS", detail });
    console.log(`PASS  ${detail}`);
  } catch (err) {
    const detail = (err as Error).message.split("\n")[0]!.slice(0, 160);
    results.push({ check: name, result: "FAIL", detail });
    console.log(`FAIL  ${detail}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const paymentResponse = (res: Response) => {
  const h = res.headers.get("PAYMENT-RESPONSE");
  return h ? decodePaymentResponseHeader(h) : undefined;
};
const onEvent = (e: HushClientEvent) => {
  const amount = "amount" in e ? ` ${formatUsdc(e.amount)}` : "";
  const reason = "reason" in e ? ` (${e.reason})` : "";
  events.push(`${new Date().toISOString().slice(11, 23)} ${e.type}${amount}${reason}`);
};

async function main() {
  console.log(`Hush P3 e2e on ${NETWORK} · provider ${FEED} · facilitator ${URLS.facilitator}\n`);

  // ── 0. discovery: the 402 advertises all three schemes ──
  await check("402 challenge lists exact + hush-credit + hush-direct", async () => {
    const res = await fetch(FEED);
    assert(res.status === 402, `expected 402, got ${res.status}`);
    const req = JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED") ?? "", "base64").toString()) as {
      accepts: { scheme: string; amount: string }[];
    };
    const schemes = req.accepts.map((a) => a.scheme);
    for (const s of ["exact", "hush-credit", "hush-direct"]) assert(schemes.includes(s), `missing ${s}`);
    return `${schemes.join(", ")} @ ${formatUsdc(BigInt(req.accepts[0]!.amount))}`;
  });

  // ── 1. public baseline ──
  await check("public (Atlas, x402 exact): paid call, amount visible on-chain", async () => {
    const pay = createHushFetch({ mode: "public", wallet: atlas.account, publicClient: publicClient as never });
    const t0 = performance.now();
    const res = await pay.fetch(FEED);
    if (res.status !== 200) throw new Error(`status ${res.status}: ${await res.text()}`);
    const settle = paymentResponse(res);
    assert(settle?.success && settle.transaction, "no settlement");
    const receipt = await publicClient.getTransactionReceipt({ hash: settle.transaction as Hex });
    const [transfer] = parseEventLogs({ abi: parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]), logs: receipt.logs });
    assert(transfer, "no Transfer log");
    return `${secs(t0)}; observer sees ${transfer.args.from.slice(0, 8)}… → ${transfer.args.to.slice(0, 8)}… ${formatUsdc(transfer.args.value)}  ${txLink(settle.transaction)}`;
  });

  // ── 2. hush-credit ──
  const veilEerc = veil.eerc(contracts);
  const veilPay = createHushFetch({
    mode: "hush-credit",
    wallet: veil.account,
    eercClient: veilEerc,
    publicClient: publicClient as never,
    policy: { maxPerCall: 50_000n, dailyCap: 20_000_000n, allowedProviders: [provider.address] },
    privacy: { topUpChunks: [5_000_000n, 10_000_000n], jitterMs: [0, 0] },
    onEvent,
  });
  const credit = veilPay.credit!;
  const timings: string[] = [];
  let topUpTx: Hex | undefined;

  // Make every run exercise the top-up path: privately return credit left over from earlier runs.
  await check("reset: refund credit left over from earlier runs", async () => {
    const api = new HushFacilitatorApi(URLS.facilitator);
    const auth = await creditAuthHeader(veil.account, hushDomain(contracts.chainId, contracts.hushLedger), veil.address, provider.address);
    const state = await api.credit(veil.address, provider.address, auth);
    if (BigInt(state.available) < 20_000n) return "no leftover credit";
    const request = { agent: veil.address, provider: provider.address, deadline: BigInt(Math.floor(Date.now() / 1000) + 300) };
    const signature = await signRefundRequest(veil.account, hushDomain(contracts.chainId, contracts.hushLedger), request);
    const res = await api.refund(refundRequestToJson(request), signature);
    return `refunded leftover ${formatUsdc(BigInt(res.amount))} ${res.txHash ? txLink(res.txHash) : ""}`;
  });

  await check("hush-credit (Veil): 5 calls — first tops up privately, rest are off-chain vouchers", async () => {
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const res = await veilPay.fetch(FEED);
      if (res.status !== 200) throw new Error(`call ${i + 1}: status ${res.status} ${await res.text()}`);
      assert(paymentResponse(res)?.success, `call ${i + 1}: not settled`);
      timings.push(secs(t0));
    }
    const receipts = await veilPay.store.listReceipts();
    topUpTx = receipts.at(-1)?.receipt.topupTxHash;
    return `timings ${timings.join(" · ")}`;
  });

  await check("v2 signal (Veil, hush-credit): NVDA call quotes the oracle round in force at issuedAt", async () => {
    if (!contracts.stockOracle) return "skipped — no mock stocks in this deployment";
    const bad = await fetch(`${URLS.provider}/api/signal?ticker=AAPL`);
    assert(bad.status === 400, `unknown ticker: expected 400 before the paywall, got ${bad.status}`);
    const res = await veilPay.fetch(`${URLS.provider}/api/signal?ticker=NVDA`);
    if (res.status !== 200) throw new Error(`status ${res.status} ${await res.text()}`);
    assert(paymentResponse(res)?.success, "not settled");
    const s = (await res.json()) as { direction: string; confidence: number; issuedAt: number; horizonSec: number; source: { priceAtomic: string } };
    const round = await roundAt(publicClient, contracts.stockOracle, "NVDA", BigInt(s.issuedAt));
    assert(round.price === BigInt(s.source.priceAtomic), `signal price ${s.source.priceAtomic} ≠ oracle ${round.price} at issuedAt`);
    return `${s.direction} (${s.confidence}) @ $${formatPrice(round.price)} · horizon ${s.horizonSec}s · AAPL → 400 unpaid`;
  });

  await check("credit is private: unsigned or stranger-signed credit reads are refused; the owner's are accepted", async () => {
    const url = `${URLS.facilitator}/credit/${veil.address}?provider=${provider.address}`;
    const domain = hushDomain(contracts.chainId, contracts.hushLedger);
    const unsigned = await fetch(url);
    const stranger = await fetch(url, { headers: { [CREDIT_AUTH_HEADER]: await creditAuthHeader(atlas.account, domain, veil.address, provider.address) } });
    const byOwner = await fetch(url, { headers: { [CREDIT_AUTH_HEADER]: await creditAuthHeader(owner.account, domain, veil.address, provider.address) } });
    assert(unsigned.status === 401 && stranger.status === 401, `unsigned ${unsigned.status}, stranger ${stranger.status}`);
    assert(byOwner.status === 200, `owner ${byOwner.status}`);
    return "unsigned → 401 · another agent → 401 · registered owner → 200";
  });

  await check("CreditReceipt: provider-signed, verifiable off-chain and on HushLedger", async () => {
    const [r] = (await veilPay.store.listReceipts()).slice(-1);
    assert(r, "no receipt stored");
    const receipt = receiptFromJson(r.receipt);
    assert(await isValidCreditReceipt(hushDomain(contracts.chainId, contracts.hushLedger), receipt, r.signature), "bad signature (off-chain)");
    const onchain = await publicClient.readContract({
      address: contracts.hushLedger,
      abi: hushLedgerAbi,
      functionName: "isValidCreditReceiptSignature",
      args: [receipt, r.signature],
    });
    assert(onchain, "HushLedger rejected the receipt signature");
    return `credited ${formatUsdc(receipt.creditedTotal)} for top-up ${txLink(receipt.topupTxHash)}`;
  });

  await check("what the public sees for the top-up: addresses + ciphertext, no amount (auditor can decrypt)", async () => {
    assert(topUpTx, "no top-up tx");
    const t = await readEercTransfer(publicClient as never, contracts, topUpTx);
    const audited = await auditor.eerc(contracts).auditorDecrypt(topUpTx);
    return `${t.from.slice(0, 8)}… → ${t.to.slice(0, 8)}…, ${t.publicSignals.length} proof signals, amount hidden; auditor decrypts ${formatUsdc(eercToAtomic(audited.units, contracts.eercDecimals))}`;
  });

  await check("Merkle batch committed to HushLedger; every voucher verifies on-chain", async () => {
    const res = await fetch(`${URLS.facilitator}/admin/commit`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } });
    if (!res.ok) throw new Error(`commit failed: ${res.status} ${await res.text()}`);
    const batch = (await res.json()) as { batchId?: string; txHash?: string };
    const v = await credit.verifyMyVouchers();
    assert(v.failed.length === 0, `${v.failed.length} vouchers failed inclusion`);
    assert(v.verified >= 5, `only ${v.verified} verified (${v.pending} pending)`);
    return `batch #${batch.batchId} ${batch.txHash ? txLink(batch.txHash) : ""}; ${v.verified} vouchers proven via verifyVoucherInclusion`;
  });

  // ── 3. policy ──
  await check("spend policy blocks an over-priced call before anything is signed", async () => {
    const strict = createHushFetch({ mode: "hush-credit", wallet: veil.account, eercClient: veilEerc, policy: { maxPerCall: 10_000n } });
    const before = (await strict.store.listPayments()).length;
    const err = await strict.fetch(FEED).then(
      (r) => new Error(`unexpected status ${r.status}`),
      (e: Error) => e,
    );
    assert(/offer|polic|reject|per-call/i.test(err.message), `unexpected: ${err.message}`);
    assert((await strict.store.listPayments()).length === before, "a payment was recorded");
    return err.message.slice(0, 90);
  });

  // ── 4. kill switch ──
  await check("kill switch: owner freezes Veil → facilitator rejects the next voucher → unfreeze restores", async () => {
    const freezeTx = await freezeAgent(owner.walletClient, publicClient, contracts.hushRegistry, veil.address);
    // Prove the facilitator enforces it (not just the honest client): hand-craft a voucher and ask /verify directly.
    const state = await credit.creditState(provider.address);
    const voucher = {
      agent: veil.address,
      provider: provider.address,
      cumulativeSpent: BigInt(state.settledCumulative) + 20_000n,
      nonce: BigInt(state.lastNonce) + 1n,
      requestHash: requestHashFor(FEED),
      expiry: BigInt(Math.floor(Date.now() / 1000) + 120),
    };
    const signature = await signVoucher(veil.account, hushDomain(contracts.chainId, contracts.hushLedger), voucher);
    const reqs = { scheme: "hush-credit", network: `eip155:${contracts.chainId}`, asset: contracts.usdc, amount: "20000", payTo: provider.address, maxTimeoutSeconds: 60, extra: {} };
    const verify = await fetch(`${URLS.facilitator}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2, paymentPayload: { x402Version: 2, resource: { url: FEED }, accepted: reqs, payload: { voucher: voucherToJson(voucher), signature } }, paymentRequirements: reqs }),
    }).then((r) => r.json() as Promise<{ isValid: boolean; invalidReason?: string }>);
    assert(!verify.isValid && verify.invalidReason === "agent_frozen", `facilitator said ${JSON.stringify(verify)}`);
    const blocked = await veilPay.fetch(FEED).then((r) => r.status, (e: Error) => e.message);
    assert(blocked !== 200, "frozen agent still got data");
    await unfreezeAgent(owner.walletClient, publicClient, contracts.hushRegistry, veil.address);
    const res = await veilPay.fetch(FEED);
    assert(res.status === 200, `after unfreeze: ${res.status}`);
    return `frozen ${txLink(freezeTx)} → /verify: agent_frozen → unfrozen → 200`;
  });

  // ── 5. flagging ──
  await check("flagging: owner flags the provider with a signed receipt as evidence", async () => {
    const [r] = (await veilPay.store.listReceipts()).slice(-1);
    assert(r, "no receipt");
    const evidence = { receipt: receiptFromJson(r.receipt), signature: r.signature };
    const before = (await publicClient.readContract({ address: contracts.hushRegistry, abi: hushRegistryAbi, functionName: "getProvider", args: [provider.address] })).flagCount;
    const alreadyFlagged = await publicClient.readContract({
      address: contracts.hushRegistry,
      abi: hushRegistryAbi,
      functionName: "hasFlagged",
      args: [owner.address, provider.address, evidenceHash(evidence)],
    });
    if (alreadyFlagged) return `already flagged with this evidence (flagCount ${before})`;
    const flagged = await flagProvider(owner.walletClient, publicClient, contracts.hushRegistry, provider.address, evidence);
    const after = (await publicClient.readContract({ address: contracts.hushRegistry, abi: hushRegistryAbi, functionName: "getProvider", args: [provider.address] })).flagCount;
    assert(after === before + 1, `flagCount ${before} → ${after}`);
    return `flagCount ${before} → ${after}, evidence ${flagged.evidenceHash.slice(0, 12)}…  ${txLink(flagged.txHash)}`;
  });

  // ── 6. refund ──
  await check("refund: unspent credit returned by a private eERC transfer (decrypted + checked by the agent)", async () => {
    const before = await credit.creditState(provider.address);
    const res = await credit.requestRefund(provider.address);
    const after = await credit.creditState(provider.address);
    assert(BigInt(after.available) < 10_000n, `still ${after.available} available`);
    return `refunded ${formatUsdc(BigInt(res.amount))} of ${formatUsdc(BigInt(before.available))}  ${res.txHash ? txLink(res.txHash) : ""}`;
  });

  // ── 7. hush-direct (reference) ──
  await check("hush-direct (reference): one eERC transfer per call", async () => {
    const direct = createHushFetch({ mode: "hush-direct", wallet: veil.account, eercClient: veilEerc });
    const t0 = performance.now();
    const res = await direct.fetch(FEED);
    if (res.status !== 200) throw new Error(`status ${res.status} ${await res.text()}`);
    const settle = paymentResponse(res);
    return `${secs(t0)} for ONE call (proof + tx) — why hush-credit exists  ${settle?.transaction ? txLink(settle.transaction) : ""}`;
  });

  // ── 8. privacy options ──
  await check("privacy: fixed chunk sizes + jittered pre-emptive top-up (not tied to call timing)", async () => {
    const jittered: string[] = [];
    const pay = createHushFetch({
      mode: "hush-credit",
      wallet: veil.account,
      eercClient: veilEerc,
      privacy: { topUpChunks: [1_000_000n], lowWatermark: 0.99, jitterMs: [1_500, 4_000] },
      onEvent: (e) => {
        onEvent(e);
        // The pre-emptive top-up is scheduled the moment the voucher is signed.
        if (e.type === "voucher:signed") scheduledAt = Date.now();
        if (e.type.startsWith("topup")) jittered.push(`${e.type}${"reason" in e ? `:${e.reason}` : ""}@${Date.now()}`);
      },
    });
    let scheduledAt = 0;
    const t0 = Date.now();
    const res = await pay.fetch(FEED); // credit is 0 after the refund → a needed top-up, then a scheduled pre-emptive one
    assert(res.status === 200, `status ${res.status}`);
    // Wait for the second credited top-up (the first was the blocking one the call needed).
    for (let i = 0; i < 60 && jittered.filter((j) => j.startsWith("topup:credited")).length < 2; i++) await sleep(500);
    const pre = jittered.filter((j) => j.startsWith("topup:start:preemptive"));
    assert(pre.length === 1, `expected one pre-emptive top-up, saw ${JSON.stringify(jittered)}`);
    const delay = Number(pre[0]!.split("@")[1]) - scheduledAt;
    assert(delay >= 1_400 && delay <= 4_600, `pre-emptive top-up fired ${delay}ms after scheduling, outside the 1.5–4 s window`);
    const receipts = await pay.store.listReceipts();
    assert(receipts.every((r) => r.amount === "1000000"), "a top-up was not exactly one chunk");
    pay.credit!.stop();
    return `every top-up exactly ${formatUsdc(1_000_000n)}; pre-emptive top-up fired ${(delay / 1000).toFixed(1)}s after scheduling (random in 1.5–4 s), total ${((Date.now() - t0) / 1000).toFixed(1)}s`;
  });

  // ── 9. expiry (optional; needs facilitator CREDIT_TTL_SECONDS small + EXPIRY_INTERVAL_SECONDS short) ──
  if (WITH_EXPIRY) {
    await check("credit expiry: unused credit auto-refunded after the TTL", async () => {
      const refundsBefore = (await (await fetch(`${URLS.facilitator}/stats`)).json()) as { privateRefunds: number };
      const state0 = await credit.creditState(provider.address);
      assert(state0.expiresAt, "no expiry scheduled (no top-up yet?)");
      const wait = Math.max(0, state0.expiresAt - Date.now()) + 15_000;
      await sleep(wait);
      const state1 = await credit.creditState(provider.address);
      const refundsAfter = (await (await fetch(`${URLS.facilitator}/stats`)).json()) as { privateRefunds: number };
      assert(BigInt(state1.available) < 10_000n, `still ${state1.available} available`);
      assert(refundsAfter.privateRefunds > refundsBefore.privateRefunds, "no refund recorded");
      return `after ~${Math.round(wait / 1000)}s: available ${formatUsdc(BigInt(state0.available))} → ${formatUsdc(BigInt(state1.available))}`;
    });
  }

  credit.stop();
  console.log("\nclient events:");
  for (const e of events) console.log(`  ${e}`);
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
