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

// DeploymentSettingsProps: everything the deployment settings page hands the form.
export type DeploymentSettingsProps = {
  appId: string;
  slug: string;
  build: BuildConfig;
  // The framework the LAST DEPLOY recognised. Not live: what settings shows is
  // what actually built the app, not a guess about the next build.
  framework: string | null;
  // The user's correction to that, or null to trust detection.
  frameworkOverride: string | null;
  autoDeploy: boolean;
  source: DeploySource;
  repo: GitRepo | null;
  dockerImage: string | null;
  upload: CurrentUpload | null;
  compose: string | null;
  serverId: string;
  servers: SettingsServer[];
  // Apps and databases this one reaches by name on its current server.
  neighbours: string[];
  installations: GithubInstallationDTO[];
  // The team's git connections (GitLab, Bitbucket, Gitea, plain git).
  connections: GitConnectionDTO[];
  // The connectable git hosts, so one is added from the picker itself.
  providers: GitProviderChoice[];
  // Gates the connect dialog's "on my own network" option.
  isInstanceAdmin: boolean;
  // Live push-webhook state for a connection-backed repo, or null when the
  // question doesn't apply (GitHub, a bare URL, auto-deploy off).
  webhook: GitWebhookStatus | null;
  // What the GitHub App behind this repo has not allowed. Null when there is no
  // App, or when GitHub could not be asked.
  repoAccess: { missing: AccessRequirement[]; settingsUrl: string } | null;
  // Why this repository will not clone, in the provider's own terms.
  cloneRefusal: string | null;
  // What a connection's token has to cover. Shown only once the provider has
  // actually refused something, since none of these hosts reports its scopes.
  connectionAccess: AccessRequirement[];
  // Only whoever can change the connection is sent to the provider to fix it.
  canManageGit: boolean;
};

// DeploymentSettings: the form's live state, derived flags and save actions.
export type DeploymentSettings = ReturnType<typeof useDeploymentSettings>;

