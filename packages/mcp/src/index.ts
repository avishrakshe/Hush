/**
 * @hush/mcp — lets any MCP-capable agent pay x402 APIs privately.
 *
 *   hush_pay(url, maxPrice?)   fetch a paid endpoint via hush-credit (private top-ups + off-chain vouchers)
 *   hush_balance()             decrypted private balance + credit per provider
 *   hush_history(limit?)       the agent's own decrypted payment history
 *   hush_verify()              prove settled vouchers were committed to HushLedger
 *   hush_refund(provider)      private refund of unspent credit
 *   hush_freeze(agent)         owner kill switch (needs the OWNER key)  ·  hush_unfreeze(agent)
 *
 * Config (env or repo .env): HUSH_NETWORK=fuji|localhost, HUSH_AGENT_ROLE (default VEIL), HUSH_DAILY_CAP_USD,
 * HUSH_MAX_PRICE_USD, HUSH_STORE (history file).
 */
import "./stdio-guard.js";
import { NETWORK, ROLES, type Role, loadContracts, publicClient, txLink, wallet } from "@hush/config";
import { eercToAtomic, formatHusdc, freezeAgent, hushRegistryAbi, mockUsdcAbi, unfreezeAgent } from "@hush/x402";
import { createHushFetch } from "@hush/x402/client";
import { JsonFileHushStore } from "@hush/x402/node";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, formatUnits, getAddress, isAddress, parseUnits } from "viem";
import * as z from "zod/v4";

const ROLE = (process.env.HUSH_AGENT_ROLE || "VEIL").toUpperCase() as Role;
if (!ROLES.includes(ROLE)) throw new Error(`HUSH_AGENT_ROLE must be one of ${ROLES.join(", ")}`);

const contracts = loadContracts();
const agent = wallet(ROLE);
const eerc = agent.eerc(contracts);
const usd = (v: string) => parseUnits(v.replace(/^\$/, ""), 6);
/** "$6.90", "$0.02", "$0.0005" — at least cents, never drops sub-cent precision. */
const fmtUsd = (atomic: bigint | string) => {
  const [whole, frac = ""] = formatUnits(BigInt(atomic), 6).split(".");
  return `$${whole}.${frac.padEnd(2, "0")}`;
};
const DAILY_CAP = usd(process.env.HUSH_DAILY_CAP_USD || "2.00");
const DEFAULT_MAX_PRICE = usd(process.env.HUSH_MAX_PRICE_USD || "0.10");

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
const store = new JsonFileHushStore(process.env.HUSH_STORE || path.join(PKG_DIR, ".data", `mcp-${ROLE.toLowerCase()}-${NETWORK}.json`));

let ready: Promise<ReturnType<typeof createHushFetch>> | undefined;
/** Lazily derive the eERC key and build the paying fetch (first tool call), so the server starts instantly. */
function hush() {
  ready ??= (async () => {
    await eerc.init();
    const providers = (await publicClient.readContract({ address: contracts.hushRegistry, abi: hushRegistryAbi, functionName: "getProviders" })) as Address[];
    return createHushFetch({
      mode: "hush-credit",
      wallet: agent.account,
      eercClient: eerc,
      publicClient: publicClient as never,
      store,
      // Only providers registered in HushRegistry; never silently falls back to a public payment.
      policy: { dailyCap: DAILY_CAP, allowedProviders: providers },
      privacy: { topUpChunks: [5_000_000n], jitterMs: [10_000, 45_000] },
    });
  })();
  return ready;
}

const text = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2) }],
  ...(isError ? { isError: true } : {}),
});
const guard =
  <A>(fn: (args: A) => Promise<ReturnType<typeof text>>) =>
  async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return text(`Error: ${(err as Error).message.split("\n")[0]}`, true);
    }
  };

