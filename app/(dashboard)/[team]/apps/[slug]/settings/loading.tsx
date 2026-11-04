import { Settings2 } from "lucide-react";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { SettingsLoading } from "@/components/apps/settings/settings-loading";
import { GeneralSettingsForm } from "@/components/apps/settings/general-settings-form";
import { CapabilityFieldset } from "@/components/apps/app-capabilities";
import { AppServerCard } from "@/components/shared/server-move-card";

const SERVERS = [
  { id: "a", name: "Server name", isDeploHost: false },
  { id: "b", name: "Other server", isDeploHost: false },
];

export default function Loading() {
  return (
    <SettingsLoading className="space-y-4">
      <SettingsSection icon={Settings2} title="General" docs="build.settings" />
      <CapabilityFieldset cap="configure_apps">
        <GeneralSettingsForm appId="" name="" logo="loading" detectable />
        <AppServerCard
          appId=""
          name=""
          serverId="a"
          servers={SERVERS}
          neighbours={[]}
        />
      </CapabilityFieldset>
    </SettingsLoading>
  );
}
