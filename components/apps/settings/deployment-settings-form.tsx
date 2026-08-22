"use client";

import * as React from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Save, GitBranch, Container, FileText, Upload, Server as ServerIcon, Rocket, ChevronDown } from "lucide-react";
import { GitHubIcon } from "@/components/shared/brand-icons";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ComposeEditor } from "@/components/apps/compose-editor";
import { ComposeLintSummary } from "@/components/apps/compose-lint-summary";
import { FullComposeDialog } from "@/components/apps/full-compose-dialog";
import { ImageInput } from "@/components/apps/image-input";
import {
  GithubRepoPicker,
  type GithubSelection,
} from "@/components/apps/github-repo-picker";
import {
  GitSourcePicker,
  type GitSourceValue,
} from "@/components/apps/git-source-picker";
import { UploadInput, type CurrentUpload } from "@/components/apps/upload-input";
import { UnsavedChangesGuard } from "@/components/apps/unsaved-changes-guard";
import { BuildOutputCard } from "@/components/apps/settings/build-output-card";
import { BuildCachePanel } from "@/components/apps/settings/build-cache-panel";
import { ComposeArgsPanel } from "@/components/apps/settings/compose-args-panel";
import {
  BuildServerPanel,
  type BuildServerChoice,
} from "@/components/apps/settings/build-server-panel";
import { DeployHookPanel } from "@/components/apps/settings/deploy-hook-panel";
import { RootDirectoryFields } from "@/components/apps/settings/root-directory-fields";
import {
  GitDeployOptions,
  watchPathsToArray,
  type GitDeployOptionsValue,
} from "@/components/apps/git-deploy-options";
import {
  DirtyHint,
  type SettingsServer,
} from "@/components/apps/settings/settings-shared";
import { CopyButton } from "@/components/shared/copy-button";
import { hasBlockingErrors, type LintDiagnostic } from "@/lib/deploy/compose-lint";
import type { GithubInstallationDTO } from "@/lib/data/github";
import type {
  GitConnectionDTO,
  GitWebhookStatus,
} from "@/lib/data/git-connections";
import type { BuildConfig, DeploySource, GitRepo } from "@/lib/types";
import { deploySourceEnumName } from "@/lib/types";
import { cn, serverLabel, usesComposeStack } from "@/lib/utils";
import { useOptimisticValue } from "@/components/shared/use-optimistic-value";
import { gqlAction } from "@/lib/graphql-client";

const SOURCE_TABS: {
  id: DeploySource;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: "github", label: "GitHub", icon: GitHubIcon },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "docker-image", label: "Docker Image", icon: Container },
  { id: "upload", label: "Upload", icon: Upload },
  { id: "compose", label: "Compose", icon: FileText },
];

type SourceKeyInput = {
  source: DeploySource;
  serverId: string;
  gitValue: GitSourceValue;
  dockerImage: string;
  ghSelection: GithubSelection | null;
  compose: string;
  gitOptions: GitDeployOptionsValue;
};

/** The git deploy options in canonical (whitespace-normalised) form, so a
 *  no-op whitespace edit in the watch-paths textarea never reads as "dirty". */
function normalizedGitOptions(o: GitDeployOptionsValue) {
  return {
    triggerType: o.triggerType,
    watchPaths: watchPathsToArray(o.watchPaths),
    submodules: o.submodules,
  };
}

/**
 * A canonical string for the Deploy Source card's committed configuration. Only
 * the fields the active source actually saves contribute, so switching source
 * kinds or typing in an inactive field never looks "dirty". Compared against the
 * snapshot taken at mount / last save to enable the Save button only on real
 * changes.
 */
