/**
 * Hush operator — the privileged half of the web consoles, run on the owner's machine next to the agents.
 *
 *   Owner:    reveal an agent's sealed telemetry · credit (owner-signed query) · voucher & receipt audit · treasury ·
 *             kill switch · decrypt the agent's transfers with the agent's eERC key
 *   Auditor:  reveal sealed telemetry · decrypt any eERC transfer amount (auditor PCT)
 *   Provider: facilitator admin overview, live admin events, commit-now (holds PROVIDER_ADMIN_TOKEN)
 *
 * It holds the demo's owner, auditor and provider-admin credentials so the browser never does. Loopback only; the
 * Host header is checked (DNS rebinding) and state-changing calls need the `x-hush-operator` header, which forces a
 * CORS preflight that only the web console's origin passes.
 *
 *   pnpm operator          (Fuji)   ·   pnpm operator:local
 */
import { NETWORK, type Role, URLS, loadContracts, publicClient, wallet } from "@hush/config";
import {
  type EercAccount,
  type Sealed,
  creditAuthHeader,
  eercToAtomic,
  freezeAgent,
  hushDomain,
  hushLedgerAbi,
  hushRegistryAbi,
  isRecipient,
  isValidCreditReceipt,
  mockUsdcAbi,
  receiptFromJson,
  unfreezeAgent,
  unseal,
  verifyMerkleProof,
  voucherFromJson,
} from "@hush/x402";
import { HushFacilitatorApi } from "@hush/x402/client";
import { type HushStoreData, emptyStoreData } from "@hush/x402/client";
import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, type Hex, isAddressEqual, isHash } from "viem";
import { followSse, toJson } from "./sse.js";

const PORT = Number(process.env.OPERATOR_PORT || 4040);
const ORIGINS = (process.env.OPERATOR_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000").split(",").map((o) => o.trim());
const ADMIN_TOKEN = process.env.PROVIDER_ADMIN_TOKEN || "";
const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

const contracts = loadContracts();
const domain = hushDomain(contracts.chainId, contracts.hushLedger);
const owner = wallet("OWNER");
const auditor = wallet("AUDITOR");
const facilitator = new HushFacilitatorApi(URLS.facilitator);

// Same ids and ports as apps/agent/src/profiles.ts.
const AGENTS = {
  atlas: { id: "atlas", name: "Atlas", role: "ATLAS" as Role, mode: "public", port: Number(process.env.ATLAS_PORT || 4031) },
  veil: { id: "veil", name: "Veil", role: "VEIL" as Role, mode: "hush-credit", port: Number(process.env.VEIL_PORT || 4032) },
} as const;
type AgentId = keyof typeof AGENTS;
const agentWallets = { atlas: wallet("ATLAS"), veil: wallet("VEIL") };
const telemetryUrl = (id: AgentId) => `http://127.0.0.1:${AGENTS[id].port}`;
const AGENT_DATA = fileURLToPath(new URL("../../agent/.data/", import.meta.url));

// eERC accounts, keys derived lazily from each wallet's signature (nothing leaves this process).
const accounts = new Map<string, Promise<EercAccount>>();
const eercOf = (w: ReturnType<typeof wallet>) => {
  let a = accounts.get(w.address);
  if (!a) {
    a = w.eerc(contracts).init();
    accounts.set(w.address, a);
  }
  return a;
};
const viewer = (as: "owner" | "auditor") => eercOf(as === "owner" ? owner : auditor);

let providerAddress: Address | undefined;
async function provider(): Promise<Address> {
  providerAddress ??= ((await publicClient.readContract({ address: contracts.hushRegistry, abi: hushRegistryAbi, functionName: "getProviders" })) as Address[])[0];
  if (!providerAddress) throw new OperatorError(503, "no provider registered in HushRegistry");
  return providerAddress;
}

class OperatorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ─── http plumbing ───────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "64kb" }));
app.use((req, res, next) => {
  const host = (req.headers.host ?? "").toLowerCase();
  if (host !== `localhost:${PORT}` && host !== `127.0.0.1:${PORT}`) return void res.status(403).json({ error: "operator is loopback-only" });
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-headers", "content-type, x-hush-operator");
    res.setHeader("access-control-allow-methods", "GET, POST");
  }
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  if (req.method !== "GET" && req.headers["x-hush-operator"] !== "1") return void res.status(403).json({ error: "missing x-hush-operator header" });
  next();
});
const send = (res: Response, body: unknown, status = 200) => res.status(status).type("application/json").send(toJson(body));
const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);
const agentParam = (v: unknown): AgentId => {
  if (v !== "atlas" && v !== "veil") throw new OperatorError(404, "unknown agent (atlas | veil)");
  return v;
};
const asParam = (v: unknown): "owner" | "auditor" => (v === "auditor" ? "auditor" : "owner");
function sseHeaders(res: Response) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
}

