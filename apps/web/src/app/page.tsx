import { ModeToggle, VeilButton } from "@/components/landing/ModeToggle";
import { ObserverTerminal } from "@/components/landing/ObserverTerminal";
import { ProofPanel } from "@/components/landing/ProofPanel";
import { SceneRoot } from "@/components/landing/SceneRoot";
import { ScrollProgress } from "@/components/landing/ScrollProgress";
import { REPO_URL } from "@/lib/chain";
import type { ReactNode } from "react";

export default function Home() {
  return (
    <>
      <SceneRoot />
      <ScrollProgress />
      <Header />

      <main className="relative z-10">
        {/* ── 01 THE LEAK ─────────────────────────────────────────────────── */}
        <section id="leak" data-chapter="0" aria-labelledby="leak-title" className="relative min-h-[175vh]">
          <div className="sticky top-0 flex min-h-dvh flex-col justify-between gap-10 px-5 pb-10 pt-28 sm:px-10 lg:px-16">
            <div className="max-w-2xl">
              <p className="font-mono text-xs text-ink-dim">
                <span className="text-cyan">hush</span> — private x402 payments for AI agents, on Avalanche
              </p>
              <p className="kicker mt-8">01 — The leak</p>
              <h1 id="leak-title" className="mt-4 font-display text-[clamp(2.4rem,6.2vw,5.4rem)] font-semibold leading-[0.95] tracking-[-0.035em]">
                Every x402 payment is a <span className="text-pink">public receipt.</span>
              </h1>
              <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-ink-dim sm:text-base">
                Agents now pay per request — a cent for a price feed, a quarter for a model call. On a public chain each
                payment names the payer, the payee, the amount and the second it happened. Line them up and anyone can
                read what your agent is doing, and front-run what it does next.
              </p>
            </div>
            <div className="flex flex-col items-start gap-6 lg:flex-row lg:items-end lg:justify-between">
              <a href="#veil" className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint hover:text-ink">
                Scroll to drop the veil ↓
              </a>
              <div className="w-full max-w-[34rem]">
                <ObserverTerminal />
              </div>
            </div>
          </div>
        </section>

        {/* ── 02 THE VEIL ─────────────────────────────────────────────────── */}
        <section id="veil" data-chapter="1" aria-labelledby="veil-title" className="relative min-h-[175vh]">
          <div className="sticky top-0 flex min-h-dvh flex-col justify-between gap-10 px-5 pb-10 pt-28 sm:px-10 lg:px-16">
            <div className="max-w-xl">
              <p className="kicker">02 — The veil</p>
              <h2 id="veil-title" className="mt-4 font-display text-[clamp(2.1rem,5vw,4.4rem)] font-semibold leading-[0.98] tracking-[-0.03em]">
                Hush puts x402 <span className="text-cyan">behind eERC.</span>
              </h2>
              <p className="mt-6 text-[15px] leading-relaxed text-ink-dim sm:text-base">
                Payments move as encrypted ERC-20 on Avalanche C-Chain. Balances and amounts are ElGamal ciphertexts, and
                every transfer carries a Groth16 proof the chain verifies itself — no coprocessor, no second network.
              </p>
              <div className="mt-8">
                <VeilButton />
              </div>
            </div>
            <ul className="grid gap-3 sm:grid-cols-3 lg:max-w-4xl">
              <Viewer who="Public" tone="text-ink">
                Ciphertext, the sender and receiver of each top-up, and Merkle roots on a fixed clock.
              </Viewer>
              <Viewer who="Owner" tone="text-cyan">
                Every agent&apos;s full history, decrypted with the agent&apos;s eERC key.
              </Viewer>
              <Viewer who="Auditor" tone="text-violet">
                Every amount, through eERC&apos;s contract-level auditor key.
              </Viewer>
            </ul>
          </div>
        </section>

        {/* ── 03 HOW IT WORKS ─────────────────────────────────────────────── */}
        <section id="how" data-chapter="2" aria-labelledby="how-title" className="relative px-5 py-32 sm:px-10 lg:px-16">
          <div className="max-w-xl">
            <p className="kicker">03 — How it works · hush-credit</p>
            <h2 id="how-title" className="mt-4 font-display text-[clamp(2.1rem,5vw,4.4rem)] font-semibold leading-[0.98] tracking-[-0.03em]">
              One private top-up. <span className="text-violet">Hundreds of calls.</span>
            </h2>
            <p className="mt-6 text-[15px] leading-relaxed text-ink-dim sm:text-base">
              A private take on x402&apos;s <span className="text-ink">batch-settlement</span> scheme: prepay once in
              encrypted hUSDC, then pay each request with a signed voucher. The chain sees one ciphertext and a Merkle root
              every two minutes.
            </p>
          </div>

          <ol className="mt-16 max-w-xl space-y-4">
            <Step n="01" title="Fund">
              The owner wraps USDC into encrypted hUSDC (eERC converter mode) and privately funds each agent from a
              treasury.
            </Step>
            <Step n="02" title="Top up">
              The agent calls a paid API and gets <Code>HTTP 402</Code> with a <Code>hush-credit</Code> offer. It sends one
              private eERC transfer to the provider; the facilitator decrypts the amount with the provider&apos;s key and
              returns a signed <Code>CreditReceipt</Code>.
            </Step>
            <Step n="03" title="Call">
              Every request carries an EIP-712 voucher — cumulative spend, nonce, request hash, expiry — checked in
              milliseconds against the credit, the nonce and the owner&apos;s on-chain kill switch. No proof, no
              transaction.
            </Step>
            <Step n="04" title="Commit">
              Every two minutes, busy or idle, the facilitator commits a Merkle root of consumed vouchers to{" "}
              <Code>HushLedger</Code>. Agents verify their own vouchers are inside; unused credit is refunded privately.
            </Step>
          </ol>

          <div className="mt-16 grid max-w-5xl gap-4 lg:grid-cols-2">
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

          <div className="mt-16 grid max-w-5xl gap-4 text-sm leading-relaxed text-ink-dim md:grid-cols-3">
            <Note title="vs x402 batch-settlement">
              Same cumulative-voucher model, trustless escrow — but deposits, amounts and claims are public.
            </Note>
            <Note title="vs FHE approaches">
              x402z and Fhenix need an FHE coprocessor network. Hush uses client-side zk-SNARKs and ElGamal, verified on
              C-Chain.
            </Note>
            <Note title="The trade-off">
              Prepaid credit trusts the provider — bounded by signed receipts, on-chain roots, private refunds and public
              flags. A contract can&apos;t escrow an eERC balance without changing eERC.
            </Note>
          </div>
        </section>

        {/* ── 04 PROOF ────────────────────────────────────────────────────── */}
        <section id="proof" data-chapter="3" aria-labelledby="proof-title" className="relative px-5 pb-24 pt-32 sm:px-10 lg:px-16">
          <div className="mx-auto max-w-5xl">
            <p className="kicker">04 — Proof</p>
            <h2 id="proof-title" className="mt-4 font-display text-[clamp(2.1rem,5vw,4.4rem)] font-semibold leading-[0.98] tracking-[-0.03em]">
              Live on <span className="text-avax">Avalanche</span> Fuji.
            </h2>
            <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-ink-dim sm:text-base">
              Read from C-Chain right now — exactly the view any observer gets. Ciphertext and roots; no amounts, no call
              counts.
            </p>
            <div className="mt-12">
              <ProofPanel />
            </div>
            <div className="mt-12 flex flex-wrap items-center gap-4">
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="rounded-full bg-ink px-5 py-3 font-mono text-xs uppercase tracking-[0.18em] text-bg transition-colors hover:bg-cyan"
              >
                Read the source
              </a>
              <code className="glass rounded-full px-5 py-3 font-mono text-xs text-ink-dim">
                pnpm e2e <span className="text-ink-faint"># 13 checks against Fuji</span>
              </code>
            </div>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-line px-5 py-10 font-mono text-[11px] text-ink-faint sm:px-10 lg:px-16">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <span>Hush · built for the Avalanche Speedrun · MIT</span>
          <span>eERC contracts © Ava Labs, Ecosystem License</span>
        </div>
      </footer>
    </>
  );
}

