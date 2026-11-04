import { Cpu } from "lucide-react";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { SettingsLoading } from "@/components/apps/settings/settings-loading";
import { ResourceLimitsForm } from "@/components/apps/settings/resource-limits-form/resource-limits-form";

export default function Loading() {
  return (
    <SettingsLoading className="space-y-4">
      <SettingsSection
        icon={Cpu}
        title="Resources"
        docs="resources.overview"
        info="Cap how much RAM, CPU, disk and processes this database may use. Applied on the next redeploy."
      />
      <ResourceLimitsForm
        kind="database"
        id=""
        resources={null}
        host={{ name: "Server name", memoryMb: 8192, cpuCores: 4 }}
        usage={null}
        canRedeploy={false}
        canProtectFromOom={false}
      />
    </SettingsLoading>
  );
}
