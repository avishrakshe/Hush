import { type Address, type Hex, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AlphaChain,
  type AlphaLeaf,
  type AlphaProof,
  DIRECTION,
  type SignalRecordJson,
  alphaDomain,
  signalToJson,
  signalTyped,
  tickerToBytes32,
  verifyProof,
} from "../src/index.js";

// Well-known Hardhat test keys — never use outside tests.
const provider = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const stranger = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");

const L = 60;
const G = 30_000_000n; // genesis epoch (≈ 2027 in unix minutes; any value works)
const HUSH_ALPHA = "0x1111111111111111111111111111111111111111" as Address;
const ORACLE = "0x2222222222222222222222222222222222222222" as Address;
const NVDA = tickerToBytes32("NVDA");
const domain = alphaDomain(43113, HUSH_ALPHA);
const t0 = Number(G) * L;

/** Oracle: a round every 30 s, price rising 0.10 per round for 5 minutes, then falling (UP wins early, DOWN later). */
const rounds: { ts: number; price: bigint }[] = [];
for (let i = -20; i < 400; i++) {
  const step = i < 10 ? i : 20 - i;
  rounds.push({ ts: t0 + i * 30, price: 180_000_000n + BigInt(step) * 100_000n });
}
const priceAt = (ts: number) => {
  let k = -1;
  for (let i = 0; i < rounds.length; i++) if (rounds[i]!.ts <= ts) k = i;
  return { k, ...rounds[k]! };
};

