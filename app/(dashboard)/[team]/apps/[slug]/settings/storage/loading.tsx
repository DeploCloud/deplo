import { HardDrive } from "lucide-react";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { SettingsLoading } from "@/components/apps/settings/settings-loading";
import { StorageSettingsForm } from "@/components/apps/settings/storage-settings-form";
import { CapabilityFieldset } from "@/components/apps/app-capabilities";

export default function Loading() {
  return (
    <SettingsLoading className="space-y-4">
      <SettingsSection
        icon={HardDrive}
        title="Storage"
        docs="storage.overview"
      />
      <CapabilityFieldset cap="configure_apps">
        <StorageSettingsForm
          appId=""
          slug=""
          volumes={[]}
          composeMounts={[]}
          composeServices={[]}
          defaultComposeService={null}
          canMountHostVolumes
          canManageFiles={false}
          containerWorkdir="/app"
        />
      </CapabilityFieldset>
    </SettingsLoading>
  );
}
