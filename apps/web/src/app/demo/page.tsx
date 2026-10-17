import { DemoView } from "@/components/demo/DemoView";
import { SiteHeader } from "@/components/site/SiteHeader";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Live demo",
  description: "Atlas (public x402) vs Veil (Hush) trading the same strategy, watched by Mirror, a copycat bot — live chain data.",
};

export default function DemoPage() {
  return (
    <div className="backdrop relative min-h-dvh">
      <SiteHeader />
      <main>
        <DemoView />
      </main>
    </div>
  );
}