// Owner transactions go out one at a time (nonce ordering).
let ownerQueue: Promise<unknown> = Promise.resolve();
const asOwner = <T>(fn: () => Promise<T>) => {
  const run = ownerQueue.then(fn, fn);
  ownerQueue = run.catch(() => undefined);
  return run;
};

// ─── discovery ───────────────────────────────────────────────────────────────
app.get(
  "/health",
  wrap(async (_req, res) =>
    send(res, {
      ok: true,
      network: NETWORK,
      chainId: contracts.chainId,
      contracts,
      owner: owner.address,
      auditor: auditor.address,
      provider: await provider().catch(() => null),
      facilitator: URLS.facilitator,
      providerAdmin: ADMIN_TOKEN !== "",
      agents: Object.values(AGENTS).map((a) => ({ id: a.id, name: a.name, mode: a.mode, address: agentWallets[a.id].address, telemetry: telemetryUrl(a.id) })),
    }),
  ),
);

// ─── reveal: the agent's sealed telemetry, decrypted as owner or auditor ─────
type AgentEvent = { id: number; at: number; agent: string; type?: string; data?: unknown; sealed?: Sealed };

app.get("/reveal/:agent", (req, res) => {
  reveal(req, res).catch((err: Error) => {
    if (!res.headersSent) send(res, { error: err.message.split("\n")[0] }, err instanceof OperatorError ? err.status : 500);
    else res.end();
  });
});

async function reveal(req: Request, res: Response) {
  const id = agentParam(req.params.agent);
  const as = asParam(req.query.as);
  const account = await viewer(as);
  sseHeaders(res);
  const ac = new AbortController();
  req.on("close", () => ac.abort());
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  res.write(`event: meta\ndata: ${toJson({ as, address: account.address, agent: id })}\n\n`);

  await followSse(
    `${telemetryUrl(id)}/events`,
    async (raw) => {
      const e = JSON.parse(raw) as AgentEvent;
      let out: Record<string, unknown>;
      if (!e.sealed) {
        out = { id: e.id, at: e.at, type: e.type, data: e.data, sealed: false };
      } else if (!isRecipient(account, e.sealed)) {
        out = { id: e.id, at: e.at, sealed: true, locked: true };
      } else {
        const opened = JSON.parse(await unseal(account, e.sealed)) as { type: string; data: unknown };
        out = { id: e.id, at: e.at, type: opened.type, data: opened.data, sealed: true };
      }
      res.write(`id: ${e.id}\ndata: ${toJson(out)}\n\n`);
    },
    { signal: ac.signal, onDown: () => res.write(`event: offline\ndata: {}\n\n`) },
  );
  clearInterval(ping);
}

/** The agent's latest state (budget, last decision) — sealed for private agents. */
app.get(
  "/agents/:agent/state",
  wrap(async (req, res) => {
    const id = agentParam(req.params.agent);
    const state = (await fetch(`${telemetryUrl(id)}/state`).then((r) => r.json()).catch(() => null)) as { sealed?: Sealed } | null;
    if (!state) return send(res, null);
    if (!state.sealed) return send(res, state);
    const account = await viewer(asParam(req.query.as));
    return send(res, JSON.parse(await unseal(account, state.sealed)));
  }),
);

