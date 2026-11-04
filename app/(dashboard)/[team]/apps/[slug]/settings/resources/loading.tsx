import { Cpu } from "lucide-react";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { SettingsLoading } from "@/components/apps/settings/settings-loading";
import { ResourceLimitsForm } from "@/components/apps/settings/resource-limits-form/resource-limits-form";
import { CapabilityFieldset } from "@/components/apps/app-capabilities";

export default function Loading() {
  return (
    <SettingsLoading className="space-y-4">
      <SettingsSection
        icon={Cpu}
        title="Resources"
        docs="resources.overview"
        info="Cap how much RAM, CPU, disk and processes this app may use. Applied on the next deploy."
      />
      <CapabilityFieldset cap="configure_apps">
        <ResourceLimitsForm
          kind="app"
          id=""
          resources={null}
          host={{ name: "Server name", memoryMb: 8192, cpuCores: 4 }}
          usage={null}
          canRedeploy={false}
          canProtectFromOom={false}
        />
      </CapabilityFieldset>
    </SettingsLoading>
  );
}
