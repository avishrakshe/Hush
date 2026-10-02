/**
 * Hush facilitator — one process per provider.
 *
 *   x402 v2:  GET /supported · POST /verify · POST /settle      (exact + hush-credit + hush-direct)
 *   Hush:     POST /topup · GET /credit/:agent · POST /refund · GET /proof/:leaf · GET /batches · GET /stats
 *   Live:     GET /events (public: only what a chain observer can see) · GET /admin/events (provider, token)
 *   Jobs:     Merkle batch commit every BATCH_INTERVAL_SECONDS (padded when idle) · credit expiry · eERC sweep
 */
import { NET, NETWORK, PORTS, loadContracts, publicClient, txLink, wallet } from "@hush/config";
import { CREDIT_AUTH_HEADER, EXACT, HUSH_CREDIT, hushRegistryAbi, toCaip2 } from "@hush/x402";
import {
  type FacilitatorEvent,
  HushCreditFacilitatorScheme,
  HushDirectFacilitatorScheme,
  HushError,
  HushProviderService,
} from "@hush/x402/facilitator";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import express, { type NextFunction, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, type Hex, getAddress, isAddress, isHash, publicActions } from "viem";
import { SqliteCreditStore, openDb } from "./db/store.js";
import { EventHub, toJson } from "./events.js";

const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

// ─── setup ───────────────────────────────────────────────────────────────────
const contracts = loadContracts();
const network = toCaip2(contracts.chainId);
const provider = wallet("PROVIDER");
const facilitatorWallet = wallet("FACILITATOR");
const providerEerc = provider.eerc(contracts);
if (!(await providerEerc.isRegistered())) {
  throw new Error(`Provider ${provider.address} has no eERC key yet — run \`pnpm bootstrap${NETWORK === "localhost" ? ":local" : ""}\``);
}
await providerEerc.init(); // derives the provider's eERC decryption key from its wallet signature

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const db = openDb(process.env.FACILITATOR_DB || path.join(APP_DIR, ".data", `hush-${NETWORK}.db`));
const store = new SqliteCreditStore(db);

const publicEvents = new EventHub();
const adminEvents = new EventHub();
const ADMIN_TOKEN = process.env.PROVIDER_ADMIN_TOKEN || randomBytes(16).toString("hex");

/** Everything goes to the provider console; the public stream gets only what is already visible on-chain. */
function onServiceEvent(e: FacilitatorEvent) {
  adminEvents.publish(e.type, { ...e });
  switch (e.type) {
    case "topup": // sender, receiver and tx are public on-chain; the amount is not
      publicEvents.publish("topup", { agent: e.agent, payer: e.payer, txHash: e.txHash });
      break;
    case "batch": // a root per cadence tick — voucher count / dummy flag would leak activity
      publicEvents.publish("batch", { batchId: e.batchId, root: e.root, txHash: e.txHash });
      break;
    case "refund":
      publicEvents.publish("refund", { agent: e.agent, txHash: e.txHash });
      break;
    case "direct":
      publicEvents.publish("direct", { agent: e.agent, txHash: e.txHash });
      break;
    // "call" / "call:rejected" (hush-credit) stay private: even their timing would reveal call frequency.
  }
}

const service = new HushProviderService({
  contracts,
  publicClient: publicClient as never,
  providerSigner: provider.account,
  providerEerc,
  store,
  committer: facilitatorWallet.walletClient,
  creditTtlSeconds: Number(process.env.CREDIT_TTL_SECONDS || 7 * 24 * 3600),
  onEvent: onServiceEvent,
});

