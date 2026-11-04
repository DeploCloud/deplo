import { Rocket } from "lucide-react";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { SettingsLoading } from "@/components/apps/settings/settings-loading";
import { DeploymentSettingsForm } from "@/components/apps/settings/deployment-settings-form/deployment-settings-form";
import { CapabilityFieldset } from "@/components/apps/app-capabilities";
import type { BuildConfig } from "@/lib/types/build";

// Drawn for an app deploying from a GitHub repository, the shape most apps have.
const BUILD: BuildConfig = {
  buildMethod: "railpack",
  methodAuto: true,
  methodSettings: {},
  rootDirectory: "",
  includeFilesOutsideRoot: false,
  skipUnchangedDeployments: false,
  buildCache: true,
  buildCacheClearPending: false,
  installCommand: null,
  buildCommand: null,
  outputDirectory: null,
  startCommand: null,
  runtimeVersion: "",
  port: 3000,
};
const INSTALLATION = {
  id: "loading",
  installationId: 0,
  appName: "Deplo",
  accountLogin: "account",
  accountType: "User" as const,
  avatarUrl: "",
};

export default function Loading() {
  return (
    <SettingsLoading className="space-y-4">
      <SettingsSection
        icon={Rocket}
        title="Deployment"
        docs="releases.autoDeploy"
      />
      <CapabilityFieldset cap="configure_apps">
        <DeploymentSettingsForm
          appId=""
          slug=""
          build={BUILD}
          lastBuiltWith="railpack"
          framework={null}
          frameworkOverride={null}
          autoDeploy
          source="github"
          repo={{
            provider: "github",
            url: "",
            repo: "account/repository",
            branch: "main",
            installationId: INSTALLATION.id,
          }}
          dockerImage={null}
          upload={null}
          compose={null}
          installations={[INSTALLATION]}
          connections={[]}
          providers={[]}
          isInstanceAdmin={false}
          webhook={null}
          repoAccess={null}
          cloneRefusal={null}
          connectionAccess={[]}
          canManageGit={false}
          rollbackKeep={3}
        />
      </CapabilityFieldset>
    </SettingsLoading>
  );
}