// ─── registry status + kill switch ───────────────────────────────────────────
app.get(
  "/agents/:agent",
  wrap(async (req, res) => {
    const id = agentParam(req.params.agent);
    const address = agentWallets[id].address;
    const [info, health] = await Promise.all([
      publicClient.readContract({ address: contracts.hushRegistry, abi: hushRegistryAbi, functionName: "getAgent", args: [address] }),
      fetch(`${telemetryUrl(id)}/health`).then((r) => r.json() as Promise<Record<string, unknown>>).catch(() => null),
    ]);
    send(res, {
      id,
      name: AGENTS[id].name,
      mode: AGENTS[id].mode,
      address,
      registered: info.registeredAt !== 0n,
      owner: info.owner,
      ownedByOperator: isAddressEqual(info.owner, owner.address),
      frozen: info.frozen,
      metadataURI: info.metadataURI,
      running: !!health,
    });
  }),
);

for (const action of ["freeze", "unfreeze"] as const) {
  app.post(
    `/agents/:agent/${action}`,
    wrap(async (req, res) => {
      const id = agentParam(req.params.agent);
      const address = agentWallets[id].address;
      const txHash = await asOwner(() =>
        (action === "freeze" ? freezeAgent : unfreezeAgent)(owner.walletClient, publicClient, contracts.hushRegistry, address),
      );
      log(`${action} ${AGENTS[id].name} ${txHash}`);
      send(res, { txHash, frozen: action === "freeze" });
    }),
  );
}

// ─── credit + the agent's own ledger (vouchers, receipts) ─────────────────────
app.get(
  "/agents/:agent/credit",
  wrap(async (req, res) => {
    const id = agentParam(req.params.agent);
    const agent = agentWallets[id].address;
    const p = await provider();
    // The owner signs the query: the facilitator accepts the agent or its registered owner, nobody else.
    send(res, await facilitator.credit(agent, p, await creditAuthHeader(owner.account, domain, agent, p)));
  }),
);

function readLedger(id: AgentId): HushStoreData {
  const file = path.join(AGENT_DATA, `${id}-${NETWORK}.json`);
  if (!existsSync(file)) return emptyStoreData();
  // Read-only: the running agent owns this file. Files written before v2 lack the trading arrays.
  return { ...emptyStoreData(), ...(JSON.parse(readFileSync(file, "utf8")) as Partial<HushStoreData>) };
}

/** Per-leaf on-chain inclusion results (this process only; never written back into the agent's file). */
const inclusion = new Map<string, { batchId: string; verified: boolean }>();

app.get(
  "/agents/:agent/ledger",
  wrap(async (req, res) => {
    const id = agentParam(req.params.agent);
    const l = readLedger(id);
    const vouchers = l.vouchers.map((v) => {
      const inc = inclusion.get(v.leaf.toLowerCase());
      return { ...v, batchId: v.batchId ?? inc?.batchId, verifiedOnChain: v.verifiedOnChain || inc?.verified === true, inclusionFailed: inc?.verified === false };
    });
    const spent = l.payments.reduce((s, p) => s + BigInt(p.amount), 0n);
    send(res, {
      totals: { payments: l.payments.length, spent: spent.toString(), vouchers: l.vouchers.length, receipts: l.receipts.length, refunds: l.refunds.length },
      payments: l.payments.slice(-200).reverse(),
      vouchers: vouchers.slice(-200).reverse(),
      receipts: l.receipts.slice(-50).reverse(),
      refunds: l.refunds.slice(-50).reverse(),
    });
  }),
);

/**
 * Audits the agent's copies against the chain: every settled voucher must sit in a Merkle root the provider committed
 * to HushLedger (checked by HushLedger.verifyVoucherInclusion), and every CreditReceipt must carry the provider's
 * signature (checked off-chain and by HushLedger.isValidCreditReceiptSignature).
 */