function computeSourceKey(s: SourceKeyInput): string {
  const usesRepo = s.source === "git" || s.source === "github";
  return JSON.stringify({
    source: s.source,
    serverId: s.serverId,
    git:
      s.source === "git"
        ? {
            url: s.gitValue.url.trim(),
            branch: s.gitValue.branch || "main",
            connectionId: s.gitValue.connectionId,
          }
        : null,
    image: s.source === "docker-image" ? s.dockerImage.trim() : null,
    gh:
      s.source === "github" && s.ghSelection
        ? {
            inst: s.ghSelection.installationId,
            full: s.ghSelection.fullName,
            branch: s.ghSelection.branch || "main",
          }
        : null,
    compose: s.source === "compose" ? s.compose : null,
    // Git deploy options travel with the repo (github + git sources only).
    gitOptions: usesRepo ? normalizedGitOptions(s.gitOptions) : null,
  });
}

/**
 * Deployment settings: how the app is built, where it runs, and what makes it
 * deploy again. Three cards on one page because they all read the live `source`
 * state — Deploy Source, Build & Output (which owns deploy-on-push, since "run
 * all of this again on every push" is the last stage of the same pipeline), and
 * Advanced settings (the build cache, the app's own `compose up` flags, and —
 * for the sources a git provider does NOT already trigger — the deploy hook).
 */
