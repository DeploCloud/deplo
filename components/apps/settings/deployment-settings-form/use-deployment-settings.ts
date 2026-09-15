"use client";

import * as React from "react";
import { toast } from "sonner";
import { useRouter } from "@/lib/nav";
import {
  watchPathsToArray,
  type GitDeployOptionsValue,
} from "@/components/apps/git-deploy-options";
import type { GithubSelection } from "@/components/apps/github-repo-picker";
import type { GitSourceValue } from "@/components/apps/git-source-picker";
import type { CurrentUpload } from "@/components/apps/upload-input";
import type { SettingsServer } from "@/components/apps/settings/settings-shared";
import {
  hasBlockingErrors,
  type LintDiagnostic,
} from "@/lib/deploy/compose-lint/lint";
import type { GithubInstallationDTO } from "@/lib/data/github";
import type { AccessRequirement } from "@/lib/git/provider-access";
import type {
  GitConnectionDTO,
  GitWebhookStatus,
} from "@/lib/data/git-connections";
import type { DeploySource } from "@/lib/types/app";
import type { BuildConfig, GitRepo } from "@/lib/types/build";
import type { GitProviderChoice } from "@/lib/types/git";
import { deploySourceEnumName } from "@/lib/types/app";
import { usesComposeStack } from "@/lib/utils";
import { useOptimisticValue } from "@/components/shared/use-optimistic-value";
import { gqlAction } from "@/lib/graphql-client";
import { computeSourceKey } from "./source-key";

export type DeploymentSettingsProps = {
  appId: string;
  slug: string;
  build: BuildConfig;
  framework: string | null;
  frameworkOverride: string | null;
  autoDeploy: boolean;
  source: DeploySource;
  repo: GitRepo | null;
  dockerImage: string | null;
  upload: CurrentUpload | null;
  compose: string | null;
  serverId: string;
  servers: SettingsServer[];
  neighbours: string[];
  installations: GithubInstallationDTO[];
  connections: GitConnectionDTO[];
  providers: GitProviderChoice[];
  isInstanceAdmin: boolean;
  webhook: GitWebhookStatus | null;
  repoAccess: { missing: AccessRequirement[]; settingsUrl: string } | null;
  cloneRefusal: string | null;
  connectionAccess: AccessRequirement[];
  canManageGit: boolean;
};

export type DeploymentSettings = ReturnType<typeof useDeploymentSettings>;