app.post(
  "/agents/:agent/verify",
  wrap(async (req, res) => {
    const id = agentParam(req.params.agent);
    const l = readLedger(id);
    const out = { vouchers: { verified: 0, pending: 0, failed: 0 }, receipts: { valid: 0, invalid: 0 } };

    for (const v of l.vouchers) {
      if (v.status !== "settled") continue;
      const known = inclusion.get(v.leaf.toLowerCase());
      if (known?.verified || v.verifiedOnChain) {
        out.vouchers.verified++;
        continue;
      }
      const proof = await facilitator.proof(v.leaf);
      if (!proof) {
        out.vouchers.pending++;
        continue;
      }
      const onchain = await publicClient.readContract({
        address: contracts.hushLedger,
        abi: hushLedgerAbi,
        functionName: "verifyVoucherInclusion",
        args: [BigInt(proof.batchId), voucherFromJson(v.voucher), v.signature, proof.proof],
      });
      const ok = onchain && verifyMerkleProof(proof.root, v.leaf, proof.proof);
      inclusion.set(v.leaf.toLowerCase(), { batchId: proof.batchId, verified: ok });
      if (ok) out.vouchers.verified++;
      else out.vouchers.failed++;
    }

    for (const r of l.receipts) {
      const receipt = receiptFromJson(r.receipt);
      const [offchain, onchain] = await Promise.all([
        isValidCreditReceipt(domain, receipt, r.signature),
        publicClient.readContract({ address: contracts.hushLedger, abi: hushLedgerAbi, functionName: "isValidCreditReceiptSignature", args: [receipt, r.signature] }),
      ]);
      if (offchain && onchain) out.receipts.valid++;
      else out.receipts.invalid++;
    }
    send(res, out);
  }),
);

// ─── decrypting eERC transfers ────────────────────────────────────────────────
const decrypted = new Map<string, { txHash: Hex; from: Address; to: Address; amount: string; via: string }>();

/**
 * Amounts of eERC transfers, decrypted locally.
 *   as=auditor → the auditor PCT every transfer carries (any transfer, straight from calldata)
 *   as=owner   → the owner's agents' keys: receiver PCT for incoming, the agent's own receipts for its top-ups,
 *                the SDK's balance-history diff for anything else it sent (slower)
 */
app.post(
  "/decrypt/transfers",
  wrap(async (req, res) => {
    const { txHashes, as } = req.body as { txHashes?: unknown; as?: unknown };
    if (!Array.isArray(txHashes) || txHashes.length > 50 || !txHashes.every((h) => typeof h === "string" && isHash(h))) {
      throw new OperatorError(400, "expected { txHashes: Hex[] (max 50), as }");
    }
    const mode = asParam(as);
    const results = [];
    for (const txHash of txHashes as Hex[]) {
      const key = `${mode}:${txHash.toLowerCase()}`;
      const cached = decrypted.get(key);
      if (cached) {
        results.push(cached);
        continue;
      }
      try {
        const r = mode === "auditor" ? await auditorAmount(txHash) : await ownerAmount(txHash);
        decrypted.set(key, r);
        results.push(r);
      } catch (err) {
        results.push({ txHash, error: (err as Error).message.split("\n")[0] });
      }
    }
    send(res, results);
  }),
);

async function auditorAmount(txHash: Hex) {
  const a = await (await viewer("auditor")).auditorDecrypt(txHash);
  return { txHash, from: a.from, to: a.to, amount: eercToAtomic(a.units, contracts.eercDecimals).toString(), via: "auditor PCT" };
}

