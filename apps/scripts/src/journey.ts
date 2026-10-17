/**
 * The whole private agent journey, end to end, with a brand-new agent ("Scout") so its desk history starts at
 * statement #1 and its trade report can be complete:
 *
 *   fresh agent (eERC key, registered under OWNER, private allocation) → verify signal providers before paying →
 *   buy a signal (hush-credit) → desk quote → buy (hush-rfq) → positions → sell → settle-out (private hStock) →
 *   vouchers in HushLedger roots → trade report (complete, anchored, P&L) → tampered reports caught →
 *   public footprint: no USDC or mStock ever moved for the agent
 *
 * Usage: pnpm journey[:local]   (needs bootstrap + facilitator, provider, price bot and desk running; after the
 *         providers have committed a few epochs, Proof of Alpha can verify SignalCo — otherwise that check notes it)
 */
import { NET, NETWORK, URLS, loadContracts, circuitPaths, publicClient, txLink, wallet } from "@hush/config";
import {
  EercAccount,
  type TradeReport,
  alphaDomain,
  chooseProvider,
  eercToAtomic,
  formatShares,
  formatUsdc,
  hushRegistryAbi,
  latestRound,
  registerAgent,
  signAgentConsent,
  signalFromJson,
  signalTyped,
  verifyTradeReport,
  buildTradeReport,
  type SignalRecordJson,
} from "@hush/x402";
import { HushDeskClient, HushFacilitatorApi, createHushFetch } from "@hush/x402/client";
import { type Address, type Hex, createWalletClient, http, parseAbiItem, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const contracts = loadContracts();
const owner = wallet("OWNER");
const results: { check: string; result: "PASS" | "FAIL"; detail: string }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function check(name: string, fn: () => Promise<string>) {
  process.stdout.write(`▸ ${name} … `);
  try {
    const detail = await fn();
    results.push({ check: name, result: "PASS", detail });
    console.log(`PASS  ${detail}`);
  } catch (err) {
    const detail = (err as Error).message.split("\n")[0]!.slice(0, 220);
    results.push({ check: name, result: "FAIL", detail });
    console.log(`FAIL  ${detail}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
/** Poll until `fn` returns a value (or time runs out). */
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined>, timeoutMs: number, everyMs = 3_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

async function main() {
  assert(contracts.hushAlpha && contracts.stocks?.NVDA && contracts.stockOracle, "deployment has no desk contracts");
  const batchMs = Number(process.env.BATCH_INTERVAL_SECONDS || (NETWORK === "localhost" ? 20 : 120)) * 1000;
  console.log(`Hush agent journey on ${NETWORK} · desk ${URLS.desk} · provider ${URLS.provider}\n`);

  // A throwaway agent identity for this run (testnet/local only; never reused).
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  const walletClient = createWalletClient({ account, chain: NET.chain, transport: http(NET.rpc) });
  const eerc = new EercAccount({ publicClient: publicClient as never, walletClient, contracts, circuits: circuitPaths() });
  const agent = account.address;
  const hush = createHushFetch({
    mode: "hush-credit",
    wallet: account,
    eercClient: eerc,
    publicClient: publicClient as never,
    // fixed chunk sizes: 5 hUSDC tops up the signal provider, 20 hUSDC the desk
    privacy: { topUpChunks: [5_000_000n, 20_000_000n], jitterMs: [0, 0] },
    tradePolicy: { maxNotionalPerTrade: 25_000_000n },
  });
  const desk = new HushDeskClient({ deskUrl: URLS.desk, hush, signer: account });
  const startBlock = await publicClient.getBlockNumber();

  await check("a fresh agent: gas, eERC key, registered under the owner, 40 hUSDC allocated privately", async () => {
    const gas = await owner.walletClient.sendTransaction({ to: agent, value: parseEther(NETWORK === "localhost" ? "1" : "0.02") });
    await publicClient.waitForTransactionReceipt({ hash: gas });
    await eerc.register();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const consent = await signAgentConsent(account, { registry: contracts.hushRegistry, chainId: contracts.chainId, owner: owner.address, deadline });
    await registerAgent(owner.walletClient, publicClient, { registry: contracts.hushRegistry, agent, metadataURI: "hush://agent/scout", deadline, consent });
    const ownerEerc = owner.eerc(contracts);
    if ((await ownerEerc.balance()).decrypted < 4_000n) await ownerEerc.deposit(100_000_000n);
    const { txHash } = await ownerEerc.transfer(agent, 4_000n);
    const { units } = await eerc.decryptIncoming(txHash);
    assert(units === 4_000n, `agent decrypts ${units}`);
    const info = await publicClient.readContract({ address: contracts.hushRegistry, abi: hushRegistryAbi, functionName: "getAgent", args: [agent] });
    assert(info.owner.toLowerCase() === owner.address.toLowerCase(), "not registered under the owner");
    return `Scout ${agent} · allocation ${formatUsdc(eercToAtomic(units, contracts.eercDecimals))} decrypted by Scout  ${txLink(txHash)}`;
  });

  let signalBase = URLS.provider;
  await check("provider choice: both signal providers verified before paying — AlphaKing is never chosen", async () => {
    const { chosen, checks } = await chooseProvider([URLS.provider, URLS.alphaking], {
      publicClient: publicClient as never,
      oracle: contracts.stockOracle!,
      hushAlpha: contracts.hushAlpha,
      chainId: contracts.chainId,
      policy: { minWinRate: 0, minCalls: 1 },
    });
    const king = checks.find((c) => c.url === URLS.alphaking)!;
    const co = checks.find((c) => c.url === URLS.provider)!;
    assert(!chosen || chosen.url === URLS.provider, `chose ${chosen?.name}`);
    assert(!king.passes, `AlphaKing passed: ${king.why}`);
    if (chosen) signalBase = chosen.url;
    return `SignalCo: ${co.why} · AlphaKing: ${king.why}`;
  });

  await check("buy a signal privately (hush-credit): one encrypted top-up, then a voucher — the call is provider-signed", async () => {
    const res = await hush.fetch(`${signalBase}/api/signal?ticker=NVDA`);
    assert(res.status === 200, `HTTP ${res.status}`);
    const s = (await res.json()) as { direction: string; confidence: number; record?: SignalRecordJson; signature?: Hex };
    assert(s.record && s.signature, "no signed record");
    assert(await signalTyped.isValid(alphaDomain(contracts.chainId, contracts.hushAlpha!), signalFromJson(s.record), s.signature), "signature is not the provider's");
    const topUps = (await hush.store.listReceipts()).length;
    return `NVDA ${s.direction} (${s.confidence}) · ${topUps} top-up receipt(s) · signature checked on the HushAlpha domain`;
  });

  await check("desk quote: firm, desk-signed, priced off the on-chain oracle", async () => {
    const { quote } = await desk.quote("NVDA", "buy", "0.10");
    const mark = (await latestRound(publicClient, contracts.stockOracle!, "NVDA")).price;
    const spreadBps = Number(((quote.price - mark) * 10_000n) / mark);
    assert(spreadBps >= 0 && spreadBps < 100, `spread ${spreadBps} bps`);
    return `0.10 NVDA @ $${(Number(quote.price) / 1e6).toFixed(2)} (oracle $${(Number(mark) / 1e6).toFixed(2)}, +${spreadBps} bps) · expires ${new Date(Number(quote.expiry) * 1000).toISOString().slice(11, 19)}`;
  });

  await check("buy 0.10 NVDA via hush-rfq: desk-signed fill + statement #1, no trade transaction", async () => {
    const r = await desk.buy("NVDA", "0.10");
    assert(r.statement.seq === 1n && r.statement.position === 10n, `statement #${r.statement.seq} position ${r.statement.position}`);
    return `filled @ $${(Number(r.fill.price) / 1e6).toFixed(2)} · voucher ${r.voucherLeaf.slice(0, 12)}… (off-chain)`;
  });

  await check("positions: desk-signed custody of 0.10 NVDA, matching the agent's own fills", async () => {
    const audit = await desk.verifyPositions();
    const nvda = audit.positions.find((p) => p.ticker === "NVDA");
    assert(audit.ok && nvda?.position === 10n, `issues: ${audit.issues.join("; ")}`);
    return `NVDA ${formatShares(nvda.position)} @ avg $${(Number(nvda.avgCost) / 1e6).toFixed(2)} · statement #${nvda.seq}`;
  });

  await check("sell 0.04 NVDA: a signed order, proceeds credited to desk credit, statement #2", async () => {
    const r = await desk.sell("NVDA", "0.04");
    assert(r.statement.seq === 2n && r.statement.position === 6n, `statement #${r.statement.seq} position ${r.statement.position}`);
    return `proceeds ${formatUsdc(r.proceeds)} · desk credit available ${formatUsdc(BigInt(r.credit.available))}`;
  });

  let settleTx: Hex | undefined;
  await check("settle-out 0.02 NVDA: one private hNVDA transfer to the agent, who decrypts exactly 0.02", async () => {
    const { settleOut, statement } = await desk.settleOut("NVDA", "0.02");
    assert(statement.seq === 3n && statement.position === 4n, `statement #${statement.seq} position ${statement.position}`);
    const sent = await waitFor(
      "the settle-out transfer",
      async () => (await desk.settleOuts()).find((s) => s.requestId === settleOut.requestId && s.status === "sent"),
      batchMs * 4,
    );
    settleTx = sent.txHash!;
    const { units, transfer } = await eerc.decryptIncoming(settleTx);
    assert(units === 2n, `decrypted ${units} units`);
    return `tokenId ${transfer.tokenId} · Scout decrypts ${formatShares(units)} share  ${txLink(settleTx)}`;
  });

  const proofs = new HushFacilitatorApi(URLS.desk);
  await check("every desk voucher (buy payment + sell order) lands in a HushLedger batch root", async () => {
    const leaves = (await hush.store.listFills()).map((f) => f.voucherLeaf!).filter(Boolean);
    assert(leaves.length === 2, `${leaves.length} fills`);
    const found = await waitFor("both vouchers to be committed", async () => {
      const ps = await Promise.all(leaves.map((l) => proofs.proof(l)));
      return ps.every(Boolean) ? ps : null;
    }, batchMs * 4);
    return found.map((p) => `batch #${p!.batchId}`).join(" · ");
  });

  let report: TradeReport | undefined;
  let deskAddress: Address | undefined;
  const anchors = () => ({ desk: deskAddress, hushLedger: contracts.hushLedger, hushAlpha: contracts.hushAlpha, chainId: contracts.chainId });
  await check("trade report: valid, complete (statements 1…3), every fill anchored on HushLedger, P&L replays the desk", async () => {
    deskAddress = (await (await fetch(`${URLS.desk}/`)).json() as { desk: Address }).desk;
    report = await buildTradeReport({
      store: hush.store,
      agent,
      desk: deskAddress,
      chainId: contracts.chainId,
      hushAlpha: contracts.hushAlpha!,
      hushLedger: contracts.hushLedger,
      proof: (leaf) => proofs.proof(leaf),
    });
    // The verifier pins what it trusts: the desk's public address and our deployment — never the report's own claims.
    const r = await verifyTradeReport(report, { publicClient: publicClient as never, oracle: contracts.stockOracle, expect: anchors() });
    assert(r.valid && r.complete, r.reason ?? r.incompleteBecause ?? "not valid");
    assert(r.lastSeq === "3" && r.committedOnChain === 2 && r.settleOuts === 1, `seq ${r.lastSeq}, anchored ${r.committedOnChain}`);
    const nvda = r.tickers.find((t) => t.ticker === "NVDA")!;
    assert(nvda.matchesDesk && nvda.position === "4", `NVDA ${nvda.position}`);
    return `2 fills + 1 settle-out · realized ${formatUsdc(BigInt(r.realizedPnl))} · unrealized ${r.unrealizedPnl ? formatUsdc(BigInt(r.unrealizedPnl)) : "–"}`;
  });

  await check("a cherry-picked report (sell dropped) is caught; an edited fill price and a fake desk are rejected", async () => {
    assert(report, "no report");
    const sellIdx = report.fills.findIndex((f) => f.fill.side === 2);
    const cherry: TradeReport = { ...report, fills: report.fills.filter((_, i) => i !== sellIdx) };
    const a = await verifyTradeReport(cherry, { publicClient: publicClient as never, expect: anchors() });
    assert(a.valid && !a.complete, "dropping the sell went unnoticed");
    const edited: TradeReport = { ...report, fills: report.fills.map((f, i) => (i === 0 ? { ...f, fill: { ...f.fill, price: "1" } } : f)) };
    const b = await verifyTradeReport(edited, { publicClient: publicClient as never, expect: anchors() });
    assert(!b.valid, "edited price accepted");
    // A report re-signed by a key the agent controls, posing as the desk, fails the pin.
    const posing = await verifyTradeReport({ ...report, desk: agent }, { publicClient: publicClient as never, expect: anchors() });
    assert(!posing.valid, "a fake desk was accepted");
    return `dropped sell → "${a.incompleteBecause}" · edited price → "${b.reason}" · fake desk → refused`;
  });

  await check("public footprint: no USDC or mStock ever moved to or from the agent", async () => {
    const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
    const tokens = [contracts.usdc, ...(Object.values(contracts.stocks!) as Address[])];
    const range = { fromBlock: startBlock, toBlock: await publicClient.getBlockNumber() };
    const [out, inn] = await Promise.all([
      publicClient.getLogs({ address: tokens, event: transfer, args: { from: agent }, ...range }),
      publicClient.getLogs({ address: tokens, event: transfer, args: { to: agent }, ...range }),
    ]);
    assert(out.length + inn.length === 0, `${out.length + inn.length} public token transfers`);
    return "0 public token transfers — only encrypted eERC transfers (allocation, 2 top-ups, settle-out) and batch roots";
  });

  console.log();
  console.table(results.map(({ check: c, result }) => ({ check: c, result })));
  const failed = results.filter((r) => r.result === "FAIL").length;
  console.log(failed ? `${failed} check(s) FAILED` : `all ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
