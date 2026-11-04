import { AgentsHeader } from "@/components/settings/mcp/agents-header";
import { ConnectWizardSkeleton } from "@/components/settings/mcp/connect-wizard/wizard";
import { MyAgentsSkeleton } from "@/components/settings/mcp/my-agents";

export default function Loading() {
  return (
    <div className="space-y-6" aria-busy>
      <AgentsHeader actions={<MyAgentsSkeleton />} />
      <ConnectWizardSkeleton />
    </div>
  );
}
