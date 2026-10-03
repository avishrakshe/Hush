/**
 * Mirror — a copycat bot. It reads public chain data, nothing else, and copies every trade it can infer.
 *
 * What it watches (addresses discovered from the desk's and the signal provider's public `GET /` pages):
 *   mStock  desk → X      X bought   (ticker from the token, size from the amount, price from X's USDC payment)
 *   mStock  X → desk      X sold
 *   USDC    X → provider  X bought a signal — a trade usually follows
 *   eERC    X ↔ desk/provider   X is a Hush agent: only addresses and the asset (tokenId) are visible, never amounts
 * Every public trade is copied through the desk's public path (x402 `exact`). Hush agents leave nothing to copy.
 *
 *   GET /state    per-target: trades seen/copied, avg lag, P&L of the target vs P&L Mirror made copying it, what it sees
 *   GET /events   SSE: observations and copies (for the web demo)
 *
 *   pnpm mirror [--local]    env: MIRROR_PORT (4033), MIRROR_POLL_MS (2000), MIRROR_SCALE (1), MIRROR_MAX_SHARES (0.50)
 */
import { NETWORK, URLS, loadContracts, publicClient, signer, txLink } from "@hush/config/base";
import {
  CENTISHARE,
  STOCK_TICKERS,
  encryptedErcAbi,
  formatPrice,
  formatShares,
  hushRegistryAbi,
  latestRound,
  parseShares,
  readEercTransfer,
} from "@hush/x402/contracts";
import { HushPublicDesk, createHushFetch } from "@hush/x402/client";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { type Address, type Hex, formatUnits, getAddress, isAddressEqual, parseAbiItem, zeroAddress } from "viem";
import { Book } from "./ledger.js";

