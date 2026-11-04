import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Bone } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/shared/page-header";
import { ContainerMonitoringSkeleton } from "@/components/monitoring/container-monitoring-skeleton";
import { HostChip } from "@/components/monitoring/host-chip";

export default function Loading() {
  return (
    <div className="space-y-5" aria-busy>
      <PageHeader
        level="section"
        docs="monitoring.overview"
        title="Monitoring"
        description="Real-time CPU, memory, network and disk I/O for this database's container."
        actions={
          <div className="flex items-center gap-2">
            <Bone box>
              <HostChip serverId="" serverName="eu-main-01" canManage />
            </Bone>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled
              aria-label="Resource limits"
            >
              <Settings className="size-4" />
            </Button>
          </div>
        }
      />
      <ContainerMonitoringSkeleton />
    </div>
  );
}
