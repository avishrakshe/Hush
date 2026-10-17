import { AgentConsole } from "@/components/console/AgentConsole";
import { SiteHeader } from "@/components/site/SiteHeader";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Agent console",
  description: "The owner's and auditor's view of a Hush agent: sealed log, credit, vouchers, trade report, kill switch, eERC audit export.",
};

export default function AgentConsolePage() {
  return (
    <div className="backdrop relative min-h-dvh">
      <SiteHeader />
      <main>
        <AgentConsole />
      </main>
    </div>
  );
}