async function ownerAmount(txHash: Hex) {
  const ownerEerc = await eercOf(owner);
  const t = await ownerEerc.readTransfer(txHash);
  const atomic = (units: bigint) => eercToAtomic(units, contracts.eercDecimals).toString();
  for (const id of Object.keys(AGENTS) as AgentId[]) {
    const w = agentWallets[id];
    if (isAddressEqual(t.to, w.address)) {
      const { units } = await (await eercOf(w)).decryptIncoming(txHash);
      return { txHash, from: t.from, to: t.to, amount: atomic(units), via: `${AGENTS[id].name}'s key (receiver PCT)` };
    }
    if (isAddressEqual(t.from, w.address)) {
      const receipt = readLedger(id).receipts.find((r) => r.receipt.topupTxHash.toLowerCase() === txHash.toLowerCase());
      if (receipt) return { txHash, from: t.from, to: t.to, amount: receipt.amount, via: `${AGENTS[id].name}'s signed CreditReceipt` };
      return { txHash, from: t.from, to: t.to, amount: atomic(await (await eercOf(w)).decryptOutgoing(txHash)), via: `${AGENTS[id].name}'s key (balance history)` };
    }
  }
  if (isAddressEqual(t.from, owner.address)) {
    return { txHash, from: t.from, to: t.to, amount: atomic(await ownerEerc.decryptOutgoing(txHash)), via: "owner's key (balance history)" };
  }
  throw new OperatorError(403, "not a transfer of the owner or its agents");
}

// ─── treasury ────────────────────────────────────────────────────────────────
app.get(
  "/treasury",
  wrap(async (_req, res) => {
    const eerc = await eercOf(owner);
    const [bal, usdc, agents] = await Promise.all([
      eerc.balance(),
      publicClient.readContract({ address: contracts.usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [owner.address] }),
      publicClient.readContract({ address: contracts.hushRegistry, abi: hushRegistryAbi, functionName: "getAgentsByOwner", args: [owner.address] }),
    ]);
    send(res, {
      owner: owner.address,
      publicUsdc: usdc.toString(),
      privateHusdc: eercToAtomic(bal.decrypted, contracts.eercDecimals).toString(),
      encryptedBalance: bal.encrypted.map((x) => x.toString()),
      agents,
    });
  }),
);

// ─── provider console: facilitator admin API behind the token ─────────────────
const admin = (p: string, init?: RequestInit) => {
  if (!ADMIN_TOKEN) throw new OperatorError(503, "PROVIDER_ADMIN_TOKEN is not set in .env");
  return fetch(`${URLS.facilitator}${p}`, { ...init, headers: { ...init?.headers, authorization: `Bearer ${ADMIN_TOKEN}` } });
};
app.get(
  "/provider/overview",
  wrap(async (_req, res) => {
    const r = await admin("/admin/overview");
    send(res, await r.json(), r.status);
  }),
);
app.post(
  "/provider/commit",
  wrap(async (_req, res) => {
    const r = await admin("/admin/commit", { method: "POST" });
    send(res, await r.json(), r.status);
  }),
);
app.get("/provider/events", async (req, res) => {
  if (!ADMIN_TOKEN) return void send(res, { error: "PROVIDER_ADMIN_TOKEN is not set in .env" }, 503);
  sseHeaders(res);
  const ac = new AbortController();
  req.on("close", () => ac.abort());
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  await followSse(
    `${URLS.facilitator}/admin/events?token=${encodeURIComponent(ADMIN_TOKEN)}`,
    (data) => void res.write(`data: ${data}\n\n`),
    { signal: ac.signal, onDown: () => res.write(`event: offline\ndata: {}\n\n`) },
  );
  clearInterval(ping);
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof OperatorError ? err.status : ((err as { status?: number }).status ?? 500);
  if (status >= 500) log("error:", err);
  send(res, { error: err instanceof Error ? err.message.split("\n")[0] : "internal error" }, status);
});

app.listen(PORT, "127.0.0.1", () => {
  log(`Hush operator on http://localhost:${PORT}  (${NETWORK}, loopback only)`);
  log(`  owner    ${owner.address}`);
  log(`  auditor  ${auditor.address}`);
  log(`  origins  ${ORIGINS.join(", ")}`);
  if (!ADMIN_TOKEN) log("  PROVIDER_ADMIN_TOKEN not set — provider console disabled");
});
