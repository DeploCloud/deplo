import { PageHeader } from "@/components/shared/page-header";
import { BetaChip } from "@/components/shared/beta-chip";

export const AGENTS_DESCRIPTION =
  "Connect your AI agents to Deplo, with a connection only you control. It reaches every team that allows it.";

export function AgentsHeader({ actions }: { actions: React.ReactNode }) {
  return (
    <PageHeader
      docs="mcp.overview"
      title={
        <span className="flex items-center gap-2">
          AI agents
          <BetaChip />
        </span>
      }
      description={AGENTS_DESCRIPTION}
      actions={actions}
    />
  );
}