/** Price the endpoint asks for under hush-credit, read from its 402 challenge (no payment). */
async function quote(url: string): Promise<{ amount: bigint; schemes: string[] } | null> {
  const res = await fetch(url);
  if (res.status !== 402) return null;
  const header = res.headers.get("PAYMENT-REQUIRED");
  if (!header) return null;
  const { accepts } = JSON.parse(Buffer.from(header, "base64").toString()) as { accepts: { scheme: string; amount: string }[] };
  const credit = accepts.find((a) => a.scheme === "hush-credit");
  return { amount: BigInt(credit?.amount ?? accepts[0]?.amount ?? "0"), schemes: accepts.map((a) => a.scheme) };
}

function createServer(): McpServer {
  const server = new McpServer({ name: "hush", version: "0.1.0" });

  server.registerTool(
    "hush_pay",
    {
      title: "Pay for an API privately",
      description:
        "Fetch an x402 paid HTTP endpoint and pay privately with Hush (hush-credit): an encrypted eERC top-up when credit runs low, " +
        "otherwise an off-chain signed voucher. Observers can't see the amount, the call frequency or per-call pattern. " +
        "Refuses if the endpoint asks more than maxPrice or doesn't offer hush-credit.",
      inputSchema: z.object({
        url: z.string().url().describe("The paid endpoint, e.g. http://localhost:4021/api/feed"),
        maxPrice: z.string().regex(/^\$?\d+(\.\d{1,6})?$/).optional().describe('Most you will pay for this call in USD, e.g. "0.05" (default 0.10)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(async ({ url, maxPrice }) => {
      const cap = maxPrice ? usd(maxPrice) : DEFAULT_MAX_PRICE;
      const q = await quote(url);
      if (q && !q.schemes.includes("hush-credit")) return text(`This endpoint only offers ${q.schemes.join(", ")} — not paying publicly.`, true);
      if (q && q.amount > cap) return text(`Endpoint asks ${fmtUsd(q.amount)} per call, above maxPrice ${fmtUsd(cap)}. Not paid.`, true);

      const { fetch: paidFetch } = await hush();
      const t0 = performance.now();
      const res = await paidFetch(url);
      const body = await res.text();
      const header = res.headers.get("PAYMENT-RESPONSE");
      const settle = header ? (JSON.parse(Buffer.from(header, "base64").toString()) as { success?: boolean; transaction?: string; amount?: string }) : undefined;
      return text({
        status: res.status,
        paid: settle?.success
          ? { scheme: "hush-credit", amount: settle.amount ? fmtUsd(settle.amount) : undefined, voucherCommitment: settle.transaction, privacy: "amount and call hidden; voucher will be Merkle-committed on-chain" }
          : q
            ? "payment not settled"
            : "free endpoint (no payment needed)",
        ms: Math.round(performance.now() - t0),
        body: body.length > 4000 ? `${body.slice(0, 4000)}…` : body,
      }, res.status >= 400);
    }),
  );

  server.registerTool(
    "hush_balance",
    {
      title: "Private balance and credit",
      description: "The agent's public USDC, its private eERC hUSDC balance (decrypted locally) and its prepaid hush-credit per provider.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async () => {
      const h = await hush();
      const [bal, usdc] = await Promise.all([
        eerc.balance(),
        publicClient.readContract({ address: contracts.usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [agent.address] }),
      ]);
      const credit = await Promise.all(
        ((await h.credit?.knownProviders()) ?? []).map(async (p) => {
          const c = await h.credit!.creditState(p);
          return { provider: p, available: fmtUsd(c.available), credited: fmtUsd(c.creditedTotal), spent: fmtUsd(c.settledCumulative), refunded: fmtUsd(c.refundedTotal), expiresAt: c.expiresAt ? new Date(c.expiresAt).toISOString() : null, frozen: c.frozen };
        }),
      );
      return text({
        agent: agent.address,
        network: NETWORK,
        publicUsdc: fmtUsd(usdc),
        privateBalance: formatHusdc(eercToAtomic(bal.decrypted, contracts.eercDecimals)),
        privateBalanceOnChain: "ElGamal ciphertext only — decrypted here with the agent's eERC key",
        credit,
      });
    }),
  );

  server.registerTool(
    "hush_history",
    {
      title: "Private payment history",
      description: "The agent's own payment history (calls, private top-ups with provider-signed receipts, refunds), newest first. Only this agent's store holds it.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional().describe("Default 20") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ limit }) => {
      const n = limit ?? 20;
      const [payments, vouchers, receipts, refunds] = await Promise.all([store.listPayments(), store.listVouchers(), store.listReceipts(), store.listRefunds()]);
      const status = new Map(vouchers.map((v) => [v.leaf.toLowerCase(), v]));
      const items = [
        ...payments.map((p) => ({
          at: p.at,
          kind: "call",
          scheme: p.scheme,
          amount: fmtUsd(p.amount),
          resource: p.resource,
          status: status.get(p.id.toLowerCase())?.status,
          committedOnChain: status.get(p.id.toLowerCase())?.verifiedOnChain ?? false,
        })),
        ...receipts.map((r) => ({ at: r.createdAt, kind: "top-up", amount: fmtUsd(r.amount), provider: r.receipt.provider, tx: txLink(r.receipt.topupTxHash), receiptSignedByProvider: true })),
        ...refunds.map((r) => ({ at: r.createdAt, kind: "refund", amount: fmtUsd(r.amount), provider: r.provider, tx: r.txHash ? txLink(r.txHash) : null })),
      ]
        .sort((a, b) => b.at - a.at)
        .slice(0, n)
        .map((i) => ({ ...i, at: new Date(i.at).toISOString() }));
      return text(items);
    }),
  );

  server.registerTool(
    "hush_verify",
    {
      title: "Verify vouchers on-chain",
      description: "Check that every settled voucher is inside a Merkle root the provider committed to HushLedger (provider accountability).",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async () => {
      const h = await hush();
      const r = await h.credit!.verifyMyVouchers();
      return text({ verifiedOnChain: r.verified, awaitingNextBatch: r.pending, failed: r.failed.map((f) => f.leaf) });
    }),
  );

  server.registerTool(
    "hush_refund",
    {
      title: "Refund unused credit",
      description: "Ask a provider to return all unspent hush-credit via a private eERC transfer; the refund amount is decrypted and checked locally.",
      inputSchema: z.object({ provider: z.string().refine(isAddress, "must be an address") }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ provider }) => {
      const h = await hush();
      const res = await h.credit!.requestRefund(getAddress(provider));
      return text({ refunded: fmtUsd(res.amount), tx: res.txHash ? txLink(res.txHash) : null, creditLeft: fmtUsd(res.credit.available) });
    }),
  );

  const ownerTool = (name: "hush_freeze" | "hush_unfreeze", freeze: boolean) =>
    server.registerTool(
      name,
      {
        title: freeze ? "Freeze an agent (kill switch)" : "Unfreeze an agent",
        description: freeze
          ? "Owner kill switch: freeze an agent in HushRegistry so every facilitator rejects its payments from the next call. Needs the OWNER key."
          : "Lift an owner freeze on an agent. Needs the OWNER key.",
        inputSchema: z.object({ agent: z.string().describe("Agent address, or a role name like VEIL") }),
        annotations: { readOnlyHint: false, destructiveHint: freeze, idempotentHint: true, openWorldHint: true },
      },
      guard(async ({ agent: who }) => {
        const owner = wallet("OWNER"); // throws a clear error if OWNER_PRIVATE_KEY isn't configured
        const target = isAddress(who) ? getAddress(who) : wallet(who.toUpperCase() as Role).address;
        const tx = await (freeze ? freezeAgent : unfreezeAgent)(owner.walletClient, publicClient, contracts.hushRegistry, target);
        return text({ agent: target, frozen: freeze, tx: txLink(tx) });
      }),
    );
  ownerTool("hush_freeze", true);
  ownerTool("hush_unfreeze", false);

  return server;
}

void serveStdio(createServer);
console.error(`hush MCP server on stdio · agent ${ROLE} ${agent.address} · ${NETWORK}`);