function fakeChain(heads: Map<bigint, Hex>, genesis = G) {
  return {
    async readContract({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) {
      if (address === HUSH_ALPHA) {
        if (functionName === "epochLen") return BigInt(L);
        if (functionName === "firstEpoch") return genesis;
        if (functionName === "getChainHead") return heads.get(args![1] as bigint) ?? zeroHash;
      }
      if (address === ORACLE) {
        if (functionName === "getPriceAt") {
          const p = priceAt(Number(args![1]));
          return [p.price, BigInt(p.ts), BigInt(p.k)];
        }
        if (functionName === "getRound") {
          const r = rounds[Number(args![1])]!;
          return [r.price, BigInt(r.ts)];
        }
      }
      throw new Error(`unexpected read ${functionName}`);
    },
  };
}

async function signal(issuedAt: number, direction: keyof typeof DIRECTION, opts: { horizonSec?: number; price?: bigint; signer?: typeof provider } = {}): Promise<AlphaLeaf> {
  const record = {
    provider: provider.address,
    ticker: NVDA,
    direction: DIRECTION[direction],
    confidenceBps: 6_500,
    price: opts.price ?? priceAt(issuedAt).price,
    issuedAt: BigInt(issuedAt),
    horizonSec: BigInt(opts.horizonSec ?? 3 * L),
  };
  return { record: signalToJson(record), signature: await signalTyped.sign(opts.signer ?? provider, domain, record) };
}

const newChain = () => new AlphaChain({ kind: "signal", subject: provider.address, chainId: 43113, hushAlpha: HUSH_ALPHA, epochLen: L, genesisEpoch: G });
/** Commit every epoch in [G, to] except `skip` (an honest committer that missed those). */
function commitAll(chain: AlphaChain, to: bigint, skip: bigint[] = []) {
  const heads = new Map<bigint, Hex>();
  for (let e = G; e <= to; e++) if (!skip.includes(e)) heads.set(e, chain.head(e));
  return heads;
}

describe("Proof of Alpha", () => {
  let chain: AlphaChain;
  const LAST = G + 8n;
  const now = Number(LAST + 4n) * L;

  beforeEach(async () => {
    chain = newChain();
    // Epoch G: two calls · G+1: none (heartbeat) · G+2: one call · G+5: a DOWN call during the fall
    chain.add(await signal(t0 + 5, "UP"));
    chain.add(await signal(t0 + 40, "UP"));
    chain.add(await signal(t0 + 2 * L + 10, "DOWN"));
    chain.add(await signal(t0 + 5 * L + 10, "DOWN"));
  });

  it("an honest proof verifies; calls are graded at their horizon; empty epochs are heartbeats", async () => {
    const heads = commitAll(chain, LAST);
    const r = await verifyProof(chain.proof(G, LAST), { publicClient: fakeChain(heads), oracle: ORACLE, now });
    expect(r).toMatchObject({ valid: true, records: 4, committedEpochs: 9, gaps: [], calls: 4 });
    // Price rises for the first 5 minutes, then falls: both UPs win, the early DOWN loses, the late DOWN wins.
    expect(r.graded.map((g) => g.outcome)).toEqual(["win", "win", "loss", "win"]);
    expect(r.winRate).toBe(0.75);
    expect(r.maxDrawdownBps).toBeGreaterThan(0);
    // Each graded move starts at the commit deadline of the call's epoch (end of the next epoch), not at issuedAt.
    expect(r.graded[0]).toMatchObject({ fixedAt: t0 + 2 * L, gradedFrom: priceAt(t0 + 2 * L).price.toString() });
  });

  it("hindsight inside an epoch earns nothing: a back-dated call is graded from its commit deadline", async () => {
    // At t0+5L+55 a cheater has seen the fall since t0+5L and files a DOWN call stamped at t0+5L (same epoch, G+5).
    const cheat = newChain();
    cheat.add(await signal(t0 + 5 * L, "DOWN"));
    const heads = commitAll(cheat, LAST);
    const r = await verifyProof(cheat.proof(G, LAST), { publicClient: fakeChain(heads), oracle: ORACLE, now });
    const g = r.graded[0]!;
    const fixedAt = t0 + 7 * L;
    expect(g).toMatchObject({ outcome: "win", fixedAt, gradedFrom: priceAt(fixedAt).price.toString() });
    // Graded from issuedAt it would have banked the move it already saw; from the deadline only what came after.
    const exit = Number(priceAt(t0 + 8 * L).price);
    const fromIssued = Math.round(((Number(priceAt(t0 + 5 * L).price) - exit) / Number(priceAt(t0 + 5 * L).price)) * 10_000);
    expect(g.returnBps).toBeLessThan(fromIssued);
    expect(g.returnBps).toBe(Math.round(((Number(priceAt(fixedAt).price) - exit) / Number(priceAt(fixedAt).price)) * 10_000));
  });

  it("dropping a losing call breaks the chain exactly at that epoch", async () => {
    const heads = commitAll(chain, LAST);
    const losing = chain.leaves(G + 2n)[0]!;
    const doctored = chain.proof(G, LAST, (l) => l !== losing);
    const r = await verifyProof(doctored, { publicClient: fakeChain(heads), oracle: ORACLE, now });
    expect(r).toMatchObject({ valid: false, failedEpoch: (G + 2n).toString() });
    expect(r.reason).toMatch(/chain diverges from on-chain head/);
  });

  it("adding a call after the fact (back-dated into a committed epoch) breaks the chain there", async () => {
    const heads = commitAll(chain, LAST);
    const proof = chain.proof(G, LAST);
    const late = await signal(t0 + L + 30, "UP"); // filed under G+1, which was committed as a heartbeat
    proof.epochs.splice(1, 0, { epoch: (G + 1n).toString(), leaves: [late] });
    const r = await verifyProof(proof, { publicClient: fakeChain(heads), oracle: ORACLE, now });
    expect(r).toMatchObject({ valid: false, failedEpoch: (G + 1n).toString() });
    expect(r.reason).toMatch(/diverges/);
  });

  it("a record filed outside the epoch it happened in is rejected", async () => {
    const heads = commitAll(chain, LAST);
    const proof = chain.proof(G, LAST);
    proof.epochs[0]!.leaves[0] = await signal(t0 + 3 * L, "UP"); // happened in G+3, filed under G
    const r = await verifyProof(proof, { publicClient: fakeChain(heads), oracle: ORACLE, now });
    expect(r).toMatchObject({ valid: false, failedEpoch: G.toString() });
    expect(r.reason).toMatch(/outside the epoch/);
  });

  it("a forged or altered signature is rejected", async () => {
    const heads = commitAll(chain, LAST);
    const proof = chain.proof(G, LAST);
    const leaf = proof.epochs[0]!.leaves[1]!;
    const forged = await signal(Number((leaf.record as SignalRecordJson).issuedAt), "UP", { signer: stranger });
    proof.epochs[0]!.leaves[1] = { record: leaf.record, signature: forged.signature };
    const r = await verifyProof(proof, { publicClient: fakeChain(heads), oracle: ORACLE, now });
    expect(r).toMatchObject({ valid: false, failedEpoch: G.toString() });
    expect(r.reason).toMatch(/signature/);
  });

  it("a signed, committed record with a made-up entry price is caught against the oracle", async () => {
    const liar = newChain();
    liar.add(await signal(t0 + 5, "UP", { price: 150_000_000n })); // signed and committed — but the oracle said ~180
    const heads = commitAll(liar, LAST);
    const r = await verifyProof(liar.proof(G, LAST), { publicClient: fakeChain(heads), oracle: ORACLE, now });
    expect(r).toMatchObject({ valid: false, failedEpoch: G.toString() });
    expect(r.reason).toMatch(/entry price/);
  });

  it("stale-only reveals: an older window verifies on its own, and a window can start mid-chain from a committed anchor", async () => {
    const heads = commitAll(chain, LAST);
    const old = await verifyProof(chain.proof(G, G + 2n), { publicClient: fakeChain(heads), oracle: ORACLE, now });
    expect(old).toMatchObject({ valid: true, records: 3, toEpoch: (G + 2n).toString() });
    const mid = chain.proof(G + 3n, LAST);
    expect(mid.anchorHead).toBe(heads.get(G + 2n));
    expect(await verifyProof(mid, { publicClient: fakeChain(heads), oracle: ORACLE, now })).toMatchObject({ valid: true, records: 1 });
    // A wrong anchor is rejected.
    expect(await verifyProof({ ...mid, anchorHead: zeroHash } as AlphaProof, { publicClient: fakeChain(heads), oracle: ORACLE, now })).toMatchObject({
      valid: false,
      failedEpoch: (G + 2n).toString(),
    });
  });

  it("missed commits are gaps: records there are bound by the next commit, and too-late ones are not graded", async () => {
    const heads = commitAll(chain, LAST, [G + 2n, G + 3n, G + 4n]); // the G+2 call is only bound at G+5
    const r = await verifyProof(chain.proof(G, LAST), { publicClient: fakeChain(heads), oracle: ORACLE, now });
    expect(r).toMatchObject({ valid: true, gaps: [(G + 2n).toString(), (G + 3n).toString(), (G + 4n).toString()] });
    expect(r.graded.find((g) => g.epoch === (G + 2n).toString())?.outcome).toBe("unbound");
    expect(r.unbound).toBe(1);
    expect(r.calls).toBe(3);
  });

  it("an empty chain is all heartbeats and still verifies", async () => {
    const empty = newChain();
    const heads = commitAll(empty, G + 3n);
    expect(await verifyProof(empty.proof(G, G + 3n), { publicClient: fakeChain(heads), oracle: ORACLE, now })).toMatchObject({ valid: true, records: 0, calls: 0 });
  });
});
