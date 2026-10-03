/**
 * Proof of Alpha — verifiable private track records ("private by default, provable on demand").
 *
 * A subject (a signal provider, or an agent) keeps a hash chain over epochs:
 *   leafHash      = EIP-712 digest of a signed record (SignalRecord by the provider / FillReceipt by the desk)
 *   epochDigest_e = keccak256(abi.encode(e, leafHashes[]))            — or, for an empty epoch,
 *                   keccak256(abi.encode("HEARTBEAT", subject, e))
 *   head_e        = keccak256(abi.encode(head_{e-1}, epochDigest_e))   (head_{genesis-1} = 0)
 * and commits head_e to HushAlpha during epoch e+1 — every epoch, activity or not. Nothing about the records is public
 * until the subject reveals them: a proof hands over the records of a range; the verifier recomputes every head and
 * checks it against the committed one. Adding, dropping, back-dating or editing a record changes a head, and the first
 * epoch where that happens is where verification fails. Signals are then graded against MockStockOracle.getPriceAt.
 *
 * viem only (no eERC SDK): runs in Node and in the browser.
 */
import { type Address, type Hex, type PublicClient, type TypedDataDomain, encodeAbiParameters, isAddressEqual, keccak256, parseAbiParameters, zeroHash } from "viem";
import { alphaDomain, fillFromJson, fillTyped, signalFromJson, signalTyped } from "./alpha.js";
import { DIRECTION } from "./constants.js";
import { hushAlphaAbi, mockStockOracleAbi } from "./generated/abis.js";
import { bytes32ToTicker } from "./stocks.js";
import type { FillReceiptJson, SignalRecordJson } from "./types.js";

export type AlphaLeafKind = "signal" | "fill";

export interface AlphaLeaf {
  record: SignalRecordJson | FillReceiptJson;
  signature: Hex;
}

/** What a subject hands to a verifier: every record of every epoch in [fromEpoch, toEpoch]. */
export interface AlphaProof {
  version: 1;
  kind: AlphaLeafKind;
  subject: Address;
  chainId: number;
  hushAlpha: Address;
  epochLen: number;
  genesisEpoch: string;
  fromEpoch: string;
  toEpoch: string;
  /** head of epoch fromEpoch-1 — zero when fromEpoch is the genesis epoch, else a committed head. */
  anchorHead: Hex;
  /** Epochs that have records (ascending). Every other epoch in the range is a heartbeat. */
  epochs: { epoch: string; leaves: AlphaLeaf[] }[];
}

const DIGEST_PARAMS = parseAbiParameters("uint256, bytes32[]");
const HEARTBEAT_PARAMS = parseAbiParameters("string, address, uint256");
const HEAD_PARAMS = parseAbiParameters("bytes32, bytes32");

export const epochOf = (unixSeconds: bigint | number, epochLen: number) => BigInt(unixSeconds) / BigInt(epochLen);

export function epochDigest(subject: Address, epoch: bigint, leafHashes: Hex[]): Hex {
  return leafHashes.length === 0
    ? keccak256(encodeAbiParameters(HEARTBEAT_PARAMS, ["HEARTBEAT", subject, epoch]))
    : keccak256(encodeAbiParameters(DIGEST_PARAMS, [epoch, leafHashes]));
}

export const nextHead = (prev: Hex, digest: Hex): Hex => keccak256(encodeAbiParameters(HEAD_PARAMS, [prev, digest]));

/** When a record happened (it must fall inside the epoch it is filed under). */
export const leafTime = (kind: AlphaLeafKind, leaf: AlphaLeaf): bigint =>
  kind === "signal" ? BigInt((leaf.record as SignalRecordJson).issuedAt) : BigInt((leaf.record as FillReceiptJson).filledAt);

export const leafHash = (domain: TypedDataDomain, kind: AlphaLeafKind, leaf: AlphaLeaf): Hex =>
  kind === "signal" ? signalTyped.hash(domain, signalFromJson(leaf.record as SignalRecordJson)) : fillTyped.hash(domain, fillFromJson(leaf.record as FillReceiptJson));

/**
 * A subject's chain, built from its own record log. Used by providers (and agents) to compute the head they commit each
 * epoch and to cut proofs. Records must be added in the epoch they happened, before that epoch is committed.
 */
export class AlphaChain {
  private readonly byEpoch = new Map<bigint, AlphaLeaf[]>();
  private heads = new Map<bigint, Hex>();

  constructor(
    readonly opts: { kind: AlphaLeafKind; subject: Address; chainId: number; hushAlpha: Address; epochLen: number; genesisEpoch: bigint },
  ) {}

