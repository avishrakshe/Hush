import { ModeToggle, VeilButton } from "@/components/landing/ModeToggle";
import { ObserverTerminal } from "@/components/landing/ObserverTerminal";
import { ProofPanel } from "@/components/landing/ProofPanel";
import { SceneRoot } from "@/components/landing/SceneRoot";
import { ScrollProgress } from "@/components/landing/ScrollProgress";
import { SiteHeader } from "@/components/site/SiteHeader";
import { REPO_URL } from "@/lib/chain";
import type { ReactNode } from "react";

const CHAPTERS = [
  { href: "#veil", label: "The veil" },
  { href: "#how", label: "How it works" },
  { href: "#proof", label: "Proof" },
  { href: "#prove", label: "Prove" },
  { href: "#faq", label: "FAQ" },
  { href: "/demo", label: "Live demo", accent: true },
  { href: "/docs", label: "Docs" },
];

const H1 = "font-display text-[clamp(2.8rem,7vw,6.2rem)] leading-[0.92]";
const H2 = "font-display text-[clamp(2.4rem,5.4vw,4.8rem)] leading-[0.95]";
const LEDE = "mt-6 text-[15.5px] leading-relaxed text-ink-dim sm:text-[17px]";

export default function Home() {
  return (
    <>
      <SceneRoot />
      <ScrollProgress />
      <SiteHeader fixed links={CHAPTERS} right={<ModeToggle className="hidden sm:grid" />} />

      {/* overflow-x-clip (not hidden): clips the headings' glow without breaking the sticky chapters */}
      <main className="relative z-10 overflow-x-clip">
        {/* ── 01 THE LEAK ─────────────────────────────────────────────────── */}
        <section id="leak" data-chapter="0" aria-labelledby="leak-title" className="relative min-h-[175vh]">
          <div className="sticky top-0 flex min-h-dvh flex-col justify-between gap-10 px-5 pb-10 pt-32 sm:px-10 lg:px-16">
            <div className="max-w-2xl">
              <p className="kicker">01 · The leak</p>
              <h1 id="leak-title" className={`mt-6 ${H1}`}>
                Every x402 payment is a <em className="text-leak">public receipt.</em>
              </h1>
              <p className={`max-w-xl ${LEDE}`}>
                Agents now pay per request — a cent for a price feed, a quarter for a model call. On a public chain each payment
                names the payer, the payee, the amount and the second it happened. Line them up and anyone can read what your
                agent is doing, and front-run what it does next.
              </p>
              <div className="mt-9 flex flex-wrap gap-3">
                <a href="/demo" className="btn-gold">
                  <span aria-hidden>✦</span> Watch it live
                </a>
                <a href="#veil" className="btn-ghost">
                  Drop the veil <span aria-hidden>↓</span>
                </a>
              </div>
            </div>
            <div className="flex justify-end">
              <div className="w-full max-w-[34rem]">
                <ObserverTerminal />
              </div>
            </div>
          </div>
        </section>

        {/* ── 02 THE VEIL ─────────────────────────────────────────────────── */}
        <section id="veil" data-chapter="1" aria-labelledby="veil-title" className="relative min-h-[175vh]">
          <div className="sticky top-0 flex min-h-dvh flex-col justify-between gap-10 px-5 pb-10 pt-32 sm:px-10 lg:px-16">
            <div className="max-w-xl">
              <p className="kicker">02 · The veil</p>
              <h2 id="veil-title" className={`mt-6 ${H2}`}>
                Hush puts x402 <em className="text-shine">behind eERC.</em>
              </h2>
              <p className={LEDE}>
                Payments move as encrypted ERC-20 on Avalanche C-Chain. Balances and amounts are ElGamal ciphertexts, and every
                transfer carries a Groth16 proof the chain verifies itself — no coprocessor, no second network.
              </p>
              <div className="mt-9">
                <VeilButton />
              </div>
            </div>
            <ul className="grid gap-3 sm:grid-cols-3 lg:max-w-4xl">
              <Viewer who="Public" icon="◎">
                Ciphertext, the sender and receiver of each top-up, and Merkle roots on a fixed clock.
              </Viewer>
              <Viewer who="Owner" icon="✦">
                Every agent&apos;s full history, decrypted with the agent&apos;s eERC key.
              </Viewer>
              <Viewer who="Auditor" icon="⌕">
                Every amount, through eERC&apos;s contract-level auditor key.
              </Viewer>
            </ul>
          </div>
        </section>

        {/* ── 03 HOW IT WORKS ─────────────────────────────────────────────── */}
        <section id="how" data-chapter="2" aria-labelledby="how-title" className="relative px-5 py-32 sm:px-10 lg:px-16">
          <SectionHead id="how-title" kicker="03 · How it works" title={<>One private top-up. <em className="text-shine">Hundreds of calls.</em></>}>
            A private take on x402&apos;s batch-settlement scheme: prepay once in encrypted hUSDC, then pay each request with a
            signed voucher. The chain sees one ciphertext and a Merkle root every two minutes.
          </SectionHead>

          <ol className="mx-auto mt-16 grid max-w-6xl gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Step n="1" title="Fund">
              The owner wraps USDC into encrypted hUSDC (eERC converter mode) and privately funds each agent from a treasury.
            </Step>
            <Step n="2" title="Top up">
              The agent gets <Code>HTTP 402</Code> with a <Code>hush-credit</Code> offer and sends one private eERC transfer. The
              facilitator decrypts it with the provider&apos;s key and returns a signed <Code>CreditReceipt</Code>.
            </Step>
            <Step n="3" title="Call">
              Every request carries an EIP-712 voucher — cumulative spend, nonce, request hash, expiry — checked in milliseconds
              against credit, nonce and the owner&apos;s kill switch. No proof, no transaction.
            </Step>
            <Step n="4" title="Commit">
              Every two minutes, busy or idle, consumed vouchers become a Merkle root on <Code>HushLedger</Code>. Agents verify
              their own vouchers are inside; unused credit is refunded privately.
            </Step>
          </ol>

          <div className="mx-auto mt-6 grid max-w-6xl gap-4 lg:grid-cols-2">
            <Snippet label="agent · @hush/x402/client">
              <Ln c="kw">import</Ln> {"{ createHushFetch }"} <Ln c="kw">from</Ln> <Ln c="str">&quot;@hush/x402/client&quot;</Ln>;{"\n\n"}
              <Ln c="kw">const</Ln> agent = createHushFetch({"{"}
              {"\n  "}mode: <Ln c="str">&quot;hush-credit&quot;</Ln>,
              {"\n  "}wallet, <Ln c="cm">{"         // signs vouchers"}</Ln>
              {"\n  "}eercClient, <Ln c="cm">{"     // private top-ups"}</Ln>
              {"\n  "}policy: {"{ "}dailyCap: <Ln c="num">5_000_000n</Ln> {"}"}, <Ln c="cm">{"// 5 USDC"}</Ln>
              {"\n"}
              {"});"}
              {"\n"}
              <Ln c="kw">await</Ln> agent.fetch(<Ln c="str">&quot;https://api.example/feed&quot;</Ln>);
            </Snippet>
            <Snippet label="provider · @hush/x402/server">
              <Ln c="kw">import</Ln> {"{ hushMiddleware }"} <Ln c="kw">from</Ln> <Ln c="str">&quot;@hush/x402/server&quot;</Ln>;{"\n\n"}
              app.use(hushMiddleware({"{"}
              {"\n  "}payTo, contracts, facilitatorUrl,
              {"\n  "}routes: {"{ "}
              <Ln c="str">&quot;GET /api/feed&quot;</Ln>: {"{ "}price: <Ln c="str">&quot;$0.01&quot;</Ln> {"} }"},
              {"\n"}
              {"}));"}
              {"\n"}
              <Ln c="cm">{"// offers hush-credit, exact and hush-direct over x402 v2"}</Ln>
            </Snippet>
          </div>

          <div className="mx-auto mt-16 grid max-w-6xl gap-8 text-sm leading-relaxed text-ink-dim md:grid-cols-3">
            <Note title="vs x402 batch-settlement">Same cumulative-voucher model, trustless escrow — but deposits, amounts and claims are public.</Note>
            <Note title="vs FHE approaches">x402z and Fhenix need an FHE coprocessor network. Hush uses client-side zk-SNARKs and ElGamal, verified on C-Chain.</Note>
            <Note title="The trade-off">
              Prepaid credit trusts the provider — bounded by signed receipts, on-chain roots, private refunds and public flags. A
              contract can&apos;t escrow an eERC balance without changing eERC.
            </Note>
          </div>

          <BuiltOn />
        </section>

        {/* ── 04 PROOF ────────────────────────────────────────────────────── */}
        <section id="proof" data-chapter="3" aria-labelledby="proof-title" className="relative px-5 pb-24 pt-32 sm:px-10 lg:px-16">
          <SectionHead id="proof-title" kicker="04 · Proof" title={<>Live on <em className="text-avax">Avalanche</em> Fuji.</>}>
            Read from C-Chain right now — exactly the view any observer gets. Ciphertext and roots; no amounts, no call counts.
          </SectionHead>
          <div className="mx-auto mt-14 max-w-5xl">
            <ProofPanel />
            <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
              <a href={REPO_URL} target="_blank" rel="noreferrer" className="btn-ghost">
                Read the source <span aria-hidden>↗</span>
              </a>
              <code className="glass rounded-full px-5 py-3 font-mono text-xs text-ink-dim">
                pnpm e2e <span className="text-ink-faint"># 13 checks against Fuji</span>
              </code>
            </div>
          </div>
        </section>

        {/* ── 05 PROVE ────────────────────────────────────────────────────── */}
        <section id="prove" data-chapter="4" aria-labelledby="prove-title" className="relative px-5 pb-28 pt-32 sm:px-10 lg:px-16">
          <SectionHead id="prove-title" kicker="05 · Prove" title={<>Private by default. <em className="text-shine">Provable on demand.</em></>}>
            A strategy leaks through what an agent learns, trades and holds. Hush closes all three — then lets the agent, or the
            provider it pays, prove a track record to whoever it chooses, without publishing a thing.
          </SectionHead>

          <div className="mx-auto mt-14 grid max-w-6xl gap-4 md:grid-cols-3">
            <FeatureCard icon="◉" kicker="The copycat" title="Mirror reads the chain">
              A bot that only watches public transfers. It copies Atlas&apos;s every trade seconds later. Against Veil it sees
              encrypted top-ups to the desk — no size, no side, no price, no trade timing. Nothing to copy.
            </FeatureCard>
            <FeatureCard icon="⛓" kicker="Signal providers" title="Proof of Alpha">
              Every signed call goes into a hash chain committed to <Code>HushAlpha</Code> each epoch. Hide a losing call and the
              chain breaks at that epoch. AlphaKing claims 90%; its proof fails. Agents verify before they pay.
            </FeatureCard>
            <FeatureCard icon="✓" kicker="Agents" title="Trade reports">
              Desk-signed fills and statements, each fill tied to the voucher that paid for it and its Merkle root on{" "}
              <Code>HushLedger</Code>. The desk numbers its statements, so an omitted trade shows. Verified in a browser.
            </FeatureCard>
          </div>

          <div className="mt-12 flex flex-wrap items-center justify-center gap-3">
            <a href="/demo" className="btn-gold">
              <span aria-hidden>✦</span> Watch it live
            </a>
            <a href="/console/provider" className="btn-ghost">
              Verify a provider <span aria-hidden>↗</span>
            </a>
          </div>
        </section>

        {/* ── FAQ ─────────────────────────────────────────────────────────── */}
        <section id="faq" aria-labelledby="faq-title" className="relative bg-black/70 px-5 py-32 backdrop-blur-sm sm:px-10 lg:px-16">
          <SectionHead id="faq-title" kicker="FAQ" title="The questions we get asked.">
            What&apos;s hidden, what isn&apos;t, and who you have to trust.
          </SectionHead>
          <div className="mx-auto mt-14 max-w-3xl space-y-3">
            {FAQ.map(([q, a]) => (
              <details key={q} className="glass group rounded-[22px] px-6 py-5 open:pb-6">
                <summary className="flex cursor-pointer items-center justify-between gap-6 text-[17px] font-medium text-ink">
                  {q}
                  <span aria-hidden className="faq-plus text-2xl font-light text-gold transition-transform duration-300">
                    +
                  </span>
                </summary>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-dim">{a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* ── CLOSING CTA ─────────────────────────────────────────────────── */}
        <section aria-labelledby="cta-title" className="relative overflow-hidden bg-black px-5 pb-40 pt-32 text-center sm:px-10">
          <div aria-hidden className="glow-dots pointer-events-none absolute inset-x-0 bottom-0 h-[70%]" />
          <div className="relative mx-auto max-w-3xl">
            <p className="kicker">Private by default</p>
            <h2 id="cta-title" className={`mt-6 ${H2}`}>
              Let your agent pay without <em className="text-shine">telling the world.</em>
            </h2>
            <p className={`mx-auto max-w-xl ${LEDE}`}>
              A drop-in x402 v2 scheme, an MCP server for any LLM agent, and a live demo on Avalanche Fuji.
            </p>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
              <a href="/demo" className="btn-gold">
                <span aria-hidden>✦</span> Open the live demo
              </a>
              <a href="/docs" className="btn-ghost">
                Read the docs <span aria-hidden>↗</span>
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-line bg-black px-5 py-10 text-[13px] text-ink-faint sm:px-10 lg:px-16">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
          <span>
            <span className="font-semibold text-ink">hush.</span> · built for the Avalanche Speedrun · MIT
          </span>
          <span>eERC contracts © Ava Labs, Ecosystem License</span>
        </div>
      </footer>
    </>
  );
}

const FAQ: [string, string][] = [
  [
    "Who can see how much my agent pays?",
    "Nobody but you and, optionally, an auditor. Amounts and balances are eERC ciphertexts on C-Chain. The owner decrypts an agent's history with the agent's key; the contract-level auditor key decrypts every amount.",
  ],
  [
    "What does a public observer still see?",
    "The sender and receiver of each top-up (eERC hides amounts, not addresses), fixed-cadence Merkle roots, and public converter deposits. Not the calls, not their frequency, not the trades or positions. Few top-ups, fixed chunk sizes and timing jitter keep even that thin.",
  ],
  [
    "Why prepaid credit instead of an escrow contract?",
    "An eERC balance can only be spent by its BabyJubJub key holder through a zero-knowledge proof, so a contract can't hold and release one without changing eERC. Credit trades escrow for provider trust — bounded by signed receipts, on-chain roots the agent verifies, private refunds, 7-day expiry and public flags.",
  ],
  [
    "Can a provider lie about its track record?",
    "Not without getting caught. Signal providers commit a hash chain of every signed call to HushAlpha each epoch. A proof that hides a losing call, back-dates one or edits a price breaks at the first doctored epoch — and anyone can check it in a browser.",
  ],
  [
    "Isn't zero-knowledge too slow for per-request payments?",
    "Proofs take seconds, so Hush only proves the occasional top-up. Each request is an EIP-712 voucher checked in milliseconds; vouchers are batched into Merkle roots every two minutes.",
  ],
  [
    "Does it work with my agent?",
    "Hush is a drop-in x402 v2 scheme: createHushFetch for clients, hushMiddleware for servers. Any MCP host — Claude Desktop, Claude Code, Cursor — gets private payments and trading as tools through @hush/mcp.",
  ],
];

function SectionHead({ id, kicker, title, children }: { id: string; kicker: string; title: ReactNode; children: ReactNode }) {
  return (
    <div className="relative mx-auto max-w-3xl text-center">
      {/* centred copy sits over the busiest part of the 3D scene: a soft dark pool keeps it legible */}
      <div aria-hidden className="pointer-events-none absolute -inset-x-24 -inset-y-16 -z-10 bg-[radial-gradient(closest-side,rgba(0,0,0,0.88),rgba(0,0,0,0.55)_60%,transparent)]" />
      <p className="kicker">{kicker}</p>
      <h2 id={id} className={`mt-6 ${H2}`}>
        {title}
      </h2>
      <p className={`mx-auto max-w-2xl ${LEDE}`}>{children}</p>
    </div>
  );
}

function Viewer({ who, icon, children }: { who: string; icon: string; children: ReactNode }) {
  return (
    <li className="glass rounded-[22px] p-5">
      <div className="flex items-center gap-3">
        <GoldChip>{icon}</GoldChip>
        <p className="text-[16px] font-medium text-ink">{who} sees</p>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-ink-dim">{children}</p>
    </li>
  );
}

function GoldChip({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="grid size-10 shrink-0 place-items-center rounded-full bg-gradient-to-b from-gold-hi via-gold to-gold-deep text-[15px] text-black shadow-[0_0_24px_-6px_var(--gold),inset_0_1px_0_rgba(255,255,255,0.6)]"
    >
      {children}
    </span>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <li className="glass rounded-[26px] p-6">
      <GoldChip>{n}</GoldChip>
      <p className="mt-6 text-[19px] font-medium text-ink">{title}</p>
      <p className="mt-2 text-sm leading-relaxed text-ink-dim">{children}</p>
    </li>
  );
}

function FeatureCard({ icon, kicker, title, children }: { icon: string; kicker: string; title: string; children: ReactNode }) {
  return (
    <div className="glass rounded-[26px] p-6">
      <GoldChip>{icon}</GoldChip>
      <p className="mt-6 text-[12px] font-medium uppercase tracking-[0.08em] text-gold">{kicker}</p>
      <p className="mt-1 text-[21px] font-medium text-ink">{title}</p>
      <p className="mt-3 text-sm leading-relaxed text-ink-dim">{children}</p>
    </div>
  );
}

/** What Hush is built from — a factual list, not endorsements. */
function BuiltOn() {
  const items = ["Avalanche C-Chain", "eERC · encrypted ERC-20", "x402 v2", "Groth16 zk-SNARKs", "EIP-712", "Model Context Protocol"];
  return (
    <div className="mx-auto mt-24 max-w-6xl text-center">
      <p className="text-[15px] text-ink-dim">Built on</p>
      <ul className="mt-5 flex flex-wrap items-center justify-center gap-x-10 gap-y-3 text-[17px] font-medium text-ink/70">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[0.85em] text-ink">{children}</code>;
}

function Snippet({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure className="glass overflow-hidden rounded-[26px]">
      <figcaption className="border-b border-line px-6 py-3 text-[12px] font-medium text-ink-faint">{label}</figcaption>
      <pre className="overflow-x-auto px-6 py-5 font-mono text-[12px] leading-relaxed text-ink-dim">
        <code>{children}</code>
      </pre>
    </figure>
  );
}

const TOKEN = { kw: "text-seal", str: "text-gold", cm: "text-ink-faint", num: "text-leak" } as const;
function Ln({ c, children }: { c: keyof typeof TOKEN; children: ReactNode }) {
  return <span className={TOKEN[c]}>{children}</span>;
}

function Note({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-line-strong pt-5">
      <p className="text-[15px] font-medium text-ink">{title}</p>
      <p className="mt-2">{children}</p>
    </div>
  );
}