function Header() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 flex items-center justify-between gap-4 bg-gradient-to-b from-bg via-bg/80 to-transparent px-5 pb-8 pt-4 sm:px-10 lg:px-16">
      <a href="#leak" className="flex items-center gap-2.5" aria-label="Hush — back to top">
        <Logo />
        <span className="font-display text-lg font-semibold tracking-tight">hush</span>
      </a>
      <nav aria-label="Chapters" className="hidden items-center gap-7 font-mono text-[11px] uppercase tracking-[0.2em] text-ink-dim md:flex">
        <a href="#veil" className="hover:text-ink">
          Veil
        </a>
        <a href="#how" className="hover:text-ink">
          How it works
        </a>
        <a href="#proof" className="hover:text-ink">
          Proof
        </a>
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="hover:text-ink">
          GitHub
        </a>
      </nav>
      <ModeToggle />
    </header>
  );
}

function Logo() {
  return (
    <svg viewBox="0 0 64 64" className="size-7" aria-hidden>
      <circle cx="32" cy="32" r="17" fill="none" stroke="var(--cyan)" strokeWidth="3.5" />
      <path d="M9 33.5h46" stroke="var(--violet)" strokeWidth="5" strokeLinecap="round" />
      <path d="M15 33.5h34" stroke="var(--bg)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function Viewer({ who, tone, children }: { who: string; tone: string; children: ReactNode }) {
  return (
    <li className="glass rounded-2xl p-5">
      <p className={`font-mono text-[11px] uppercase tracking-[0.2em] ${tone}`}>{who} sees</p>
      <p className="mt-2 text-sm leading-relaxed text-ink-dim">{children}</p>
    </li>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <li className="glass grid grid-cols-[2.5rem_1fr] gap-x-4 rounded-2xl p-5">
      <span className="font-mono text-xs text-violet">{n}</span>
      <div>
        <p className="font-display text-lg font-medium">{title}</p>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-dim">{children}</p>
      </div>
    </li>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[0.85em] text-ink">{children}</code>;
}

function Snippet({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure className="glass overflow-hidden rounded-2xl">
      <figcaption className="border-b border-line px-5 py-2.5 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
        {label}
      </figcaption>
      <pre className="overflow-x-auto px-5 py-4 font-mono text-[12px] leading-relaxed text-ink-dim">
        <code>{children}</code>
      </pre>
    </figure>
  );
}

const TOKEN = { kw: "text-violet", str: "text-cyan", cm: "text-ink-faint", num: "text-pink" } as const;
function Ln({ c, children }: { c: keyof typeof TOKEN; children: ReactNode }) {
  return <span className={TOKEN[c]}>{children}</span>;
}

function Note({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-line-strong pt-4">
      <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">{title}</p>
      <p className="mt-2">{children}</p>
    </div>
  );
}
