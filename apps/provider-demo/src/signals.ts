/**
 * A signal provider's book: publishes signed SignalRecords on a cadence, keeps them in an append-only log, commits the
 * Proof of Alpha chain head of every closed epoch to HushAlpha (heartbeats included) and cuts proofs on demand.
 *
 * SignalCo reveals everything. AlphaKing commits its true chain too — it has to, or it could not claim a track record at
 * all — but its proof drops most resolved losers, which is what a verifier catches at the first doctored epoch.
 */
import {
  type AlphaClaims,
  AlphaChain,
  type AlphaLeaf,
  type AlphaProof,
  DIRECTION,
  type GradedCall,
  type HushContracts,
  type OracleRound,
  type SignalRecordJson,
  type StockTicker,
  commitDeadline,
  epochOf,
  gradeSignal,
  hushAlphaAbi,
  leafHash,
  mockStockOracleAbi,
  signalToJson,
  signalTyped,
  summarize,
  tickerToBytes32,
} from "@hush/x402/contracts";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Account, Address, Chain, Hex, PublicClient, Transport, WalletClient } from "viem";
import type { LocalAccount } from "viem/accounts";

export type Direction = keyof typeof DIRECTION;
/** rounds: newest first. momentumBps: the strategy's expected move over the horizon (shown to buyers, not graded). */
export type Strategy = (ticker: StockTicker, rounds: OracleRound[], horizonSec: number) => { direction: Direction; confidence: number; momentumBps: number };

export interface Published {
  leaf: AlphaLeaf;
  epoch: bigint;
  momentumBps: number;
  round: OracleRound;
  /** Oracle rounds the call was computed from. */
  window: number;
}

export interface SignalBookOptions {
  name: string;
  signer: LocalAccount;
  contracts: HushContracts & { hushAlpha: Address; stockOracle: Address };
  publicClient: PublicClient;
  horizonSec: number;
  /** Append-only JSON-lines log of every signed record (the provider's own copy of its history). */
  file: string;
  strategy: Strategy;
  proofUrl: string;
  /** Records the proof reveals. Default: all (honest). */
  reveal?: (leaf: AlphaLeaf, grade: GradedCall | undefined) => boolean;
  /** Epochs a default proof (and the claims) covers. */
  windowEpochs: number;
  /** Oracle rounds the strategy sees (newest first). Default 12. */
  rounds?: number;
  /**
   * A call is stamped this many seconds in the past and quotes the round in force then. A block can be stamped a few
   * seconds behind wall time (local hardhat runs ~2 s behind), so a round mined just after "now" could otherwise land
   * at or before issuedAt and the quote would be one round stale. Commits must wait longer than this.
   */
  settleSec: number;
  log: (msg: string) => void;
}

/** Oracle rounds never change once posted: fetch each one once, shared by every book in the process. */
const roundCache = new Map<string, OracleRound[]>();
async function latestRounds(pc: PublicClient, oracle: Address, ticker: StockTicker, n: number): Promise<OracleRound[]> {
  const t = tickerToBytes32(ticker);
  const count = await pc.readContract({ address: oracle, abi: mockStockOracleAbi, functionName: "roundCount", args: [t] });
  const cached = roundCache.get(ticker) ?? [];
  const from = count > BigInt(n) ? count - BigInt(n) : 0n;
  const have = new Set(cached.map((r) => r.roundId));
  const missing: bigint[] = [];
  for (let id = from; id < count; id++) if (!have.has(id)) missing.push(id);
  const fetched = await Promise.all(
    missing.map(async (roundId) => {
      const [price, timestamp] = await pc.readContract({ address: oracle, abi: mockStockOracleAbi, functionName: "getRound", args: [t, roundId] });
      return { roundId, price, timestamp };
    }),
  );
  const rounds = [...cached, ...fetched].filter((r) => r.roundId >= from).sort((a, b) => (a.roundId > b.roundId ? -1 : 1));
  roundCache.set(ticker, rounds);
  return rounds.slice(0, n);
}

const nowSec = () => Math.floor(Date.now() / 1000);

export class SignalBook {
  readonly chain: AlphaChain;
  readonly latest = new Map<StockTicker, Published>();
  private firstCommitted: bigint;
  private lastCommitted: bigint;
  /** Highest epoch whose head was computed for a commit: nothing may be added there any more. */
  private sealed = 0n;
  private readonly grades = new Map<Hex, GradedCall>();
  private lock: Promise<unknown> = Promise.resolve();
  claims: AlphaClaims;

