import { ProviderConsole } from "@/components/console/ProviderConsole";
import { SiteHeader } from "@/components/site/SiteHeader";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Provider console",
  description: "A Hush provider's private view (decrypted top-ups, credit, batches) and Proof of Alpha verified in the browser.",
};

export default function ProviderConsolePage() {
  return (
    <div className="backdrop relative min-h-dvh">
      <SiteHeader />
      <main>
        <ProviderConsole />
      </main>
    </div>
  );
}