  get domain() {
    return alphaDomain(this.opts.chainId, this.opts.hushAlpha);
  }

  get genesisEpoch() {
    return this.opts.genesisEpoch;
  }

  /** Re-anchor before the first commit (records from earlier epochs fall outside the chain). */
  rebase(genesisEpoch: bigint) {
    this.opts.genesisEpoch = genesisEpoch;
    this.heads.clear();
  }

  add(leaf: AlphaLeaf): bigint {
    const epoch = epochOf(leafTime(this.opts.kind, leaf), this.opts.epochLen);
    const list = this.byEpoch.get(epoch) ?? [];
    list.push(leaf);
    this.byEpoch.set(epoch, list);
    // Heads from this epoch on are stale now.
    for (const e of [...this.heads.keys()]) if (e >= epoch) this.heads.delete(e);
    return epoch;
  }

  leaves(epoch: bigint): AlphaLeaf[] {
    return epoch < this.opts.genesisEpoch ? [] : [...(this.byEpoch.get(epoch) ?? [])];
  }

  allLeaves(): { epoch: bigint; leaf: AlphaLeaf }[] {
    return [...this.byEpoch.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).flatMap(([epoch, ls]) => ls.map((leaf) => ({ epoch, leaf })));
  }

  head(epoch: bigint): Hex {
    if (epoch < this.opts.genesisEpoch) return zeroHash;
    const cached = this.heads.get(epoch);
    if (cached) return cached;
    let start = this.opts.genesisEpoch;
    let prev: Hex = zeroHash;
    for (let e = epoch - 1n; e >= this.opts.genesisEpoch; e--) {
      const h = this.heads.get(e);
      if (h) {
        start = e + 1n;
        prev = h;
        break;
      }
    }
    for (let e = start; e <= epoch; e++) {
      prev = nextHead(prev, epochDigest(this.opts.subject, e, this.leaves(e).map((l) => leafHash(this.domain, this.opts.kind, l))));
      this.heads.set(e, prev);
    }
    return prev;
  }

  /** A proof over [from, to]. `filter` lets a dishonest subject drop records — which is exactly what verification catches. */
  proof(from: bigint, to: bigint, filter?: (leaf: AlphaLeaf) => boolean): AlphaProof {
    const f = from < this.opts.genesisEpoch ? this.opts.genesisEpoch : from;
    const epochs: AlphaProof["epochs"] = [];
    for (let e = f; e <= to; e++) {
      const leaves = this.leaves(e).filter((l) => !filter || filter(l));
      if (leaves.length) epochs.push({ epoch: e.toString(), leaves });
    }
    return {
      version: 1,
      kind: this.opts.kind,
      subject: this.opts.subject,
      chainId: this.opts.chainId,
      hushAlpha: this.opts.hushAlpha,
      epochLen: this.opts.epochLen,
      genesisEpoch: this.opts.genesisEpoch.toString(),
      fromEpoch: f.toString(),
      toEpoch: to.toString(),
      anchorHead: f === this.opts.genesisEpoch ? zeroHash : this.head(f - 1n),
      epochs,
    };
  }
}

// ─────────────────────────────── verification ───────────────────────────────

export interface GradedCall {
  epoch: string;
  ticker: string;
  direction: "UP" | "DOWN" | "FLAT";
  confidence: number;
  issuedAt: number;
  horizonSec: number;
  /** USDC atomic per share. */
  entry: string;
  exit: string | null;
  /** Return of following the call, basis points (signed: a DOWN call wins when the price falls). */
  returnBps: number | null;
  outcome: "win" | "loss" | "flat" | "pending" | "unbound";
}

export interface ProofReport {
  valid: boolean;
  failedEpoch?: string;
  reason?: string;
  subject: Address;
  kind: AlphaLeafKind;
  fromEpoch: string;
  toEpoch: string;
  epochLen: number;
  /** Epochs in the range, and how many have a committed head (the rest are gaps). */
  epochs: number;
  committedEpochs: number;
  gaps: string[];
  records: number;
  /** Resolved UP/DOWN calls (signals) and how they did. */
  calls: number;
  wins: number;
  winRate: number | null;
  pnlBps: number;
  maxDrawdownBps: number;
  pending: number;
  flats: number;
  /** Records that were bound only after their outcome was knowable (or not at all) — never graded. */
  unbound: number;
  days: number;
  graded: GradedCall[];
}

export interface VerifyOptions {
  publicClient: Pick<PublicClient, "readContract">;
  /** MockStockOracle — needed to grade signals. */
  oracle?: Address;
  /** Unix seconds; default now. */
  now?: number;
  concurrency?: number;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}