export function DeploymentSettingsForm({
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
  webhook,
  framework,
  frameworkOverride: initialFrameworkOverride,
  deployHookEnabled,
  deployHookUrlMasked,
  composeUpArgs,
  buildServerId,
  buildFallbackLocal,
  buildServerChoices,
}: {
  appId: string;
  slug: string;
  build: BuildConfig;
  /**
   * The framework the LAST DEPLOY recognised in this app's source. Not live:
   * every deploy re-derives it, so what settings shows is what actually built
   * the app, not a guess about what the next build will find.
   */
  framework: string | null;
  /** The user's correction to that, or null to trust detection. Editable in the
   * build card and saved by its Save button. */
  frameworkOverride: string | null;
  autoDeploy: boolean;
  source: DeploySource;
  repo: GitRepo | null;
  dockerImage: string | null;
  upload: CurrentUpload | null;
  compose: string | null;
  serverId: string;
  servers: SettingsServer[];
  installations: GithubInstallationDTO[];
  /** The team's git connections (GitLab, Bitbucket, Gitea, plain git). */
  connections: GitConnectionDTO[];
  /** Live push-webhook state for a connection-backed repo, or null when the
   *  question doesn't apply (GitHub, a bare URL, auto-deploy off). */
  webhook: GitWebhookStatus | null;
  /** Whether the app's deploy hook answers at all (Advanced settings). */
  deployHookEnabled: boolean;
  /** The hook URL with its secret segment dotted out — resolved server-side so
   * the page can show the link's shape without the token reaching the browser.
   * NULL for an app that deploys from a git provider: its provider already
   * triggers it, so it has no deploy hook here and no link in the payload. */
  deployHookUrlMasked: string | null;
  /** Extra flags appended to this app's `docker compose up`, or null for the
   * untouched command (Advanced settings). */
  composeUpArgs: string | null;
  /** Which server BUILDS this app; null is Automatic (Advanced settings). */
  buildServerId: string | null;
  /** Build on this app's own server when the build server is unreachable. */
  buildFallbackLocal: boolean;
  /** The hosts this team may compile on, with their architectures. */
  buildServerChoices: BuildServerChoice[];
}) {
  const router = useRouter();
  const [build, setBuild] = React.useState<BuildConfig>(initialBuild);
  // The framework correction. Lives beside `build` rather than inside it: it is
  // a column on the app, not build config, so it saves through its own mutation —
  // but it belongs to the Build & Output card, so it shares that card's dirty
  // state and its one Save button.
  const [frameworkOverride, setFrameworkOverride] = React.useState(
    initialFrameworkOverride,
  );
  // The switch answers on the click and snaps back with the server's message if
  // it is refused — a switch that waits out a round trip reads as a broken one.
  const [autoDeploy, applyAutoDeploy] = useOptimisticValue(initialAutoDeploy);
  const [pending, startTransition] = React.useTransition();
  // The git deploy-trigger options are advanced and rarely changed, so the whole
  // section is collapsed by default (a summary of the active trigger shows in the
  // closed header).
  const [triggerOpen, setTriggerOpen] = React.useState(false);
  // The Root Directory now lives in a second collapsed "Additional options" panel
  // of the Deploy Source card (advanced, rarely changed for a single-folder repo).
  const [advancedOpen, setAdvancedOpen] = React.useState(false);

  // Compose stack (template / multi-service deploys). Lives as a source tab.
  const [compose, setCompose] = React.useState(initialCompose ?? "");
  const [composeDiags, setComposeDiags] = React.useState<LintDiagnostic[]>([]);

  // Source state. Legacy template apps were stored as `docker-image` with a
  // compose attached; surface those on the Compose tab by default too. An upload
  // project keeps its own tab even if a stale compose lingers (usesComposeStack).
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
  // GitSourcePicker: one state instead of a URL field and a branch field,
  // because a connection-backed repo has neither typed by hand.
  const [gitValue, setGitValue] = React.useState<GitSourceValue>({
    provider: initialRepo?.provider ?? "git",
    url: initialRepo?.url ?? "",
    repo: initialRepo?.repo ?? "",
    branch: initialRepo?.branch ?? "main",
    connectionId: initialRepo?.connectionId ?? null,
  });
  const [dockerImage, setDockerImage] = React.useState(initialDockerImage ?? "");

  // Git deploy options (trigger type, watch paths, submodules) — persisted with
  // the repo via updateAppSource, so they share the Deploy Source card's Save.
  const [gitOptions, setGitOptions] = React.useState<GitDeployOptionsValue>({
    triggerType: initialRepo?.triggerType ?? "push",
    watchPaths: (initialRepo?.watchPaths ?? []).join("\n"),
    submodules: initialRepo?.submodules ?? false,
  });

  // GitHub App repo picker selection. Seeded from the existing project repo so
  // a save that doesn't touch the picker keeps the current repo + branch.
  const [ghSelection, setGhSelection] = React.useState<GithubSelection | null>(
    initialSource === "github" && initialRepo
      ? {
          // NOT `installations[0]`: an app whose installation column is NULL
          // (imported, or its App reinstalled) does not deploy through the
          // team's first App, and seeding one here claimed it did. The picker
          // reports the empty string back as "not connected".
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
  // Derived once so the card's render gate and the dirty aggregation below stay
  // in lockstep (a build edit can't count as "unsaved" once the card is hidden).
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

  // A repo the deploy trigger + root directory can actually attach to: a plain
  // Git URL, or a GitHub source once at least one App is connected (so a repo can
  // be picked). Gates both advanced panels so neither shows before there's a repo.
  const repoConfigVisible =
    usesGitUrl || (usesGithubApp && installations.length > 0);

  // Root Directory applies to source-bearing repo builds (git / GitHub) that
  // materialise a tree: a compose stack builds its own images and a prebuilt
  // Docker image has no tree to root into. (Upload also has a tree but isn't
  // push-driven, so the skip-unchanged toggle would be inert — scope it to the
  // repo sources where all three controls fully apply.)
  const rootCardVisible = buildCardVisible && repoConfigVisible;

  // Deploy-on-push is real wherever a provider delivers pushes to Deplo: the
  // GitHub App, or a git connection whose provider has an API to register a
  // webhook with. A bare Repository URL has no sender, so it keeps triggering
  // deploys with the deploy hook in Advanced settings.
  const gitConnection =
    connections.find((c) => c.id === gitValue.connectionId) ?? null;
  // Deploy-on-push is real only when THIS APP has a credential: both webhook
  // routes find their candidate apps BY the credential id
  // (`repo_installation_id` / `repo_connection_id`), so an app with neither can
  // never be delivered a push no matter how many Apps the team has connected.
  // Asking `installations.length > 0` asked about the TEAM and offered the
  // switch on apps whose pushes go nowhere. The `initialRepo` fallback keeps a
  // healthy app's switch steady while the picker's repo list loads.
  const autoDeployPossible =
    (usesGithubApp &&
      Boolean(ghSelection?.installationId || initialRepo?.installationId)) ||
    (usesGitUrl && Boolean(gitConnection?.hasApi));
  const autoDeployBranch =
    (usesGithubApp ? ghSelection?.branch : gitValue.branch) ||
    initialRepo?.branch ||
    "main";

  // ── Per-section dirty tracking ──────────────────────────────────────────────
  // Each editable card keeps a snapshot of its last-saved value; it is "dirty"
  // when the live state diverges from that snapshot. Snapshots start at the
  // mounted props and advance only on a successful save, so the Save button greys
  // out the instant a save lands and lights up again on the next edit — without a
  // server round-trip to re-seed props. (The auto-deploy switch saves on change.)
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
  // values on mount — a stored branch deleted upstream falls back to the repo
  // default, and a reinstalled App re-keys the installation — then bubbles that
  // reconciled selection with NO user action. It diverges from the raw
  // initialRepo the snapshot was seeded from, which would otherwise read as an
  // "unsaved" edit and arm the leave guard, popping a spurious "discard changes?"
  // prompt on the very first navigation or reload. Adopt the picker's first
  // reconciled selection as the saved baseline instead; a later pick still
  // diverges and reads as dirty. (Sources with nothing to reconcile — non-github,
  // or github with no seeded repo — start baselined, so their first bubble is a
  // real user action.)
  const ghBaselinedRef = React.useRef(!(initialSource === "github" && initialRepo));
  React.useEffect(() => {
    if (ghBaselinedRef.current) return;
    if (source !== "github" || !ghSelection) return;
    ghBaselinedRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSavedSourceKey(currentSourceKey);
  }, [source, ghSelection, currentSourceKey]);
  // The GitHub repo picker owns its selection and re-derives it asynchronously on
  // mount — it bubbles `null` until its repo list loads, and stays `null` if the
  // saved repo can't be re-matched (App reinstalled, access revoked). Treat a null
  // GitHub selection as "not chosen yet", not as an edit: otherwise the Deploy
  // Source card would flash "unsaved changes" on every load and arm the leave
  // guard with no real change. Picking a different repo makes ghSelection non-null
  // and diverge from the snapshot, which still reads as dirty.
  const sourceDirty =
    source === "github" && !ghSelection
      ? false
      : currentSourceKey !== savedSourceKey;

  // The build config drives TWO cards (Build & Output, Root Directory), so its
  // dirty tracking is split by facet: each card's Unsaved-changes cue reflects
  // only its own fields. Both cards persist the WHOLE build via updateAppBuild,
  // so a save from either advances BOTH snapshots (see saveBuild).
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
        // button — so it counts as the same card's dirt.
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

  // Only count the Build card's dirt toward the leave guard when its Save control
  // is actually on screen. The card unmounts for compose/docker-image sources —
  // without this gate an edit made before switching source could strand the guard
  // true with no visible button to clear it. The flag isn't lost: switching the
  // source back re-exposes the control and re-counts it.
  const overallDirty =
    sourceDirty ||
    (buildCardVisible && buildDirty) ||
    (rootCardVisible && rootDirty);

  function saveSource() {
    // If only the root directory changed (the deploy source itself is untouched),
    // persist just that — Root Directory moved into this card, so the single Save
    // button commits it too, via its own build mutation.
    if (!sourceDirty) {
      if (rootCardVisible && rootDirty) saveRootDir();
      return;
    }
    // The Upload source is committed by the upload control (its own route),
    // not by this form — and saving source=upload with no archive would break
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
    // Attach the git deploy options (trigger type / watch paths / submodules) to
    // whichever repo the active source produced — they persist with the repo.
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
      // Persist the root directory in the same round-trip when it also changed —
      // it lives in this card now, so the single Save commits both facets.
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

  // Upload source: persist any server change, then deploy the stored archive.
  // Uploading no longer auto-deploys (so the server can be changed first), so
  // this button is the one that actually builds + releases the uploaded code.
  function saveAndDeploy() {
    if (!initialUpload) {
      toast.error("Upload an archive above before deploying");
      return;
    }
    startTransition(async () => {
      // Commit a server change first — this moves the app and, for a
      // previously-deployed one, marks its data for migration. updateAppSource
      // intentionally does NOT auto-deploy for the upload source, so the redeploy
      // below is the single deploy that runs and it consumes that migration marker.
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

  // Persist a PARTIAL build config. updateAppBuild merges field-by-field, so
  // each card sends ONLY its own fields — saving one card never commits the
  // other's pending edits (its dirty cue stays put). `onSaved` advances just that
  // card's snapshot. NOTE: `settings` (methodSettings) fully REPLACES its row when
  // present, so only the Build & Output card — which owns it — sends it.
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

  return (
    <>
      <div className="space-y-6">
        {/* Deploy source */}
        <Card>
          <CardHeader>
            <CardTitle className="flex w-fit items-center gap-2 text-base">
              Deploy Source
              <InfoTip content="Change how this app is deployed and which server runs it." />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Segmented control (app Tabs primitive, no panels — the
                conditional inputs below render off the `source` state). */}
            <Tabs value={source} onValueChange={(v) => setSource(v as DeploySource)}>
              <TabsList className="h-auto flex-wrap justify-start gap-1">
                {SOURCE_TABS.map((tab) => {
                  const Icon = tab.icon;
                  return (
                    <TabsTrigger key={tab.id} value={tab.id} className="gap-1.5">
                      <Icon className="size-4" />
                      {tab.label}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </Tabs>

            {usesGithubApp && (
              // Always render the picker — it owns the account switcher (with a
              // Manage-connected-apps affordance) and its own connect empty state,
              // so the layout stays put whether or not an App is connected yet.
              <GithubRepoPicker
                installations={installations}
                manageHref="/settings/git"
                initial={
                  initialSource === "github" && initialRepo
                    ? {
                        installationId: initialRepo.installationId,
                        fullName: initialRepo.repo,
                        branch: initialRepo.branch,
                      }
                    : undefined
                }
                onChange={setGhSelection}
              />
            )}

            {usesGitUrl && (
              <GitSourcePicker
                connections={connections}
                initial={
                  initialSource === "git" && initialRepo
                    ? {
                        connectionId: initialRepo.connectionId,
                        url: initialRepo.url,
                        repo: initialRepo.repo,
                        branch: initialRepo.branch,
                      }
                    : undefined
                }
                onChange={setGitValue}
              />
            )}

            {/* The one case auto-registration cannot cover: a token without the
                webhook scope. Rather than leaving auto-deploy quietly dead, show
                the address to paste and the provider's own reason. */}
            {usesGitUrl && webhook?.applicable && !webhook.installed && (
              <div className="rounded-md border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3">
                <p className="text-xs font-medium">
                  Deplo could not add the push webhook
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {webhook.error ||
                    "Add it in your repository's webhook settings so a push deploys."}
                </p>
                {webhook.url && (
                  <div className="mt-2 flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
                    <code className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed">
                      {webhook.url}
                    </code>
                    <CopyButton
                      value={webhook.url}
                      className="shrink-0"
                      label="Copy webhook URL"
                    />
                  </div>
                )}
              </div>
            )}

            {/* Git deploy options (trigger type, watch paths, submodules) — for
                the GitHub App repo picker (once connected) and the plain Git URL.
                Collapsed by default; the closed header summarises the active
                trigger so the setting is legible without expanding. */}
            {repoConfigVisible && (
              <div className="rounded-lg border border-border">
                <button
                  type="button"
                  onClick={() => setTriggerOpen((v) => !v)}
                  aria-expanded={triggerOpen}
                  className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-4 py-3 text-left text-sm transition-colors hover:bg-accent/40"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="font-medium">Deploy trigger</span>
                    {!triggerOpen && (
                      <span className="truncate text-xs text-muted-foreground">
                        {gitOptions.triggerType === "tag"
                          ? "On new tag"
                          : "On push to branch"}
                        {watchPathsToArray(gitOptions.watchPaths).length > 0 &&
                          " · path-filtered"}
                        {gitOptions.submodules && " · submodules"}
                      </span>
                    )}
                  </span>
                  <ChevronDown
                    className={cn(
                      "size-4 shrink-0 text-muted-foreground transition-transform",
                      triggerOpen && "rotate-180",
                    )}
                  />
                </button>
                {triggerOpen && (
                  <div className="border-t border-border p-4">
                    <GitDeployOptions
                      value={gitOptions}
                      onChange={setGitOptions}
                      disabled={pending}
                    />
                  </div>
                )}
              </div>
            )}

            {/* Additional options (Root Directory) — advanced, rarely changed for
                a single-folder repo, so collapsed by default with the current root
                shown in the closed header. Repo sources only (git / GitHub); a
                compose stack or prebuilt image has no tree to root into. Saved by
                this card's Save button alongside the source. */}
            {rootCardVisible && (
              <div className="rounded-lg border border-border">
                <button
                  type="button"
                  onClick={() => setAdvancedOpen((v) => !v)}
                  aria-expanded={advancedOpen}
                  className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-4 py-3 text-left text-sm transition-colors hover:bg-accent/40"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="font-medium">Additional options</span>
                    {!advancedOpen && (
                      <span className="truncate text-xs text-muted-foreground">
                        {build.rootDirectory &&
                        build.rootDirectory !== "./" &&
                        build.rootDirectory !== "."
                          ? `Root: ${build.rootDirectory}`
                          : "Root directory"}
                      </span>
                    )}
                  </span>
                  <ChevronDown
                    className={cn(
                      "size-4 shrink-0 text-muted-foreground transition-transform",
                      advancedOpen && "rotate-180",
                    )}
                  />
                </button>
                {advancedOpen && (
                  <div className="border-t border-border p-4">
                    <RootDirectoryFields
                      build={build}
                      onBuildChange={setBuild}
                      disabled={pending}
                    />
                  </div>
                )}
              </div>
            )}

            {source === "docker-image" && (
              <div className="space-y-2">
                <FieldLabel
                  info={
                    <>
                      Start typing to search registries; add{" "}
                      <code className="font-mono">:</code> to pick a tag. A green
                      check confirms the image exists.
                    </>
                  }
                >
                  Docker image
                </FieldLabel>
                <ImageInput value={dockerImage} onChange={setDockerImage} />
              </div>
            )}

            {source === "upload" && (
              <UploadInput appId={appId} current={initialUpload} />
            )}

            {source === "compose" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <FieldLabel
                    className="flex items-center gap-1.5"
                    info="The Compose file defining this stack's services. Deplo builds or pulls each service's image and deploys them together."
                  >
                    <FileText className="size-3.5" />
                    docker-compose.yml
                  </FieldLabel>
                  <FullComposeDialog appId={appId} />
                </div>
                <ComposeEditor
                  value={compose}
                  onChange={setCompose}
                  onDiagnostics={setComposeDiags}
                  minHeight={340}
                />
                <ComposeLintSummary diagnostics={composeDiags} />
              </div>
            )}

            <div className="max-w-md space-y-2">
              <FieldLabel
                className="flex items-center gap-1.5"
                info="The server (host machine) that builds and runs this app."
              >
                <ServerIcon className="size-3.5" />
                Server
              </FieldLabel>
              <Select value={serverId} onValueChange={setServerId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {servers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      <span className="flex items-center gap-2">
                        <ServerIcon className="size-4 text-muted-foreground" />
                        {serverLabel(s)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {serverId !== initialServerId && !(usesGithubApp && !ghSelection) && (
                <p className="text-xs text-muted-foreground">
                  Saving redeploys this app on the new server and copies its data
                  (volumes and files) across. It&apos;s briefly offline during the
                  copy; if the copy fails the old server is left intact.
                </p>
              )}
            </div>
          </CardContent>
          <CardFooter className="justify-between border-t border-border pt-4">
            {source === "upload" ? (
              <>
                <DirtyHint dirty={sourceDirty} />
                <Button
                  size="sm"
                  onClick={saveAndDeploy}
                  disabled={pending || !initialUpload}
                >
                  <Rocket className="size-4" />
                  Save &amp; Deploy
                </Button>
              </>
            ) : (
              <>
                <DirtyHint dirty={deploySourceCardDirty} />
                <Button
                  size="sm"
                  onClick={saveSource}
                  disabled={pending || !deploySourceCardDirty}
                >
                  <Save className="size-4" />
                  Save source
                </Button>
              </>
            )}
          </CardFooter>
        </Card>

        {/* Build & Output — single-image builds only. A compose stack builds/pulls
            its own images per its YAML, and a Docker image is pulled prebuilt, so
            neither has install/build/run settings to configure. Gated off the live
            form state so flipping the source tab shows/hides the card immediately. */}
        {buildCardVisible && (
          <BuildOutputCard
            build={build}
            onBuildChange={setBuild}
            framework={frameworkOverride ?? framework}
            detectedFramework={framework}
            onFrameworkChange={setFrameworkOverride}
            autoDeploy={autoDeploy}
            onAutoDeployChange={toggleAuto}
            autoDeployBranch={autoDeployBranch}
            showAutoDeploy={autoDeployPossible}
            dirty={buildDirty}
            pending={pending}
            onSave={saveBuild}
          />
        )}

        {/* Advanced settings — the deploy controls that are nobody's first-run
            business: the build cache, and the hook that lets something outside
            deplo trigger a deployment. */}
        <Card>
          <CardHeader>
            <CardTitle className="flex w-fit items-center gap-2 text-base">
              Advanced settings
              <InfoTip content="Rarely-changed controls: how builds reuse their cache, and how a deployment can be triggered from outside Deplo." />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* The build cache is a single-image build concern, so it follows the
                same gate as the Build card. Saves on change — a switch that needs
                a separate Save is how people think a setting stuck when it didn't. */}
            {buildCardVisible && (
              <BuildCachePanel
                appId={appId}
                buildCache={build.buildCache}
                clearPending={build.buildCacheClearPending}
                // Mirror the committed value back into the build state. Neither
                // field is part of currentBuildKey, so this can never light up
                // "unsaved changes" for something already saved.
                onChange={(next) =>
                  setBuild((b) => ({
                    ...b,
                    buildCache: next.buildCache,
                    buildCacheClearPending: next.clearPending,
                  }))
                }
              />
            )}
            {/* Same gate as the build cache above: only an app Deplo BUILDS can
                build somewhere else. A compose stack has no single image to move,
                and a prebuilt image is not built at all. */}
            {buildCardVisible && (
              <BuildServerPanel
                appId={appId}
                serverId={serverId}
                serverName={
                  servers.find((s) => s.id === serverId)?.name ?? "its own server"
                }
                serverArch={
                  buildServerChoices.find((c) => c.id === serverId)?.hostArch ?? ""
                }
                buildServerId={buildServerId}
                buildFallbackLocal={buildFallbackLocal}
                choices={buildServerChoices}
              />
            )}
            <ComposeArgsPanel
              appId={appId}
              slug={slug}
              value={composeUpArgs}
              usesEnvFile={isComposeStack}
            />
            {/* No hook for an app a git provider already triggers: the page
                sends no URL for those (a second trigger beside the provider's
                own is one more credential to leak for a job already done). */}
            {deployHookUrlMasked && (
              <DeployHookPanel
                appId={appId}
                enabled={deployHookEnabled}
                maskedUrl={deployHookUrlMasked}
              />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Warn before leaving with unsaved source/build edits (auto-deploy saves
          on change, so it doesn't count toward this). */}
      <UnsavedChangesGuard when={overallDirty} />
    </>
  );
}