// x402 facilitator: public `exact` (the facilitator gas key submits EIP-3009 transfers) + both Hush schemes.
const viemClient = facilitatorWallet.walletClient.extend(publicActions);
const evmSigner = toFacilitatorEvmSigner({
  address: facilitatorWallet.address,
  getCode: (args) => viemClient.getCode(args),
  readContract: (args) => viemClient.readContract({ ...args, args: args.args || [] } as never),
  verifyTypedData: (args) => viemClient.verifyTypedData(args as never),
  writeContract: (args) => viemClient.writeContract({ ...args, args: args.args || [] } as never),
  sendTransaction: (args) => viemClient.sendTransaction(args),
  waitForTransactionReceipt: (args) => viemClient.waitForTransactionReceipt(args),
});
const x402 = new x402Facilitator()
  .register(network, new ExactEvmScheme(evmSigner, { eip6492AllowedFactories: [] }))
  .register(network, new HushCreditFacilitatorScheme(service))
  .register(network, new HushDirectFacilitatorScheme(service))
  .onAfterSettle(async ({ paymentPayload, requirements, result }) => {
    if (requirements.scheme !== EXACT || !result.success) return;
    // Public baseline: amount, payer and payee are all visible on-chain in the EIP-3009 transfer.
    const payer = result.payer ?? "";
    const resource = (paymentPayload as { resource?: { url?: string } }).resource?.url ?? "";
    store.addExactPayment({ txHash: result.transaction, payer, payTo: requirements.payTo, amount: requirements.amount, resource, settledAt: Date.now() });
    const e = { payer, payTo: requirements.payTo, amount: requirements.amount, txHash: result.transaction, resource };
    publicEvents.publish("exact", e);
    adminEvents.publish("exact", e);
  });

// ─── http ────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", `content-type, authorization, ${CREDIT_AUTH_HEADER}`);
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  next();
});

const send = (res: Response, body: unknown, status = 200) => res.status(status).type("application/json").send(toJson(body));
const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);
const addressParam = (v: unknown): Address => {
  if (typeof v !== "string" || !isAddress(v)) throw new HushError("invalid_address", "expected an address");
  return getAddress(v);
};
const hashParam = (v: unknown): Hex => {
  if (typeof v !== "string" || !isHash(v)) throw new HushError("invalid_hash", "expected a 32-byte hex hash");
  return v as Hex;
};

app.get("/health", (_req, res) => send(res, { ok: true, network, provider: provider.address, facilitator: facilitatorWallet.address }));

// x402 v2 facilitator protocol
app.get("/supported", (_req, res) => send(res, x402.getSupported()));
app.post(
  "/verify",
  wrap(async (req, res) => {
    const { paymentPayload, paymentRequirements } = req.body as { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };
    if (!paymentPayload || !paymentRequirements) throw new HushError("invalid_request", "missing paymentPayload or paymentRequirements");
    send(res, await x402.verify(paymentPayload, paymentRequirements));
  }),
);
app.post(
  "/settle",
  wrap(async (req, res) => {
    const { paymentPayload, paymentRequirements } = req.body as { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };
    if (!paymentPayload || !paymentRequirements) throw new HushError("invalid_request", "missing paymentPayload or paymentRequirements");
    send(res, await x402.settle(paymentPayload, paymentRequirements));
  }),
);

// Hush endpoints
app.post(
  "/topup",
  wrap(async (req, res) => {
    const { agent, txHash } = req.body as { agent?: string; txHash?: string };
    send(res, await service.processTopUp(agent ? addressParam(agent) : undefined, hashParam(txHash)));
  }),
);
// Signed by the agent or its owner: a public credit endpoint would leak every call through settledCumulative.
app.get(
  "/credit/:agent",
  wrap(async (req, res) => send(res, await service.authorizedCreditState(addressParam(req.params.agent), req.get(CREDIT_AUTH_HEADER)))),
);
app.post(
  "/refund",
  wrap(async (req, res) => {
    const { request, signature } = req.body as { request?: never; signature?: string };
    if (!request || !signature) throw new HushError("invalid_request", "expected { request, signature }");
    send(res, await service.requestRefund(request, signature as Hex));
  }),
);
app.get(
  "/proof/:leaf",
  wrap(async (req, res) => {
    const proof = await service.proofFor(hashParam(req.params.leaf));
    if (!proof) throw new HushError("not_found", "voucher not committed yet (or unknown)", 404);
    send(res, proof);
  }),
);
app.get(
  "/batches",
  wrap(async (_req, res) => {
    // Public view: roots and txs only (counts and dummy flags would reveal activity).
    const batches = await store.listBatches(provider.address, 50);
    send(res, batches.map(({ batchId, root, txHash, committedAt }) => ({ batchId, root, txHash, committedAt })));
  }),
);
app.get("/stats", (_req, res) => send(res, { network, ...store.stats(provider.address) }));
app.get("/exact-payments", (_req, res) => send(res, store.listExactPayments(100)));
app.get("/events", publicEvents.handler);