export function useDeploymentSettings({
  appId,
  slug,
  build: initialBuild,
  autoDeploy: initialAutoDeploy,
  source: initialSource,
  repo: initialRepo,
  dockerImage: initialDockerImage,
  upload: initialUpload,
  compose: initialCompose,
  serverId: initialServerId,
  servers,
  installations,
  connections,
  frameworkOverride: initialFrameworkOverride,
}: DeploymentSettingsProps) {
  const router = useRouter();
  const [build, setBuild] = React.useState<BuildConfig>(initialBuild);
  const [frameworkOverride, setFrameworkOverride] = React.useState(
    initialFrameworkOverride,
  );
  const [autoDeploy, applyAutoDeploy] = useOptimisticValue(initialAutoDeploy);
  const [pending, startTransition] = React.useTransition();

  const [compose, setCompose] = React.useState(initialCompose ?? "");
  const [composeDiags, setComposeDiags] = React.useState<LintDiagnostic[]>([]);

  const [source, setSource] = React.useState<DeploySource>(
    usesComposeStack({
      source: initialSource,
      compose: initialCompose,
      repo: initialRepo,
      dockerImage: initialDockerImage,
    })
      ? "compose"
      : initialSource,
  );
  const [serverId, setServerId] = React.useState(initialServerId);
  const [gitValue, setGitValue] = React.useState<GitSourceValue>({
    provider: initialRepo?.provider ?? "git",
    url: initialRepo?.url ?? "",
    repo: initialRepo?.repo ?? "",
    branch: initialRepo?.branch ?? "main",
    connectionId: initialRepo?.connectionId ?? null,
  });
  const [dockerImage, setDockerImage] = React.useState(
    initialDockerImage ?? "",
  );

  const [gitOptions, setGitOptions] = React.useState<GitDeployOptionsValue>({
    triggerType: initialRepo?.triggerType ?? "push",
    watchPaths: (initialRepo?.watchPaths ?? []).join("\n"),
    submodules: initialRepo?.submodules ?? false,
  });

  const [ghSelection, setGhSelection] = React.useState<GithubSelection | null>(
    initialSource === "github" && initialRepo
      ? {
          installationId: initialRepo.installationId ?? "",
          fullName: initialRepo.repo,
          branch: initialRepo.branch,
        }
      : null,
  );

  const usesGithubApp = source === "github";
  const usesGitUrl = source === "git";

  const isComposeStack = usesComposeStack({
    source,
    compose,
    repo: usesGithubApp
      ? ghSelection
      : usesGitUrl && gitValue.url.trim()
        ? { url: gitValue.url }
        : null,
    dockerImage: dockerImage.trim() || null,
  });
  const buildCardVisible = !isComposeStack && source !== "docker-image";

  const repoConfigVisible =
    usesGitUrl || (usesGithubApp && installations.length > 0);

  const rootCardVisible = buildCardVisible && repoConfigVisible;

  const serverMoveWarned =
    serverId !== initialServerId && !(usesGithubApp && !ghSelection);
  const currentServerName =
    servers.find((s) => s.id === initialServerId)?.name ?? "its current server";

  const closedSummary = [
    servers.find((s) => s.id === serverId)?.name,
    rootCardVisible &&
    build.rootDirectory &&
    build.rootDirectory !== "./" &&
    build.rootDirectory !== "."
      ? `Root: ${build.rootDirectory}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const gitConnection =
    connections.find((c) => c.id === gitValue.connectionId) ?? null;
  const autoDeployPossible =
    (usesGithubApp &&
      Boolean(ghSelection?.installationId || initialRepo?.installationId)) ||
    (usesGitUrl && Boolean(gitConnection?.hasApi));
  const autoDeployBranch =
    (usesGithubApp ? ghSelection?.branch : gitValue.branch) ||
    initialRepo?.branch ||
    "main";

  const currentSourceKey = React.useMemo(
    () =>
      computeSourceKey({
        source,
        serverId,
        gitValue,
        dockerImage,
        ghSelection,
        compose,
        gitOptions,
      }),
    [source, serverId, gitValue, dockerImage, ghSelection, compose, gitOptions],
  );
  const [savedSourceKey, setSavedSourceKey] = React.useState(currentSourceKey);
  const ghBaselinedRef = React.useRef(
    !(initialSource === "github" && initialRepo),
  );
  React.useEffect(() => {
    if (ghBaselinedRef.current) return;
    if (source !== "github" || !ghSelection) return;
    ghBaselinedRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSavedSourceKey(currentSourceKey);
  }, [source, ghSelection, currentSourceKey]);
  const sourceDirty =
    source === "github" && !ghSelection
      ? false
      : currentSourceKey !== savedSourceKey;

  const currentBuildKey = React.useMemo(
    () =>
      JSON.stringify({
        buildMethod: build.buildMethod,
        methodSettings: build.methodSettings,
        installCommand: build.installCommand,
        buildCommand: build.buildCommand,
        outputDirectory: build.outputDirectory,
        startCommand: build.startCommand,
        runtimeVersion: build.runtimeVersion,
        port: build.port,
        frameworkOverride,
      }),
    [build, frameworkOverride],
  );
  const currentRootKey = React.useMemo(
    () => JSON.stringify({ rootDirectory: build.rootDirectory }),
    [build.rootDirectory],
  );
  const [savedBuildKey, setSavedBuildKey] = React.useState(currentBuildKey);
  const [savedFrameworkOverride, setSavedFrameworkOverride] = React.useState(
    initialFrameworkOverride,
  );
  const [savedRootKey, setSavedRootKey] = React.useState(currentRootKey);
  const buildDirty = currentBuildKey !== savedBuildKey;
  const rootDirty = currentRootKey !== savedRootKey;

  const deploySourceCardDirty = sourceDirty || (rootCardVisible && rootDirty);

  const overallDirty =
    sourceDirty ||
    (buildCardVisible && buildDirty) ||
    (rootCardVisible && rootDirty);

  function saveSource() {
    if (!sourceDirty) {
      if (rootCardVisible && rootDirty) saveRootDir();
      return;
    }
    if (source === "upload") {
      if (!initialUpload) {
        toast.error("Upload an archive above before saving");
        return;
      }
      toast.info("Your uploaded archive is already saved");
      return;
    }
    let repo: GitRepo | null = null;
    if (usesGithubApp) {
      if (!ghSelection) {
        toast.error("Select a repository to deploy");
        return;
      }
      repo = {
        provider: "github",
        url: `https://github.com/${ghSelection.fullName}`,
        repo: ghSelection.fullName,
        branch: ghSelection.branch || "main",
        installationId: ghSelection.installationId,
      };
    } else if (usesGitUrl) {
      if (!gitValue.url.trim()) {
        toast.error(
          gitConnection?.hasApi
            ? "Select a repository to deploy"
            : "Enter a repository URL",
        );
        return;
      }
      repo = {
        provider: gitValue.provider as GitRepo["provider"],
        url: gitValue.url,
        repo: gitValue.repo,
        branch: gitValue.branch || "main",
        connectionId: gitValue.connectionId,
      };
    }
    if (repo) {
      repo = {
        ...repo,
        triggerType: gitOptions.triggerType,
        watchPaths: watchPathsToArray(gitOptions.watchPaths),
        submodules: gitOptions.submodules,
      };
    }
    let image: string | null = null;
    if (source === "docker-image") {
      if (!dockerImage.trim()) {
        toast.error("Enter a Docker image reference");
        return;
      }
      image = dockerImage.trim();
    }
    if (source === "compose") {
      if (!compose.trim()) {
        toast.error("Compose file cannot be empty");
        return;
      }
      if (hasBlockingErrors(composeDiags)) {
        toast.error("Fix the compose errors before saving");
        return;
      }
    }
    const committedSourceKey = currentSourceKey;
    const committedRootKey = currentRootKey;
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $input: UpdateSourceInput!) { updateAppSource(id: $id, input: $input) { id } }`,
        {
          id: appId,
          input: {
            source: deploySourceEnumName(source),
            serverId,
            dockerImage: image,
            repo,
            compose: source === "compose" ? compose : undefined,
          },
        },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setSavedSourceKey(committedSourceKey);
      if (rootCardVisible && rootDirty) {
        const rootRes = await gqlAction(
          `mutation($id: String!, $build: BuildConfigInput!) { updateAppBuild(id: $id, build: $build) { id } }`,
          { id: appId, build: { rootDir: build.rootDirectory } },
        );
        if (!rootRes.ok) {
          toast.error(rootRes.error);
          return;
        }
        setSavedRootKey(committedRootKey);
      }
      router.refresh();
      toast.success("Deploy source saved");
    });
  }

  function saveAndDeploy() {
    if (!initialUpload) {
      toast.error("Upload an archive above before deploying");
      return;
    }
    startTransition(async () => {
      if (serverId !== initialServerId) {
        const moved = await gqlAction(
          `mutation($id: String!, $input: UpdateSourceInput!) { updateAppSource(id: $id, input: $input) { id } }`,
          {
            id: appId,
            input: { source: deploySourceEnumName("upload"), serverId },
          },
        );
        if (!moved.ok) {
          toast.error(moved.error);
          return;
        }
      }
      const res = await gqlAction(
        `mutation($appId: String!) { redeploy(appId: $appId) { id } }`,
        { appId },
        (d: { redeploy: { id: string } }) => d.redeploy,
      );
      if (res.ok && res.data) {
        toast.success("Deploying…");
        router.push(`/apps/${slug}/deployments/${res.data.id}`);
      } else if (!res.ok) {
        toast.error(res.error);
      }
    });
  }

  function persistBuildPatch(
    input: Record<string, unknown>,
    onSaved: () => void,
    successMessage: string,
  ) {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $build: BuildConfigInput!) { updateAppBuild(id: $id, build: $build) { id } }`,
        { id: appId, build: input },
      );
      if (res.ok) {
        onSaved();
        router.refresh();
        toast.success(successMessage);
      } else toast.error(res.error);
    });
  }

  function saveBuild() {
    const committed = currentBuildKey;
    startTransition(async () => {
      if (frameworkOverride !== savedFrameworkOverride) {
        const res = await gqlAction(
          `mutation($id: String!, $framework: String) { setAppFramework(id: $id, framework: $framework) { id } }`,
          { id: appId, framework: frameworkOverride },
        );
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        setSavedFrameworkOverride(frameworkOverride);
      }
      const res = await gqlAction(
        `mutation($id: String!, $build: BuildConfigInput!) { updateAppBuild(id: $id, build: $build) { id } }`,
        {
          id: appId,
          build: {
            buildMethod: build.buildMethod,
            settings: build.methodSettings,
            installCommand: build.installCommand,
            buildCommand: build.buildCommand,
            outputDir: build.outputDirectory,
            startCommand: build.startCommand,
            runtimeVersion: build.runtimeVersion,
            port: build.port,
          },
        },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setSavedBuildKey(committed);
      router.refresh();
      toast.success("Build settings saved");
    });
  }

  function saveRootDir() {
    const committed = currentRootKey;
    persistBuildPatch(
      { rootDir: build.rootDirectory },
      () => setSavedRootKey(committed),
      "Root directory saved",
    );
  }

  function toggleAuto(v: boolean) {
    applyAutoDeploy(v, () =>
      gqlAction(
        `mutation($id: String!, $value: Boolean!) { setAppAutoDeploy(id: $id, value: $value) { id } }`,
        { id: appId, value: v },
      ),
    );
  }

  return {
    build,
    setBuild,
    frameworkOverride,
    setFrameworkOverride,
    autoDeploy,
    toggleAuto,
    pending,
    compose,
    setCompose,
    composeDiags,
    setComposeDiags,
    source,
    setSource,
    serverId,
    setServerId,
    gitValue,
    setGitValue,
    dockerImage,
    setDockerImage,
    gitOptions,
    setGitOptions,
    ghSelection,
    setGhSelection,
    usesGithubApp,
    usesGitUrl,
    buildCardVisible,
    repoConfigVisible,
    rootCardVisible,
    serverMoveWarned,
    currentServerName,
    closedSummary,
    autoDeployPossible,
    autoDeployBranch,
    sourceDirty,
    buildDirty,
    deploySourceCardDirty,
    overallDirty,
    saveSource,
    saveAndDeploy,
    saveBuild,
  };
}
