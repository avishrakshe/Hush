import { SiteHeader } from "@/components/site/SiteHeader";
import { REPO_URL, addressUrl } from "@/lib/chain";
import { HUSH_DEPLOYMENTS } from "@hush/x402/contracts";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Docs",
  description: "How Hush works: x402 schemes on eERC, the SDK, the MCP server, Proof of Alpha, contracts on Fuji, and the trust model.",
};

const TOC = [
  ["overview", "Overview"],
  ["quickstart", "Quickstart"],
  ["schemes", "Schemes"],
  ["credit", "hush-credit, step by step"],
  ["desk", "Trading: hush-rfq"],
  ["prove", "Proof of Alpha & trade reports"],
  ["sdk", "SDK"],
  ["mcp", "MCP server"],
  ["views", "Who sees what"],
  ["contracts", "Contracts on Fuji"],
  ["trust", "Trust model & limitations"],
  ["related", "Related work"],
] as const;

export default function DocsPage() {
  const c = HUSH_DEPLOYMENTS[43113]!; // Fuji
  const contracts: [string, string | undefined, string][] = [
    ["EncryptedERC (converter)", c.encryptedErc, "Ava Labs eERC, vendored @8dc98cd — encrypted balances, Groth16-verified transfers, auditor key"],
    ["Registrar", c.registrar, "eERC BabyJubJub public keys"],
    ["MockUSDC", c.usdc, "EIP-3009 test USDC (the asset x402 `exact` moves and eERC wraps as hUSDC)"],
    ["HushRegistry", c.hushRegistry, "providers, agents (EIP-712 consent), owner kill switch, provider flags"],
    ["HushLedger", c.hushLedger, "Merkle batch roots of consumed vouchers; EIP-712 domain for vouchers + receipts"],
    ["HushAlpha", c.hushAlpha, "EIP-712 domain for quotes / fills / statements / signals; Proof of Alpha chain heads"],
    ["MockStockOracle", c.stockOracle, "mock stock prices, rounds stamped with block.timestamp, getPriceAt"],
    ["mNVDA", c.stocks?.NVDA, "mock stock (18 dp, faucet-capped)"],
    ["mTSLA", c.stocks?.TSLA, "mock stock"],
    ["mSPY", c.stocks?.SPY, "mock stock"],
  ];

  return (
    <>
      <SiteHeader />
      <main className="mx-auto grid max-w-7xl gap-10 px-5 pb-32 pt-10 sm:px-8 lg:grid-cols-[13rem_1fr]">
        <nav aria-label="On this page" className="hidden lg:block">
          <ul className="sticky top-24 space-y-1.5 font-mono text-[11px] uppercase tracking-[0.14em]">
            {TOC.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`} className="text-ink-faint hover:text-ink">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <article className="min-w-0 max-w-3xl">
          <p className="kicker">Docs</p>
          <h1 className="mt-3 font-display text-[clamp(2rem,4vw,3rem)] font-semibold leading-[1] tracking-[-0.03em]">
            Private by default. <span className="text-cyan">Provable on demand.</span>
          </h1>

          <H2 id="overview">Overview</H2>
          <P>
            AI agents pay for APIs and trade with x402: an HTTP <C>402</C> names a price, the client pays, the server serves.
            On a public chain every payment is a receipt anyone can read — who paid whom, how much, how often — and that is
            enough to reconstruct an agent&apos;s strategy. Mirror, the copycat in the live demo, does exactly that.
          </P>
          <P>
            Hush adds private x402 schemes on <B>eERC</B>, Avalanche&apos;s encrypted ERC-20: balances and amounts are
            ElGamal ciphertexts, and every transfer carries a Groth16 proof C-Chain verifies itself. No coprocessor, no second
            network. The agent&apos;s owner and an optional auditor can decrypt everything; nobody else can.
          </P>
          <P>Hush closes the three ways a strategy leaks — what an agent learns, does, and holds — and lets it prove its record without publishing it:</P>
          <Ul>
            <li>
              <B>Learn</B> — <C>hush-credit</C>: one encrypted top-up, then off-chain signed vouchers per call.
            </li>
            <li>
              <B>Trade</B> — <C>hush-rfq</C>: the 402 <i>is</i> a desk-signed quote, paid with a voucher. No trade touches the chain.
            </li>
            <li>
              <B>Hold</B> — the desk custodies positions and signs statements; settle-out is a private eERC transfer.
            </li>
            <li>
              <B>Prove</B> — signal providers commit hash chains to <C>HushAlpha</C>; agents hand out verifiable trade reports.
            </li>
          </Ul>

          <H2 id="quickstart">Quickstart</H2>
          <P>Node 22+, pnpm. Everything runs on a local hardhat chain; the same commands without <C>:local</C> target Fuji.</P>
          <Pre>{`git clone ${REPO_URL} && cd Hush && pnpm install
pnpm keys                                   # role keys → .env (testnet only)
pnpm node                                   # terminal 1: hardhat
pnpm fund:local && pnpm deploy:local && pnpm bootstrap:local
pnpm demo:local                             # facilitator, providers, desk, operator, Mirror, Atlas, Veil
pnpm web                                    # → http://localhost:3000/demo`}</Pre>
          <P>Checks:</P>
          <Pre>{`pnpm test                 # contracts + SDK unit tests
pnpm e2e:local            # hush-credit end to end
pnpm desk-e2e:local       # hush-rfq: quotes, fills, custody, settle-outs
pnpm alpha-e2e:local      # Proof of Alpha: SignalCo verifies, AlphaKing fails
pnpm mcp:smoke:local      # drive the MCP server like Claude Desktop does`}</Pre>

          <H2 id="schemes">Schemes</H2>
          <P>All schemes are x402 v2 mechanisms (<C>PAYMENT-REQUIRED</C> / <C>PAYMENT-SIGNATURE</C> / <C>PAYMENT-RESPONSE</C>, network <C>eip155:43113</C>), so a server offers them side by side and the client picks.</P>
          <Table
            head={["scheme", "on-chain per call", "hides", "use"]}
            rows={[
              ["exact", "1 USDC transfer (EIP-3009)", "nothing", "the public baseline (@x402/evm)"],
              ["hush-direct", "1 eERC transfer + proof", "amount", "reference implementation"],
              ["hush-credit", "nothing (vouchers); top-ups + roots occasionally", "amount, frequency, per-call pattern", "the product — paying APIs"],
              ["hush-rfq", "nothing", "asset, size, side, price, timing", "trading at the Hush Desk"],
            ]}
          />

          <H2 id="credit">hush-credit, step by step</H2>
          <Ol>
            <li>The owner deposits USDC into the eERC converter (hUSDC) and privately funds agents from a treasury.</li>
            <li>
              The agent calls <C>GET /api/feed</C> and gets a <C>402</C> listing <C>hush-credit</C> with the provider, price, minimum top-up and facilitator.
            </li>
            <li>The agent sends one private eERC transfer to the provider, in a fixed chunk size, with jittered timing.</li>
            <li>
              The facilitator decrypts the amount from the receiver PCT in calldata, credits the agent and returns a provider-signed <C>CreditReceipt</C>.
            </li>
            <li>
              Every call carries an EIP-712 voucher <C>{"{agent, provider, cumulativeSpent, nonce, requestHash, expiry}"}</C>. The facilitator
              checks signature, monotonic nonce, <C>cumulativeSpent ≤ credit</C>, expiry, and <C>HushRegistry.isFrozen</C> — milliseconds, no
              transaction.
            </li>
            <li>
              Every 2 minutes — <B>including empty batches</B>, so commit timing never reveals activity — consumed vouchers are Merkle-ized into{" "}
              <C>HushLedger.commitBatch</C>. The agent keeps its vouchers and verifies inclusion.
            </li>
            <li>Unused credit is refundable privately; credit expires after 7 days.</li>
          </Ol>

          <H2 id="desk">Trading: hush-rfq</H2>
          <P>
            <C>GET /rfq?ticker&amp;side=buy&amp;size&amp;agent</C> answers <C>402</C> with one desk-signed <C>Quote</C> (valid ~15 s) carried in the
            requirements&apos; <C>extra</C>. The agent pays the notional with a normal Hush voucher in its desk credit stream whose{" "}
            <C>requestHash</C> is the quote&apos;s EIP-712 digest — so the payment is bound to exactly one quote, and the fill lands in the desk&apos;s
            HushLedger batches like any voucher. The desk returns a signed <C>FillReceipt</C> and <C>PositionStatement</C> in <C>PAYMENT-RESPONSE</C>.
          </P>
          <Ul>
            <li>
              Sells: <C>GET /quote?side=sell</C> → <C>POST /sell</C> with a zero-increment voucher as the signed order; proceeds go to desk credit.
            </li>
            <li>
              Custody: statements carry a per-agent <C>seq</C> (1, 2, 3, …). The agent audits them against its own fills (<C>verifyPositions</C>).
            </li>
            <li>
              Settle-out: <C>POST /settle-out</C> queues one private eERC transfer of hStock, sent on the batch tick with other agents&apos; settle-outs.
            </li>
            <li>Guard rails: <C>TradePolicy</C> (desk allowlist, tickers, per-trade max, position max, daily cap) is enforced before anything is signed.</li>
          </Ul>

          <H2 id="prove">Proof of Alpha & trade reports</H2>
          <P>
            <B>Signal providers.</B> Each signed call is a leaf. Per epoch, <C>digest = keccak(epoch, leafHashes)</C> (or a heartbeat when empty) and{" "}
            <C>head = keccak(prevHead, digest)</C>; the head is committed to <C>HushAlpha</C> during the next epoch, every epoch. A proof reveals all records
            of a range; the verifier recomputes every head, checks signatures, epoch filing, and the oracle price at issue time. Dropping, adding, back-dating
            or editing a call breaks the first doctored epoch. Calls are graded from their commit deadline, so nothing can be written with hindsight.
            AlphaKing hides its losers and claims ~90% — its proof fails.
          </P>
          <P>
            <B>Agents.</B> <C>buildTradeReport</C> bundles every desk-signed fill and statement, and per fill its quote, the agent&apos;s voucher (requestHash =
            quote digest) and that voucher&apos;s HushLedger inclusion proof. <C>verifyTradeReport</C> (viem only, runs in a browser) checks the signatures and
            links, requires statements 1…N with each step explained by exactly one fill or settle-out, replays the desk&apos;s average-cost arithmetic and marks
            P&amp;L at the oracle. A hidden losing round trip leaves unexplained statements. It trusts the desk, the counterparty that signs every record.
          </P>

          <H2 id="sdk">SDK — @hush/x402</H2>
          <Pre>{`// agent
import { createHushFetch, HushDeskClient } from "@hush/x402/client";
const hush = createHushFetch({
  mode: "hush-credit", wallet, eercClient, publicClient, store,
  policy: { dailyCap: 5_000_000n, allowedProviders },          // API spend
  tradePolicy: { maxNotionalPerTrade: 25_000_000n },           // trading
  privacy: { topUpChunks: [5_000_000n], jitterMs: [10_000, 45_000] },
});
await hush.fetch("https://provider.example/api/signal?ticker=NVDA");
const desk = new HushDeskClient({ deskUrl, hush, signer: wallet });
await desk.buy("NVDA", "0.10");   await desk.positions();   await desk.settleOut("NVDA", "0.05");

// provider
import { hushMiddleware } from "@hush/x402/server";
app.use(hushMiddleware({ payTo, contracts, facilitatorUrl,
  routes: { "GET /api/feed": { price: "$0.01" } } }));   // offers hush-credit, exact, hush-direct

// anyone, in a browser
import { checkProvider, verifyTradeReport } from "@hush/x402/contracts";`}</Pre>
          <P>
            Entry points: <C>.</C> (everything, incl. the eERC account), <C>/client</C>, <C>/server</C>, <C>/facilitator</C>, <C>/node</C> (JSON-file store),{" "}
            <C>/contracts</C> (browser-safe: ABIs, deployments, verification).
          </P>

          <H2 id="mcp">MCP server — @hush/mcp</H2>
          <P>Any MCP host (Claude Desktop, Claude Code, Cursor) gets private payments and trading as tools. stdio; nothing but JSON-RPC on stdout.</P>
          <Table
            head={["tool", "does"]}
            rows={[
              ["hush_pay(url, maxPrice?)", "pay an x402 endpoint via hush-credit; never falls back to a public payment"],
              ["hush_balance · hush_history · hush_verify · hush_refund", "private balance and credit, own history, voucher inclusion, private refund"],
              ["hush_freeze · hush_unfreeze", "owner kill switch"],
              ["hush_quote · hush_trade · hush_positions · hush_settle", "trade at the Hush Desk with hush-rfq, custody, settle-out"],
              ["hush_verify_provider(url)", "verify a signal provider's Proof of Alpha before paying"],
              ["hush_prove_me()", "build, verify and save the agent's trade report"],
            ]}
          />
          <Pre>{`claude mcp add hush -- node packages/mcp/bin/hush-mcp.mjs`}</Pre>

          <H2 id="views">Who sees what</H2>
          <Table
            head={["", "public", "owner", "auditor"]}
            rows={[
              ["amounts & balances", "ciphertext", "✓ (agent eERC keys)", "✓ (auditor key)"],
              ["top-up sender / receiver", "✓ (known limitation)", "✓", "✓"],
              ["calls, trades, positions", "Merkle roots only", "✓ sealed telemetry + ledger", "✓ sealed telemetry"],
              ["call frequency", "no — fixed-cadence roots", "✓", "✓"],
            ]}
          />
          <P>
            Agent telemetry is sealed with a Poseidon-ECDH key wrap to the owner&apos;s and auditor&apos;s eERC keys plus AES-GCM. The operator exports every eERC
            movement with auditor-decrypted amounts as CSV.
          </P>

          <H2 id="contracts">Contracts on Fuji</H2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <tbody>
                {contracts
                  .filter(([, a]) => a)
                  .map(([name, address, what]) => (
                    <tr key={name} className="border-t border-line align-top">
                      <td className="py-2 pr-4 font-medium text-ink">{name}</td>
                      <td className="py-2 pr-4 font-mono text-[11px]">
                        <a href={addressUrl(address!)} target="_blank" rel="noreferrer" className="text-cyan underline decoration-line-strong underline-offset-2">
                          {address}
                        </a>
                      </td>
                      <td className="py-2 text-ink-dim">{what}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          <H2 id="trust">Trust model & limitations</H2>
          <Ul>
            <li>
              <B>Prepaid credit trusts the provider.</B> Bounded by signed receipts, on-chain Merkle roots the agent verifies, private refunds, 7-day expiry, and
              public <C>flagProvider</C> evidence. A contract can&apos;t escrow an eERC balance: only the BabyJubJub key holder can spend it, via a ZK proof.
            </li>
            <li>
              <B>Addresses are public.</B> eERC hides amounts, not the sender/receiver of a top-up. Mitigations: few top-ups, fixed chunk sizes, timing jitter.
              A relayer or pooled payer is future work.
            </li>
            <li>
              <B>Custody trusts the desk</B>, bounded by signed statements the agent audits and custody that never exceeds the desk&apos;s encrypted inventory.
            </li>
            <li>
              <B>Proofs take seconds</B> — hence credit mode: one proof per top-up, not per call.
            </li>
            <li>
              Converter deposits are public and use fixed randomness; a balance becomes confidential once a private transfer is received. eERC registration is
              one-time (no key rotation; the wallet is the key backup).
            </li>
            <li>Mock stocks and a mock oracle on Fuji — no issuer integration is claimed.</li>
          </Ul>

          <H2 id="related">Related work</H2>
          <Ul>
            <li>
              <B>x402 batch-settlement</B> (x402 foundation): escrow-backed channels, cumulative vouchers, batched claims — trustless for the client, but deposits,
              amounts and claims are public. hush-credit is its private counterpart, trading escrow for provider trust (see above).
            </li>
            <li>
              <B>x402z</B> (Mind Network + Zama; FHE, ERC-7984) and <B>Fhenix</B> (FHE) need a coprocessor network. Hush uses client-side zk-SNARKs + ElGamal
              verified on C-Chain.
            </li>
            <li>
              <B>PrivateX402</B> (Nethermind): payment channels.
            </li>
            <li>
              Hush adds: Avalanche-native, compliance built in (public / owner / auditor), hidden call frequency, provider accountability, verifiable track
              records, a drop-in x402 v2 mechanism, and an MCP server for any LLM agent.
            </li>
          </Ul>
          <p className="mt-12 font-mono text-[11px] text-ink-faint">
            eERC contracts © Ava Labs, Ecosystem License (Avalanche-only). Hush code MIT. <a href={REPO_URL} className="underline">Source</a>.
          </p>
        </article>
      </main>
    </>
  );
}

function H2({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="mt-14 scroll-mt-24 border-t border-line pt-8 font-display text-2xl font-semibold tracking-tight">
      {children}
    </h2>
  );
}
const P = ({ children }: { children: ReactNode }) => <p className="mt-4 text-[15px] leading-relaxed text-ink-dim">{children}</p>;
const B = ({ children }: { children: ReactNode }) => <strong className="font-semibold text-ink">{children}</strong>;
const C = ({ children }: { children: ReactNode }) => <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[0.85em] text-ink">{children}</code>;
const Ul = ({ children }: { children: ReactNode }) => <ul className="mt-4 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-ink-dim marker:text-ink-faint">{children}</ul>;
const Ol = ({ children }: { children: ReactNode }) => <ol className="mt-4 list-decimal space-y-2 pl-5 text-[15px] leading-relaxed text-ink-dim marker:text-violet">{children}</ol>;
function Pre({ children }: { children: string }) {
  return (
    <pre className="glass mt-4 overflow-x-auto rounded-xl px-5 py-4 font-mono text-[12px] leading-relaxed text-ink-dim">
      <code>{children}</code>
    </pre>
  );
}
function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-left text-[12.5px]">
        <thead>
          <tr className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-faint">
            {head.map((h) => (
              <th key={h} className="pb-2 pr-4 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[0]} className="border-t border-line align-top">
              {r.map((cell, i) => (
                <td key={i} className={`py-2 pr-4 ${i === 0 ? "font-mono text-[11.5px] text-ink" : "text-ink-dim"}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