// useDeploymentSettings: all deployment-settings state, dirt tracking and mutations.
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
  // The switch answers on the click and snaps back with the server's message if
  // it is refused - a switch that waits out a round trip reads as a broken one.
  const [autoDeploy, applyAutoDeploy] = useOptimisticValue(initialAutoDeploy);
  const [pending, startTransition] = React.useTransition();

  const [compose, setCompose] = React.useState(initialCompose ?? "");
  const [composeDiags, setComposeDiags] = React.useState<LintDiagnostic[]>([]);

  // Legacy template apps were stored as `docker-image` with a compose attached;
  // surface those on the Compose tab too. An upload project keeps its own tab
  // even if a stale compose lingers (usesComposeStack).
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
  // The Git source's whole value (credential + repo + branch), owned by
  // GitSourcePicker: a connection-backed repo has neither typed by hand.
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

  // Persisted with the repo via updateAppSource, so they share the Deploy
  // Source card's Save.
  const [gitOptions, setGitOptions] = React.useState<GitDeployOptionsValue>({
    triggerType: initialRepo?.triggerType ?? "push",
    watchPaths: (initialRepo?.watchPaths ?? []).join("\n"),
    submodules: initialRepo?.submodules ?? false,
  });

  const [ghSelection, setGhSelection] = React.useState<GithubSelection | null>(
    initialSource === "github" && initialRepo
      ? {
          // NOT `installations[0]`: an app whose installation column is NULL (imported, or
          // its App reinstalled) does not deploy through the team's first App, and seeding
          // one here claimed it did.
          installationId: initialRepo.installationId ?? "",
          fullName: initialRepo.repo,
          branch: initialRepo.branch,
        }
      : null,
  );

  // The "GitHub" source clones through a connected App (repo picker); plain
  // "Git" still takes a raw URL + branch.
  const usesGithubApp = source === "github";
  const usesGitUrl = source === "git";

  // The Build & Output card only applies to single-image builds: a compose stack
  // builds/pulls its own images and a prebuilt Docker image has nothing to build.
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

  // A repo the deploy trigger + root directory can actually attach to. Gates
  // both advanced panels so neither shows before there's a repo.
  const repoConfigVisible =
    usesGitUrl || (usesGithubApp && installations.length > 0);

  // Root Directory applies to source-bearing repo builds that materialise a tree.
  const rootCardVisible = buildCardVisible && repoConfigVisible;

  // Moving an app between servers copies its data, so the warning is a real
  // consequence and not a hint. Withheld while a GitHub app has no repo picked:
  // that save cannot go through anyway.
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
  // Deploy-on-push is real only when THIS APP has a credential: both webhook routes
  // find their candidate apps BY the credential id (`repo_installation_id` /
  // `repo_connection_id`), so an app with neither can never be delivered a push no
  const autoDeployPossible =
    (usesGithubApp &&
      Boolean(ghSelection?.installationId || initialRepo?.installationId)) ||
    (usesGitUrl && Boolean(gitConnection?.hasApi));
  const autoDeployBranch =
    (usesGithubApp ? ghSelection?.branch : gitValue.branch) ||
    initialRepo?.branch ||
    "main";

  // Each editable card keeps a snapshot of its last-saved value; it is "dirty"
  // when the live state diverges from that snapshot.
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
  // The GitHub repo picker reconciles the seeded selection to actually-available
  // values on mount - a stored branch deleted upstream falls back to the repo
  // default, and a reinstalled App re-keys the installation, then bubbles that
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
  // The GitHub repo picker owns its selection and re-derives it asynchronously on
  // mount - it bubbles `null` until its repo list loads, and stays `null` if the
  // saved repo can't be re-matched (App reinstalled, access revoked).
  const sourceDirty =
    source === "github" && !ghSelection
      ? false
      : currentSourceKey !== savedSourceKey;

  // The build config drives TWO cards, so its dirty tracking is split by facet:
  // each card's Unsaved-changes cue reflects only its own fields.
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
        // Saved by a second mutation, but from the same card and the same
        // button, so it counts as the same card's dirt.
        frameworkOverride,
      }),
    [build, frameworkOverride],
  );
  const currentRootKey = React.useMemo(
    () => JSON.stringify({ rootDirectory: build.rootDirectory }),
    [build.rootDirectory],
  );
  const [savedBuildKey, setSavedBuildKey] = React.useState(currentBuildKey);
  // Tracked on its own too, so saveBuild only spends the extra mutation when the
  // framework is what actually changed.
  const [savedFrameworkOverride, setSavedFrameworkOverride] = React.useState(
    initialFrameworkOverride,
  );
  const [savedRootKey, setSavedRootKey] = React.useState(currentRootKey);
  const buildDirty = currentBuildKey !== savedBuildKey;
  const rootDirty = currentRootKey !== savedRootKey;

  // The Deploy Source card now also hosts the Root Directory field, so its one
  // Save button lights up for either a source edit or a root-directory edit.
  const deploySourceCardDirty = sourceDirty || (rootCardVisible && rootDirty);

  // Only count the Build card's dirt toward the leave guard when its Save control is
  // actually on screen.
  const overallDirty =
    sourceDirty ||
    (buildCardVisible && buildDirty) ||
    (rootCardVisible && rootDirty);

  function saveSource() {
    // If only the root directory changed, persist just that - Root Directory
    // lives in this card, so the single Save commits it via its own mutation.
    if (!sourceDirty) {
      if (rootCardVisible && rootDirty) saveRootDir();
      return;
    }
    // The Upload source is committed by the upload control (its own route),
    // not by this form, and saving source=upload with no archive would break
    // the next deploy. Block it here so the button can't strand the app.
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
    // The git deploy options persist with whichever repo the active source produced.
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
    // Snapshot the exact config being committed so the button greys out on
    // success (the async closure captured this render's key).
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
      // Persist the root directory in the same round-trip when it also changed.
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

  // Uploading no longer auto-deploys (so the server can be changed first), so
  // this button is the one that actually builds + releases the uploaded code.
  function saveAndDeploy() {
    if (!initialUpload) {
      toast.error("Upload an archive above before deploying");
      return;
    }
    startTransition(async () => {
      // Commit a server change first - this moves the app and, for a previously-deployed
      // one, marks its data for migration.
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

  // updateAppBuild merges field-by-field, so each card sends ONLY its own fields -
  // saving one card never commits the other's pending edits.
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
    // The framework correction is a column on the app, not build config, so it
    // takes a second mutation. It goes FIRST: if it fails, nothing has been
    // half-saved and the card stays dirty in full.
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