/**
 * Checks a proof against HushAlpha and the stock oracle. Fails at the first epoch where:
 *   - a record is not signed by its issuer, belongs to someone else, or is filed outside the epoch it happened in;
 *   - the recomputed head differs from the committed one (a record was added, dropped or changed);
 *   - a signal's entry price is not the oracle's price at issuedAt.
 * Signals bound in time are graded at issuedAt + horizonSec; ungraded ones are reported as pending / unbound.
 */
export async function verifyProof(proof: AlphaProof, opts: VerifyOptions): Promise<ProofReport> {
  const pc = opts.publicClient;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const limit = opts.concurrency ?? 16;
  const from = BigInt(proof.fromEpoch);
  const to = BigInt(proof.toEpoch);
  const L = proof.epochLen;
  const domain = alphaDomain(proof.chainId, proof.hushAlpha);
  const report: ProofReport = {
    valid: false,
    subject: proof.subject,
    kind: proof.kind,
    fromEpoch: proof.fromEpoch,
    toEpoch: proof.toEpoch,
    epochLen: L,
    epochs: Number(to - from + 1n),
    committedEpochs: 0,
    gaps: [],
    records: proof.epochs.reduce((s, e) => s + e.leaves.length, 0),
    calls: 0,
    wins: 0,
    winRate: null,
    pnlBps: 0,
    maxDrawdownBps: 0,
    pending: 0,
    flats: 0,
    unbound: 0,
    days: (Number(to - from + 1n) * L) / 86_400,
    graded: [],
  };
  const fail = (epoch: bigint | string, reason: string): ProofReport => ({ ...report, valid: false, failedEpoch: epoch.toString(), reason });

  if (proof.version !== 1 || to < from) return fail(from, "malformed proof");
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    pc.readContract({ address: proof.hushAlpha, abi: hushAlphaAbi, functionName: functionName as never, args: args as never }) as Promise<T>;

  const [epochLen, firstEpoch] = await Promise.all([read<bigint>("epochLen"), read<bigint>("firstEpoch", [proof.subject])]);
  if (Number(epochLen) !== L) return fail(from, `epoch length ${L} ≠ HushAlpha's ${epochLen}`);
  if (firstEpoch === 0n) return fail(from, "subject has never committed a chain head");
  if (BigInt(proof.genesisEpoch) !== firstEpoch) return fail(from, `genesis ${proof.genesisEpoch} ≠ first committed epoch ${firstEpoch}`);
  if (from < firstEpoch) return fail(from, "range starts before the subject's first commit");
  if (from === firstEpoch) {
    if (proof.anchorHead !== zeroHash) return fail(from, "genesis anchor must be zero");
  } else {
    const anchor = await read<Hex>("getChainHead", [proof.subject, from - 1n]);
    if (anchor === zeroHash || anchor.toLowerCase() !== proof.anchorHead.toLowerCase()) {
      return fail(from - 1n, "anchor head is not the one committed on-chain for the epoch before the range");
    }
  }

  const epochsList: bigint[] = [];
  for (let e = from; e <= to; e++) epochsList.push(e);
  const onchain = await mapLimit(epochsList, limit, (e) => read<Hex>("getChainHead", [proof.subject, e]));

  const byEpoch = new Map<bigint, AlphaLeaf[]>();
  for (const pe of proof.epochs) {
    const e = BigInt(pe.epoch);
    if (e < from || e > to || byEpoch.has(e)) return fail(e, "records filed under an epoch outside the range (or twice)");
    byEpoch.set(e, pe.leaves);
  }

  // Walk the chain. Records in an uncommitted epoch are only bound by the next committed head.
  let head = proof.anchorHead;
  const waiting: { epoch: bigint; leaf: AlphaLeaf }[] = [];
  const bound: { epoch: bigint; leaf: AlphaLeaf; bindingEpoch: bigint }[] = [];
  for (let k = 0; k < epochsList.length; k++) {
    const e = epochsList[k]!;
    const leaves = byEpoch.get(e) ?? [];
    for (const leaf of leaves) {
      const issuer = proof.kind === "signal" ? (leaf.record as SignalRecordJson).provider : (leaf.record as FillReceiptJson).desk;
      const owner = proof.kind === "signal" ? issuer : (leaf.record as FillReceiptJson).agent;
      if (!isAddressEqual(owner, proof.subject)) return fail(e, "a record belongs to another subject");
      const ok =
        proof.kind === "signal"
          ? await signalTyped.isValid(domain, signalFromJson(leaf.record as SignalRecordJson), leaf.signature)
          : await fillTyped.isValid(domain, fillFromJson(leaf.record as FillReceiptJson), leaf.signature);
      if (!ok) return fail(e, "a record's signature is not its issuer's (forged or altered)");
      if (epochOf(leafTime(proof.kind, leaf), L) !== e) return fail(e, "a record is filed outside the epoch it happened in (back-dated)");
    }
    head = nextHead(head, epochDigest(proof.subject, e, leaves.map((l) => leafHash(domain, proof.kind, l))));
    const committed = onchain[k]!;
    waiting.push(...leaves.map((leaf) => ({ epoch: e, leaf })));
    if (committed === zeroHash) {
      report.gaps.push(e.toString());
      continue;
    }
    if (committed.toLowerCase() !== head.toLowerCase()) {
      return fail(e, "chain diverges from on-chain head — records were added, dropped or changed in this epoch");
    }
    report.committedEpochs++;
    for (const w of waiting.splice(0)) bound.push({ ...w, bindingEpoch: e });
  }
  report.unbound += waiting.length; // after the last committed epoch: not bound by anything

  if (proof.kind === "signal") {
    if (!opts.oracle) return fail(from, "an oracle address is needed to grade signals");
    const graded = await mapLimit(bound, limit, async ({ epoch, leaf, bindingEpoch }) => {
      const g = await gradeSignal(leaf.record as SignalRecordJson, { publicClient: pc, oracle: opts.oracle!, now, epoch });
      if (g === "price-mismatch") return { failed: true as const, epoch };
      // Bound too late to count: its head was committed after the outcome could be known (upper bound: end of the
      // epoch after the binding epoch). With a commit every epoch and horizon >= 2 epochs this never triggers.
      if (Number((bindingEpoch + 2n) * BigInt(L)) > g.issuedAt + g.horizonSec) return { ...g, exit: null, returnBps: null, outcome: "unbound" as const };
      return g;
    });
    const priceFail = graded.find((x): x is { failed: true; epoch: bigint } => "failed" in x);
    if (priceFail) return fail(priceFail.epoch, "a signal's entry price is not the oracle's price at issuedAt (tampered)");
    const stats = summarize(graded as GradedCall[]);
    Object.assign(report, stats, { unbound: report.unbound + stats.unbound });
  }
  return { ...report, valid: true };
}