const PORT = Number(process.env.MIRROR_PORT || 4033);
const POLL_MS = Number(process.env.MIRROR_POLL_MS || 2000);
const SCALE = Number(process.env.MIRROR_SCALE || 1);
const MAX_SHARES = parseShares(process.env.MIRROR_MAX_SHARES || "0.50");
const log = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)} [Mirror] ${msg}`);
const toJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const usd = (atomic: bigint) => formatUnits(atomic, 6);

const contracts = loadContracts();
if (!contracts.stocks || !contracts.stockOracle || !contracts.hushAlpha) throw new Error("this deployment has no desk contracts");
const mirror = signer("MIRROR");

/** Public pages anyone can read: the desk's and the provider's addresses. */
async function discover(url: string, field: "desk" | "payTo"): Promise<Address> {
  for (;;) {
    try {
      const info = (await (await fetch(url)).json()) as Record<string, string>;
      if (info[field]) return getAddress(info[field]);
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}
const DESK = await discover(`${URLS.desk}/`, "desk");
const PROVIDER = await discover(`${URLS.provider}/`, "payTo");
const tokenToTicker = new Map<string, string>(STOCK_TICKERS.flatMap((t) => (contracts.stocks?.[t] ? [[contracts.stocks[t]!.toLowerCase(), t]] : [])));

// eERC tokenId → asset label (tokenIds are public; assigned on each token's first deposit).
const assetById = new Map<bigint, string>();
for (const [token, label] of [[contracts.usdc, "hUSDC"], ...STOCK_TICKERS.flatMap((t) => (contracts.stocks?.[t] ? [[contracts.stocks[t]!, `h${t}`]] : []))] as [Address, string][]) {
  const id = await publicClient.readContract({ address: contracts.encryptedErc, abi: encryptedErcAbi, functionName: "tokenIds", args: [token] });
  if (id !== 0n) assetById.set(id, label);
}

const desk = new HushPublicDesk({
  deskUrl: URLS.desk,
  pay: createHushFetch({ mode: "public", wallet: mirror.account, publicClient: publicClient as never }),
  walletClient: mirror.walletClient,
  publicClient: publicClient as never,
  contracts,
});

// ─── targets ───
interface Target {
  address: Address;
  label: string;
  kind: "public" | "private" | "unknown";
  tradesSeen: number;
  tradesCopied: number;
  lagsSec: number[];
  /** What the target did (inferred from public transfers) and what Mirror made copying it. */
  book: Book;
  copies: Book;
  sees: Set<string>;
  lastSeenAt: number;
}
const targets = new Map<string, Target>();
const labels = new Map<string, string>();

async function labelOf(a: Address): Promise<string> {
  const k = a.toLowerCase();
  if (labels.has(k)) return labels.get(k)!;
  let label = `${a.slice(0, 6)}…${a.slice(-4)}`;
  try {
    const agent = await publicClient.readContract({ address: contracts.hushRegistry, abi: hushRegistryAbi, functionName: "getAgent", args: [a] });
    const m = /hush:\/\/agent\/([a-z0-9-]+)/i.exec(agent.metadataURI);
    if (agent.registeredAt !== 0n && m) label = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  } catch {
    // not a registered agent
  }
  labels.set(k, label);
  return label;
}

async function target(a: Address): Promise<Target> {
  const k = a.toLowerCase();
  let t = targets.get(k);
  if (!t) {
    t = { address: getAddress(a), label: await labelOf(a), kind: "unknown", tradesSeen: 0, tradesCopied: 0, lagsSec: [], book: new Book(), copies: new Book(), sees: new Set(), lastSeenAt: 0 };
    targets.set(k, t);
  }
  t.lastSeenAt = Date.now();
  return t;
}

// ─── SSE ───
interface MirrorEvent {
  id: number;
  at: number;
  type: string;
  [k: string]: unknown;
}
const buffer: MirrorEvent[] = [];
const clients = new Set<ServerResponse>();
let nextId = 1;
function emit(type: string, data: Record<string, unknown>) {
  const e: MirrorEvent = { ...data, id: nextId++, at: Date.now(), type };
  buffer.push(e);
  if (buffer.length > 300) buffer.shift();
  for (const res of clients) res.write(`id: ${e.id}\nevent: ${type}\ndata: ${toJson(e)}\n\n`);
}

// ─── marks ───
const marks = new Map<string, bigint>();
async function refreshMarks() {
  for (const t of STOCK_TICKERS) {
    if (!contracts.stocks?.[t]) continue;
    marks.set(t, (await latestRound(publicClient, contracts.stockOracle!, t).catch(() => undefined))?.price ?? marks.get(t) ?? 0n);
  }
}

const blockTimes = new Map<bigint, number>();
async function blockTime(n: bigint) {
  if (!blockTimes.has(n)) blockTimes.set(n, Number((await publicClient.getBlock({ blockNumber: n })).timestamp));
  return blockTimes.get(n)!;
}

// ─── copying (serial: one copy at a time) ───
interface Copy {
  target: Target;
  ticker: string;
  side: "buy" | "sell";
  size: bigint;
  block: bigint;
  tx: Hex;
}
const queue: Copy[] = [];
let copying = false;

async function drain() {
  if (copying) return;
  copying = true;
  try {
    for (let c = queue.shift(); c; c = queue.shift()) await copy(c);
  } finally {
    copying = false;
  }
}

async function copy(c: Copy) {
  let size = BigInt(Math.round(Number(c.size) * SCALE));
  if (c.side === "buy" && size > MAX_SHARES) size = MAX_SHARES;
  if (c.side === "sell") {
    const held = c.target.copies.size(c.ticker);
    if (held === 0n) {
      emit("copy:skipped", { target: c.target.label, address: c.target.address, ticker: c.ticker, side: c.side, reason: "Mirror holds none of this target's copies" });
      return;
    }
    if (size > held) size = held;
  }
  if (size <= 0n) return;
  try {
    const trade = c.side === "buy" ? await desk.buy(c.ticker, formatShares(size)) : await desk.sell(c.ticker, formatShares(size));
    // Lag in chain time (block of the target's trade → block of Mirror's copy), so clock drift can't distort it.
    const copyBlock = (await publicClient.getTransactionReceipt({ hash: trade.paymentTx })).blockNumber;
    const lagSec = Math.max(0, (await blockTime(copyBlock)) - (await blockTime(c.block)));
    c.target.copies.apply(c.ticker, c.side, trade.size, trade.price);
    c.target.tradesCopied++;
    c.target.lagsSec.push(lagSec);
    emit("copied", {
      target: c.target.label,
      address: c.target.address,
      ticker: c.ticker,
      side: c.side,
      shares: formatShares(trade.size),
      price: formatPrice(trade.price),
      lagSec,
      sourceTx: c.tx,
      tx: trade.paymentTx,
    });
    log(`copied ${c.target.label}: ${c.side} ${formatShares(trade.size)} ${c.ticker} @ $${formatPrice(trade.price)} · ${lagSec}s after it  ${txLink(trade.paymentTx)}`);
  } catch (err) {
    const error = (err as Error).message.split("\n")[0]!.slice(0, 200);
    emit("copy:failed", { target: c.target.label, address: c.target.address, ticker: c.ticker, side: c.side, error });
    log(`copy of ${c.target.label} ${c.side} ${c.ticker} failed: ${error}`);
  }
}

// ─── watching ───
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const lastPayment = new Map<string, bigint>(); // X → its latest USDC payment to the desk (the price of its next delivery)
const skip = (a: Address) => isAddressEqual(a, zeroAddress) || isAddressEqual(a, mirror.address) || isAddressEqual(a, DESK);

async function onPublicTrade(who: Address, ticker: string, side: "buy" | "sell", size: bigint, price: bigint, tx: Hex, block: bigint) {
  const t = await target(who);
  t.kind = "public";
  t.tradesSeen++;
  t.book.apply(ticker, side, size, price);
  t.sees.add(`${side}s: ticker, size, price and timing — all public`);
  emit("observed", { target: t.label, address: who, kind: "public-trade", ticker, side, shares: formatShares(size), price: formatPrice(price), tx });
  log(`saw ${t.label} ${side} ${formatShares(size)} ${ticker} @ $${formatPrice(price)} → copying`);
  queue.push({ target: t, ticker, side, size, block, tx });
  void drain();
}

async function onPrivate(who: Address, what: string, tx: Hex) {
  const t = await target(who);
  if (t.kind !== "public") t.kind = "private";
  t.sees.add(what);
  emit("observed", { target: t.label, address: who, kind: "private", what, tx });
}

let cursor = process.env.MIRROR_FROM_BLOCK ? BigInt(process.env.MIRROR_FROM_BLOCK) : (await publicClient.getBlockNumber()) + 1n;
const startBlock = cursor;

async function poll() {
  const head = await publicClient.getBlockNumber();
  if (head < cursor) return;
  const fromBlock = cursor;
  const toBlock = head - cursor > 1_999n ? cursor + 1_999n : head;
  const stocks = Object.values(contracts.stocks!) as Address[];
  const range = { fromBlock, toBlock };
  const [stockOut, stockIn, usdcIn, toProvider, eercFrom, eercTo] = await Promise.all([
    publicClient.getLogs({ address: stocks, event: transferEvent, args: { from: DESK }, ...range }),
    publicClient.getLogs({ address: stocks, event: transferEvent, args: { to: DESK }, ...range }),
    publicClient.getLogs({ address: contracts.usdc, event: transferEvent, args: { to: DESK }, ...range }),
    publicClient.getLogs({ address: contracts.usdc, event: transferEvent, args: { to: PROVIDER }, ...range }),
    publicClient.getContractEvents({ address: contracts.encryptedErc, abi: encryptedErcAbi, eventName: "PrivateTransfer", args: { from: [DESK, PROVIDER] }, ...range }),
    publicClient.getContractEvents({ address: contracts.encryptedErc, abi: encryptedErcAbi, eventName: "PrivateTransfer", args: { to: [DESK, PROVIDER] }, ...range }),
  ]);
  type Item = { block: bigint; index: number; run: () => Promise<void> };
  const items: Item[] = [];
  const at = (l: { blockNumber: bigint | null; logIndex: number | null }) => ({ block: l.blockNumber ?? 0n, index: l.logIndex ?? 0 });

  for (const l of usdcIn) {
    if (skip(l.args.from!)) continue;
    items.push({ ...at(l), run: async () => void lastPayment.set(l.args.from!.toLowerCase(), l.args.value!) });
  }
  for (const l of stockOut) {
    const who = l.args.to!;
    if (skip(who)) continue;
    const ticker = tokenToTicker.get(l.address.toLowerCase())!;
    const size = l.args.value! / CENTISHARE;
    items.push({
      ...at(l),
      run: async () => {
        const paid = lastPayment.get(who.toLowerCase());
        lastPayment.delete(who.toLowerCase());
        const price = paid ? (paid * 100n) / size : (marks.get(ticker) ?? 0n);
        await onPublicTrade(who, ticker, "buy", size, price, l.transactionHash!, l.blockNumber!);
      },
    });
  }
  for (const l of stockIn) {
    const who = l.args.from!;
    if (skip(who)) continue;
    const ticker = tokenToTicker.get(l.address.toLowerCase())!;
    items.push({ ...at(l), run: () => onPublicTrade(who, ticker, "sell", l.args.value! / CENTISHARE, marks.get(ticker) ?? 0n, l.transactionHash!, l.blockNumber!) });
  }
  for (const l of toProvider) {
    const who = l.args.from!;
    if (skip(who)) continue;
    items.push({
      ...at(l),
      run: async () => {
        const t = await target(who);
        t.sees.add("signal purchases: when and how much (a trade usually follows)");
        emit("observed", { target: t.label, address: who, kind: "signal-purchase", amount: usd(l.args.value!), tx: l.transactionHash });
      },
    });
  }
  const seen = new Set<string>();
  for (const l of [...eercFrom, ...eercTo]) {
    const key = `${l.transactionHash}:${l.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { from, to } = l.args as { from: Address; to: Address };
    items.push({
      ...at(l),
      run: async () => {
        // The asset is in the calldata (tokenId); the amount is a ciphertext Mirror can't read.
        const asset = await readEercTransfer(publicClient, contracts, l.transactionHash!)
          .then((t) => assetById.get(t.tokenId) ?? `token #${t.tokenId}`)
          .catch(() => "unknown asset");
        const counterparty = isAddressEqual(to, DESK) ? "the desk" : isAddressEqual(to, PROVIDER) ? "the signal provider" : undefined;
        if (counterparty && !skip(from)) await onPrivate(from, `encrypted ${asset} transfer to ${counterparty} — amount hidden`, l.transactionHash!);
        else if (isAddressEqual(from, DESK) && !skip(to)) await onPrivate(to, `encrypted ${asset} from the desk (settle-out or refund) — amount hidden`, l.transactionHash!);
        else if (isAddressEqual(from, PROVIDER) && !skip(to)) await onPrivate(to, `encrypted ${asset} from the signal provider (refund) — amount hidden`, l.transactionHash!);
      },
    });
  }
  // Chain order matters: a buyer's USDC payment precedes the desk's token delivery that reveals the trade.
  items.sort((a, b) => (a.block === b.block ? a.index - b.index : a.block < b.block ? -1 : 1));
  for (const it of items) await it.run();
  cursor = toBlock + 1n;
}