// Provider console (bearer token): full detail incl. per-call hush-credit amounts.
const requireAdmin = (req: Request, _res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.replace(/^Bearer /, "") ?? req.query.token;
  if (token !== ADMIN_TOKEN) return next(new HushError("unauthorized", "provider admin token required", 401));
  next();
};
app.get("/admin/events", requireAdmin, adminEvents.handler);
app.get(
  "/admin/overview",
  requireAdmin,
  wrap(async (_req, res) => {
    const credits = await store.listCredits(provider.address);
    send(res, {
      credits: credits.map((c) => service.toJson(c)),
      topUps: await store.listTopUps({ limit: 100 }),
      vouchers: await store.listVouchers({ limit: 100 }),
      batches: await store.listBatches(provider.address, 50),
      refunds: await store.listRefunds({ limit: 100 }),
      pendingIncoming: await service.pendingIncoming(),
    });
  }),
);

// Force a batch commit now (demos/tests; the cadence job keeps running regardless).
app.post(
  "/admin/commit",
  requireAdmin,
  wrap(async (_req, res) => send(res, (await service.commitBatch()) ?? { busy: true })),
);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HushError) return send(res, { error: err.message, code: err.code }, err.status);
  log("error:", err);
  send(res, { error: err instanceof Error ? err.message : "internal error", code: "internal" }, 500);
});

// ─── jobs ────────────────────────────────────────────────────────────────────
const BATCH_INTERVAL = Number(process.env.BATCH_INTERVAL_SECONDS || (NETWORK === "localhost" ? 20 : 120)) * 1000;
const SWEEP_THRESHOLD = 250; // eERC reverts incoming transfers at 300 pending

function every(ms: number, name: string, job: () => Promise<void>) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await job();
    } catch (err) {
      log(`${name} failed:`, (err as Error).message);
    } finally {
      running = false;
    }
  };
  setInterval(tick, ms).unref();
}

every(BATCH_INTERVAL, "batch", async () => {
  const b = await service.commitBatch();
  if (b) log(`batch #${b.batchId} ${b.dummy ? "(padding)" : `(${b.voucherCount} vouchers)`} ${txLink(b.txHash)}`);
});
every(Number(process.env.EXPIRY_INTERVAL_SECONDS || 60) * 1000, "expiry", async () => {
  for (const r of await service.expireCredits()) log(`expired credit refunded: ${r.amount} → ${r.credit.agent} ${r.txHash ? txLink(r.txHash) : ""}`);
});
every(5 * 60_000, "sweep", async () => {
  // Any outgoing transfer prunes the provider's pending-incoming list; a 1-unit self-transfer is the cheapest one.
  if ((await service.pendingIncoming()) > SWEEP_THRESHOLD) {
    const { txHash } = await providerEerc.transfer(provider.address, 1n, "hush:sweep:v1");
    log(`swept pending eERC history ${txLink(txHash)}`);
  }
});

// Kill-switch visibility: freezes are public on-chain, so both streams show them.
publicClient.watchContractEvent({
  address: contracts.hushRegistry,
  abi: hushRegistryAbi,
  pollingInterval: 2_000,
  onLogs: (logs) => {
    for (const l of logs) {
      if (l.eventName !== "AgentFrozen" && l.eventName !== "AgentUnfrozen") continue;
      const e = { agent: (l.args as { agent: Address }).agent, txHash: l.transactionHash };
      const type = l.eventName === "AgentFrozen" ? "frozen" : "unfrozen";
      publicEvents.publish(type, e);
      adminEvents.publish(type, e);
    }
  },
});

app.listen(PORTS.facilitator, () => {
  log(`Hush facilitator on http://localhost:${PORTS.facilitator}  (${NETWORK}, chain ${NET.chain.id})`);
  log(`  provider    ${provider.address}`);
  log(`  gas/batches ${facilitatorWallet.address}  every ${BATCH_INTERVAL / 1000}s`);
  log(`  schemes     ${x402.getSupported().kinds.map((k) => k.scheme).join(", ")}  (${HUSH_CREDIT} is the product)`);
  if (!process.env.PROVIDER_ADMIN_TOKEN) log(`  admin token ${ADMIN_TOKEN}  (set PROVIDER_ADMIN_TOKEN to pin it)`);
});
