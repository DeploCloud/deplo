import { RefreshCw, Plus } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { RefreshLabel } from "./check-status-button";

// The parts of the Servers page its loading state draws too.
export function ServersHeader({ actions }: { actions: React.ReactNode }) {
  return (
    <PageHeader
      docs="servers.overview"
      title={
        <span className="flex items-center gap-2">
          Servers
          <InfoTip
            content={
              <>
                Start with <strong>this host</strong>: add it (use its IP), then
                run the one-time install command it gives you on the box to
                install the agent. Add more Linux hosts the same way. The agent
                calls home and provisions itself - Deplo never needs SSH access
                to your servers.
              </>
            }
          />
        </span>
      }
      description="The servers your apps and databases run on."
      actions={actions}
    />
  );
}

export function ServersHeaderActionsSkeleton() {
  return (
    <>
      {/* The page re-checks every server as it opens, so it starts on Refreshing. */}
      <Button variant="outline" size="sm" disabled>
        <RefreshCw className="size-4 animate-spin" />
        <RefreshLabel sweeping />
      </Button>
      <Button size="sm" disabled>
        <Plus className="size-4" />
        Add
      </Button>
    </>
  );
}