function state() {
  const list = [...targets.values()]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .map((t) => {
      const avgLag = t.lagsSec.length ? Math.round(t.lagsSec.reduce((s, x) => s + x, 0) / t.lagsSec.length) : null;
      return {
        address: t.address,
        label: t.label,
        kind: t.kind,
        tradesSeen: t.tradesSeen,
        tradesCopied: t.tradesCopied,
        avgLagSec: avgLag,
        targetPnlUsd: t.kind === "public" ? usd(t.book.pnl(marks)) : null,
        copiedPnlUsd: usd(t.copies.pnl(marks)),
        verdict:
          t.kind === "public"
            ? `copying: ${t.tradesCopied}/${t.tradesSeen} trades, ${avgLag ?? "–"}s average lag`
            : "nothing to copy — sees addresses and assets only, no sizes, prices or directions",
        sees: [...t.sees],
      };
    });
  const lags = list.flatMap((t) => targets.get(t.address.toLowerCase())!.lagsSec);
  return {
    mirror: mirror.address,
    network: NETWORK,
    desk: DESK,
    provider: PROVIDER,
    watchingFromBlock: startBlock.toString(),
    cursor: cursor.toString(),
    marks: Object.fromEntries([...marks].map(([t, p]) => [t, formatPrice(p)])),
    totals: {
      tradesCopied: list.reduce((s, t) => s + t.tradesCopied, 0),
      avgLagSec: lags.length ? Math.round(lags.reduce((s, x) => s + x, 0) / lags.length) : null,
      copiedPnlUsd: usd([...targets.values()].reduce((s, t) => s + t.copies.pnl(marks), 0n)),
    },
    targets: list,
    recent: buffer.slice(-30),
  };
}

createServer((req: IncomingMessage, res: ServerResponse) => {
  res.setHeader("access-control-allow-origin", "*");
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const since = Number(req.headers["last-event-id"] ?? url.searchParams.get("since") ?? 0);
    for (const e of buffer) if (e.id > since) res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${toJson(e)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/state") return void res.end(toJson(state()));
  if (url.pathname === "/health") return void res.end(toJson({ ok: true, mirror: mirror.address, desk: DESK, provider: PROVIDER }));
  res.statusCode = 404;
  res.end(toJson({ error: "not found" }));
}).listen(PORT, "127.0.0.1");

await refreshMarks();
log(`watching desk ${DESK} and signal provider ${PROVIDER} on ${NETWORK} from block ${cursor} · copying every public trade ×${SCALE}`);
log(`state http://localhost:${PORT}/state · events http://localhost:${PORT}/events`);

let ticks = 0;
for (;;) {
  try {
    if (ticks++ % 5 === 0) await refreshMarks();
    await poll();
  } catch (err) {
    log(`poll failed: ${(err as Error).message.split("\n")[0]}`);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
