import { GitPullRequest } from "lucide-react";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { SettingsLoading } from "@/components/apps/settings/settings-loading";
import { PreviewSettingsForm } from "@/components/apps/settings/preview-settings-form";
import { CapabilityFieldset } from "@/components/apps/app-capabilities";

// Only an app that deploys from GitHub links here, so that is the shape to draw.
export default function Loading() {
  return (
    <SettingsLoading className="space-y-4">
      <SettingsSection
        icon={GitPullRequest}
        title="Pull requests"
        docs="previews.overview"
        info="Give every open pull request its own deploy, on its own URL, torn down when the pull request closes."
      />
      <CapabilityFieldset cap="manage_previews">
        <PreviewSettingsForm
          appId=""
          branch="main"
          enabled={false}
          baseDomain={null}
          https
          maxActive={5}
          ttlDays={7}
          forkPolicy="approve"
          serverId={null}
          autoDeploy
          port={null}
          buildDrafts={false}
          comment
          requiredLabels={[]}
          appServerId=""
          appPort={3000}
          servers={[]}
          activeCount={0}
        />
      </CapabilityFieldset>
    </SettingsLoading>
  );
}
