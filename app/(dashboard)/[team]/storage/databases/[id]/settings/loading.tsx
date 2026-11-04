import { Settings2 } from "lucide-react";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { SettingsLoading } from "@/components/apps/settings/settings-loading";
import { DatabaseGeneralSettings } from "@/components/storage/database-general-settings";
import { DatabaseServerCard } from "@/components/shared/server-move-card";
import { PLACEHOLDER_DB, PLACEHOLDER_SERVERS } from "./placeholder-db";

export default function Loading() {
  return (
    <SettingsLoading className="space-y-4">
      <SettingsSection
        icon={Settings2}
        title="General"
        docs="databases.settings"
      />
      <DatabaseGeneralSettings db={PLACEHOLDER_DB} />
      <DatabaseServerCard
        db={PLACEHOLDER_DB}
        servers={PLACEHOLDER_SERVERS}
        disabled={false}
      />
    </SettingsLoading>
  );
}
