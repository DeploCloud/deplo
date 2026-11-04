import {
  DeploSettingsHeader,
  DeploSettingsPanelSkeleton,
} from "@/components/settings/deplo-settings-panel/settings-tabs";
import { DEPLO_VERSION } from "@/lib/version";

export default function Loading() {
  return (
    <div className="space-y-3" aria-busy>
      <DeploSettingsHeader version={DEPLO_VERSION} />
      <DeploSettingsPanelSkeleton />
    </div>
  );
}