  private constructor(
    readonly opts: SignalBookOptions,
    readonly epochLen: number,
    first: bigint,
    latest: bigint,
  ) {
    this.firstCommitted = first;
    this.lastCommitted = latest;
    this.sealed = latest;
    // Never committed: the chain starts at the current epoch and is re-anchored to whichever epoch the first commit is.
    const genesis = first !== 0n ? first : epochOf(nowSec(), epochLen);
    this.chain = new AlphaChain({ kind: "signal", subject: opts.signer.address, chainId: opts.contracts.chainId, hushAlpha: opts.contracts.hushAlpha, epochLen, genesisEpoch: genesis });
    this.claims = { winRate: null, calls: 0, since: Number(genesis) * epochLen, proofUrl: opts.proofUrl };
  }

  static async open(opts: SignalBookOptions): Promise<SignalBook> {
    const pc = opts.publicClient;
    const read = <T>(functionName: string, args: readonly unknown[] = []) =>
      pc.readContract({ address: opts.contracts.hushAlpha, abi: hushAlphaAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
    const subject = opts.signer.address;
    const [epochLen, first, latest] = await Promise.all([read<bigint>("epochLen"), read<bigint>("firstEpoch", [subject]), read<bigint>("latestEpoch", [subject])]);
    // Calls are graded from the commit deadline (≤ 2 epochs after issue) to the horizon: below 3 epochs little is left.
    if (BigInt(opts.horizonSec) < 3n * epochLen) throw new Error(`horizon ${opts.horizonSec}s < 3 epochs (${3n * epochLen}s)`);
    const book = new SignalBook(opts, Number(epochLen), first, latest);

    mkdirSync(path.dirname(opts.file), { recursive: true });
    if (existsSync(opts.file)) {
      for (const line of readFileSync(opts.file, "utf8").split("\n")) if (line.trim()) book.chain.add(JSON.parse(line) as AlphaLeaf);
    }
    // The log must reproduce what was committed, or every proof that reaches back past this point fails.
    if (latest !== 0n) {
      const onchain = await read<Hex>("getChainHead", [subject, latest]);
      if (book.chain.head(latest).toLowerCase() !== onchain.toLowerCase()) {
        opts.log(`WARNING ${opts.name}: ${opts.file} does not reproduce the committed head of epoch ${latest} — proofs over that range will fail`);
      }
    }
    return book;
  }

  get subject() {
    return this.opts.signer.address;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** Sign and log one call for `ticker` at the oracle's latest round. */
  publish(ticker: StockTicker): Promise<Published | undefined> {
    return this.exclusive(async () => {
      const { contracts, signer, publicClient, horizonSec, strategy } = this.opts;
      // Graders look the entry up with getPriceAt(issuedAt): quote exactly the round in force then, and let the
      // strategy see nothing newer.
      const issuedAt = nowSec() - this.opts.settleSec;
      const n = this.opts.rounds ?? 12;
      const rounds = (await latestRounds(publicClient, contracts.stockOracle, ticker, n + 2)).filter((r) => Number(r.timestamp) <= issuedAt).slice(0, n);
      const round = rounds[0];
      if (!round) return undefined;
      const epoch = epochOf(issuedAt, this.epochLen);
      if (epoch <= this.sealed) return undefined; // that epoch's head is already out
      const s = strategy(ticker, rounds, horizonSec);
      const record = {
        provider: signer.address,
        ticker: tickerToBytes32(ticker),
        direction: DIRECTION[s.direction],
        confidenceBps: Math.round(s.confidence * 10_000),
        price: round.price,
        issuedAt: BigInt(issuedAt),
        horizonSec: BigInt(horizonSec),
      };
      const leaf: AlphaLeaf = { record: signalToJson(record), signature: await signalTyped.sign(signer, this.chain.domain, record) };
      appendFileSync(this.opts.file, `${JSON.stringify(leaf)}\n`); // logged before anyone can buy it
      this.chain.add(leaf);
      const p = { leaf, epoch, momentumBps: s.momentumBps, round, window: rounds.length };
      this.latest.set(ticker, p);
      return p;
    });
  }

  /**
   * Commit the head of the epoch that just closed (HushAlpha accepts no other). Called a few seconds after every epoch
   * boundary; an epoch missed while the process was down stays a gap, and its records are bound by the next commit.
   */
  async commitClosed(committer: WalletClient<Transport, Chain, Account>): Promise<{ epoch: bigint; tx: Hex } | undefined> {
    const closed = epochOf(nowSec(), this.epochLen) - 1n;
    if (closed <= this.lastCommitted) return undefined;
    const head = await this.exclusive(async () => {
      if (this.firstCommitted === 0n && this.chain.genesisEpoch !== closed) this.chain.rebase(closed);
      this.sealed = closed;
      return this.chain.head(closed);
    });
    const tx = await committer.writeContract({ address: this.opts.contracts.hushAlpha, abi: hushAlphaAbi, functionName: "commitChainHead", args: [this.subject, closed, head] });
    const receipt = await this.opts.publicClient.waitForTransactionReceipt({ hash: tx });
    if (receipt.status !== "success") throw new Error(`commitChainHead(${closed}) reverted: ${tx}`);
    if (this.firstCommitted === 0n) this.firstCommitted = closed;
    this.lastCommitted = closed;
    return { epoch: closed, tx };
  }

  /** Latest committed epoch whose calls have all resolved: proofs stop there, so they never give live calls away. */
  staleEpoch(): bigint {
    const resolvedBefore = epochOf(nowSec() - this.opts.horizonSec, this.epochLen) - 1n;
    return resolvedBefore < this.lastCommitted ? resolvedBefore : this.lastCommitted;
  }

  /** [start, end] epochs of a proof: `to` is capped at the stale epoch, `from` defaults to `windowEpochs` before it. */
  private window(from?: bigint, to?: bigint): { start: bigint; end: bigint } | { error: string } {
    if (this.firstCommitted === 0n) return { error: "no chain head committed yet" };
    const stale = this.staleEpoch();
    const end = to === undefined || to > stale ? stale : to;
    let start = from ?? end - BigInt(this.opts.windowEpochs) + 1n;
    if (start < this.firstCommitted) start = this.firstCommitted;
    if (end < start) return { error: "no resolved, committed epochs yet — try again after one signal horizon" };
    return { start, end };
  }

  proof(from?: bigint, to?: bigint): AlphaProof | { error: string } {
    const w = this.window(from, to);
    if ("error" in w) return w;
    const reveal = this.opts.reveal;
    return this.chain.proof(w.start, w.end, reveal && ((leaf) => reveal(leaf, this.grades.get(this.hash(leaf)))));
  }

  private hash(leaf: AlphaLeaf) {
    return leafHash(this.chain.domain, "signal", leaf);
  }

  /** Whether epoch e has a head on-chain. Final for every e ≤ lastCommitted (a passed epoch can't be committed later). */
  private readonly committed = new Map<bigint, boolean>();
  private async isCommitted(e: bigint): Promise<boolean> {
    let c = this.committed.get(e);
    if (c === undefined) {
      const head = (await this.opts.publicClient.readContract({ address: this.opts.contracts.hushAlpha, abi: hushAlphaAbi, functionName: "getChainHead", args: [this.subject, e] })) as Hex;
      c = BigInt(head) !== 0n;
      this.committed.set(e, c);
    }
    return c;
  }

  /** The first committed epoch ≥ e (≤ upTo) — the commit that bound a record of epoch e, as the verifier computes it. */
  private async bindingOf(e: bigint, upTo: bigint): Promise<bigint | null> {
    for (let b = e; b <= upTo; b++) if (await this.isCommitted(b)) return b;
    return null;
  }

  /**
   * Grade the calls in the default window (resolved grades are cached) and recompute what the provider claims — with
   * the verifier's rules (graded from each call's commit deadline), so an honest provider's claims equal its verified
   * record.
   */
  async refreshClaims(): Promise<AlphaClaims> {
    const w = this.window();
    if ("error" in w) return this.claims;
    const leaves = this.chain.allLeaves().filter(({ epoch }) => epoch >= w.start && epoch <= w.end);
    for (const { epoch, leaf } of leaves) {
      const h = this.hash(leaf);
      if (this.grades.has(h)) continue;
      const b = await this.bindingOf(epoch, w.end);
      const g = await gradeSignal(leaf.record as SignalRecordJson, {
        publicClient: this.opts.publicClient,
        oracle: this.opts.contracts.stockOracle,
        epoch,
        fixedAt: b === null ? null : commitDeadline(b, this.epochLen),
      });
      if (g !== "price-mismatch" && g.outcome !== "pending") this.grades.set(h, g);
    }
    const reveal = this.opts.reveal ?? (() => true);
    const shown = leaves.map(({ leaf }) => ({ leaf, g: this.grades.get(this.hash(leaf)) })).filter(({ leaf, g }) => g && reveal(leaf, g));
    const s = summarize(shown.map(({ g }) => g!));
    this.claims = { winRate: s.winRate, calls: s.calls, since: Number(w.start) * this.epochLen, proofUrl: this.opts.proofUrl };
    return this.claims;
  }

  info() {
    return {
      subject: this.subject,
      proofUrl: this.opts.proofUrl,
      claims: this.claims,
      epochLen: this.epochLen,
      genesisEpoch: this.chain.genesisEpoch.toString(),
      lastCommittedEpoch: this.lastCommitted.toString(),
      records: this.chain.allLeaves().length,
    };
  }
}