/**
 * Grades one signal against the oracle: its entry price must be the price in force at issuedAt (or the round just
 * before, if one landed while it was being published); UP/DOWN calls resolve at issuedAt + horizonSec.
 * No chain checks — `verifyProof` does those; a provider uses this to compute the stats it claims.
 */
export async function gradeSignal(
  record: SignalRecordJson,
  opts: { publicClient: Pick<PublicClient, "readContract">; oracle: Address; now?: number; epoch?: bigint },
): Promise<GradedCall | "price-mismatch"> {
  const pc = opts.publicClient;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const r = signalFromJson(record);
  const direction = (Object.keys(DIRECTION) as (keyof typeof DIRECTION)[]).find((k) => DIRECTION[k] === r.direction) ?? "FLAT";
  const g: GradedCall = {
    epoch: (opts.epoch ?? 0n).toString(),
    ticker: bytes32ToTicker(r.ticker),
    direction,
    confidence: r.confidenceBps / 10_000,
    issuedAt: Number(r.issuedAt),
    horizonSec: Number(r.horizonSec),
    entry: r.price.toString(),
    exit: null,
    returnBps: null,
    outcome: "pending",
  };
  const [price, , roundId] = (await pc.readContract({ address: opts.oracle, abi: mockStockOracleAbi, functionName: "getPriceAt", args: [r.ticker, r.issuedAt] })) as [
    bigint,
    bigint,
    bigint,
  ];
  if (price !== r.price) {
    const prev =
      roundId > 0n
        ? ((await pc.readContract({ address: opts.oracle, abi: mockStockOracleAbi, functionName: "getRound", args: [r.ticker, roundId - 1n] })) as [bigint, bigint])[0]
        : -1n;
    if (prev !== r.price) return "price-mismatch";
  }
  if (direction === "FLAT") return { ...g, outcome: "flat" };
  const resolveAt = r.issuedAt + r.horizonSec;
  if (Number(resolveAt) > now) return g;
  const [exit] = (await pc.readContract({ address: opts.oracle, abi: mockStockOracleAbi, functionName: "getPriceAt", args: [r.ticker, resolveAt] })) as [bigint, bigint, bigint];
  const move = Number(exit - r.price) / Number(r.price);
  const returnBps = Math.round((direction === "UP" ? move : -move) * 10_000);
  return { ...g, exit: exit.toString(), returnBps, outcome: returnBps > 0 ? "win" : "loss" };
}

