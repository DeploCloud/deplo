import { DeploymentsTableSkeleton } from "@/components/apps/deployments-table/deployments-table";
import { DeploymentsHeader } from "./header";

export default function Loading() {
  return (
    <div className="space-y-6">
      <DeploymentsTableSkeleton
        header={<DeploymentsHeader />}
        showApp
        showServer
      />
    </div>
  );
}
