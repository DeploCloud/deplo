import { Network } from "lucide-react";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { SettingsLoading } from "@/components/apps/settings/settings-loading";
import { DatabaseConnectionSettings } from "@/components/storage/database-connection-settings";
import { PLACEHOLDER_DB } from "../placeholder-db";

export default function Loading() {
  return (
    <SettingsLoading className="space-y-4">
      <SettingsSection
        icon={Network}
        title="Connection"
        docs="databases.connect"
        info="Public exposure and password rotation."
      />
      <DatabaseConnectionSettings
        db={PLACEHOLDER_DB}
        canExposePorts
        canConfigure
      />
    </SettingsLoading>
  );
}