/** Win rate, cumulative return and max drawdown (basis points) over graded calls, in time order. */
export function summarize(graded: GradedCall[]) {
  const calls = [...graded].sort((a, b) => a.issuedAt - b.issuedAt);
  const s = { calls: 0, wins: 0, winRate: null as number | null, pnlBps: 0, maxDrawdownBps: 0, pending: 0, flats: 0, unbound: 0, graded: calls };
  let peak = 0;
  for (const c of calls) {
    if (c.outcome === "win" || c.outcome === "loss") {
      s.calls++;
      if (c.outcome === "win") s.wins++;
      s.pnlBps += c.returnBps ?? 0;
      peak = Math.max(peak, s.pnlBps);
      s.maxDrawdownBps = Math.max(s.maxDrawdownBps, peak - s.pnlBps);
    } else if (c.outcome === "pending") s.pending++;
    else if (c.outcome === "flat") s.flats++;
    else s.unbound++;
  }
  s.winRate = s.calls ? s.wins / s.calls : null;
  return s;
}

// ─────────────────────────────── choosing a provider ───────────────────────────────

/** What a signal provider publishes about its track record (its `GET /` page and 402 body). */
export interface ProviderAlphaInfo {
  name?: string;
  subject: Address;
  proofUrl: string;
  claims: AlphaClaims;
}

export interface ProviderCheck {
  url: string;
  name: string;
  claims?: AlphaClaims;
  report?: ProofReport;
  passes: boolean;
  why: string;
}

export interface AlphaPolicy {
  /** Minimum verified win rate over resolved calls. */
  minWinRate?: number;
  /** Minimum number of verified, resolved calls. */
  minCalls?: number;
}

/** Fetch a provider's proof and verify it against HushAlpha + the oracle; apply `policy`. Never throws. */
export async function checkProvider(url: string, opts: VerifyOptions & { policy?: AlphaPolicy; fetch?: typeof fetch }): Promise<ProviderCheck> {
  const f = opts.fetch ?? globalThis.fetch;
  const base = url.replace(/\/$/, "");
  let info: ProviderAlphaInfo | undefined;
  let name = base;
  try {
    const page = (await (await f(`${base}/`)).json()) as { name?: string; proofOfAlpha?: ProviderAlphaInfo };
    name = page.name ?? base;
    info = page.proofOfAlpha;
    if (!info) return { url, name, passes: false, why: "publishes no Proof of Alpha" };
    const proof = (await (await f(info.proofUrl)).json()) as AlphaProof & { error?: string };
    if (proof.error) return { url, name, claims: info.claims, passes: false, why: `no proof: ${proof.error}` };
    const report = await verifyProof(proof, opts);
    if (!isAddressEqual(proof.subject, info.subject)) return { url, name, claims: info.claims, report, passes: false, why: "proof is for another subject" };
    if (!report.valid) return { url, name, claims: info.claims, report, passes: false, why: `proof fails at epoch ${report.failedEpoch}: ${report.reason}` };
    const p = opts.policy ?? {};
    if ((p.minCalls ?? 0) > report.calls) return { url, name, claims: info.claims, report, passes: false, why: `only ${report.calls} verified calls (need ${p.minCalls})` };
    if (p.minWinRate !== undefined && (report.winRate ?? 0) < p.minWinRate) {
      return { url, name, claims: info.claims, report, passes: false, why: `verified win rate ${pct(report.winRate)} < ${pct(p.minWinRate)}` };
    }
    return { url, name, claims: info.claims, report, passes: true, why: `verified ${pct(report.winRate)} over ${report.calls} calls` };
  } catch (err) {
    return { url, name, claims: info?.claims, passes: false, why: `unreachable: ${(err as Error).message.split("\n")[0]}` };
  }
}

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `${Math.round(x * 100)}%`);

/** Check every candidate; the chosen one is the passing provider with the best verified win rate. Claims are ignored. */
export async function chooseProvider(urls: string[], opts: VerifyOptions & { policy?: AlphaPolicy; fetch?: typeof fetch }) {
  const checks = await Promise.all(urls.map((u) => checkProvider(u, opts)));
  const chosen = checks
    .filter((c) => c.passes)
    .sort((a, b) => (b.report!.winRate ?? 0) - (a.report!.winRate ?? 0) || b.report!.calls - a.report!.calls)[0];
  return { chosen, checks };
}

/** Stats a subject *claims* (e.g. in its 402 page) — computed the same way, but over whatever records it chose. */
export interface AlphaClaims {
  winRate: number | null;
  calls: number;
  since: number;
  proofUrl: string;
}
