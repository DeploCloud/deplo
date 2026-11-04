import { ShieldCheck } from "lucide-react";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { SettingsLoading } from "@/components/apps/settings/settings-loading";
import { BasicAuthManager } from "@/components/apps/basic-auth-manager";
import { PendingCreateProvider } from "@/components/shared/pending-create";
import { CapabilityFieldset } from "@/components/apps/app-capabilities";

export default function Loading() {
  return (
    <SettingsLoading className="space-y-4">
      <SettingsSection
        icon={ShieldCheck}
        title="Access"
        docs="domains.overview"
      />
      <CapabilityFieldset cap="manage_basic_auth">
        <PendingCreateProvider count={0}>
          <BasicAuthManager appId="" users={[]} />
        </PendingCreateProvider>
      </CapabilityFieldset>
    </SettingsLoading>
  );
}
