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
import { Input } from "@/components/ui/input";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ComposeEditor } from "@/components/services/compose-editor";
import { ComposeLintSummary } from "@/components/services/compose-lint-summary";
import { FullComposeDialog } from "@/components/services/full-compose-dialog";
import { ImageInput } from "@/components/services/image-input";
import {
  GithubRepoPicker,
  type GithubSelection,
} from "@/components/services/github-repo-picker";
import { UploadInput, type CurrentUpload } from "@/components/services/upload-input";
import { UnsavedChangesGuard } from "@/components/services/unsaved-changes-guard";
import { BuildConfigFields } from "@/components/services/build-config-fields";
import { RootDirectoryFields } from "@/components/services/settings/root-directory-fields";
import {
  GitDeployOptions,
  watchPathsToArray,
  type GitDeployOptionsValue,
} from "@/components/services/git-deploy-options";
import {
  DirtyHint,
  type SettingsServer,
} from "@/components/services/settings/settings-shared";
import { hasBlockingErrors, type LintDiagnostic } from "@/lib/deploy/compose-lint";
import type { GithubInstallationDTO } from "@/lib/data/github";
import type { BuildConfig, DeploySource, GitRepo } from "@/lib/types";
import { deploySourceEnumName } from "@/lib/types";
import { cn, serverLabel, usesComposeStack } from "@/lib/utils";
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
  repoUrl: string;
  branch: string;
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
    git: s.source === "git" ? { url: s.repoUrl.trim(), branch: s.branch || "main" } : null,
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
 * Deployment settings: how the service is built, where it runs, and whether
 * pushes redeploy it. Bundles the Deploy Source, Build & Output and Automatic
 * deployments cards — they share the live `source` state (a compose stack or a
 * prebuilt image hides the build card), so they must live on one page.
 */
export function DeploymentSettingsForm({
  serviceId,
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
}: {
  serviceId: string;
  slug: string;
  build: BuildConfig;
  autoDeploy: boolean;
  source: DeploySource;
  repo: GitRepo | null;
  dockerImage: string | null;
  upload: CurrentUpload | null;
  compose: string | null;
  serverId: string;
  servers: SettingsServer[];
  installations: GithubInstallationDTO[];
}) {
  const router = useRouter();
  const [build, setBuild] = React.useState<BuildConfig>(initialBuild);
  const [autoDeploy, setAutoDeploy] = React.useState(initialAutoDeploy);
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

  // Source state. Legacy template services were stored as `docker-image` with a
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
  const [repoUrl, setRepoUrl] = React.useState(initialRepo?.url ?? "");
  const [branch, setBranch] = React.useState(initialRepo?.branch ?? "main");
  const [dockerImage, setDockerImage] = React.useState(initialDockerImage ?? "");

  // Git deploy options (trigger type, watch paths, submodules) — persisted with
  // the repo via updateServiceSource, so they share the Deploy Source card's Save.
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
          installationId: initialRepo.installationId ?? installations[0]?.id ?? "",
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
    repo: usesGithubApp ? ghSelection : usesGitUrl && repoUrl.trim() ? { url: repoUrl } : null,
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
        repoUrl,
        branch,
        dockerImage,
        ghSelection,
        compose,
        gitOptions,
      }),
    [source, serverId, repoUrl, branch, dockerImage, ghSelection, compose, gitOptions],
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
  // only its own fields. Both cards persist the WHOLE build via updateServiceBuild,
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
      }),
    [build],
  );
  const currentRootKey = React.useMemo(
    () => JSON.stringify({ rootDirectory: build.rootDirectory }),
    [build.rootDirectory],
  );
  const [savedBuildKey, setSavedBuildKey] = React.useState(currentBuildKey);
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
    // the next deploy. Block it here so the button can't strand the service.
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
      if (!repoUrl.trim()) {
        toast.error("Enter a repository URL");
        return;
      }
      const provider: GitRepo["provider"] = /gitlab/i.test(repoUrl)
        ? "gitlab"
        : /bitbucket/i.test(repoUrl)
        ? "bitbucket"
        : /github/i.test(repoUrl)
        ? "github"
        : "git";
      const repoName =
        repoUrl
          .replace(/\.git$/, "")
          .match(/[/:]([\w.-]+\/[\w.-]+)$/)?.[1] ?? repoUrl;
      repo = { provider, url: repoUrl.trim(), repo: repoName, branch: branch || "main" };
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
        `mutation($id: String!, $input: UpdateSourceInput!) { updateServiceSource(id: $id, input: $input) { id } }`,
        {
          id: serviceId,
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
          `mutation($id: String!, $build: BuildConfigInput!) { updateServiceBuild(id: $id, build: $build) { id } }`,
          { id: serviceId, build: { rootDir: build.rootDirectory } },
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
      // Commit a server change first — this moves the service and, for a
      // previously-deployed one, marks its data for migration. updateServiceSource
      // intentionally does NOT auto-deploy for the upload source, so the redeploy
      // below is the single deploy that runs and it consumes that migration marker.
      if (serverId !== initialServerId) {
        const moved = await gqlAction(
          `mutation($id: String!, $input: UpdateSourceInput!) { updateServiceSource(id: $id, input: $input) { id } }`,
          {
            id: serviceId,
            input: { source: deploySourceEnumName("upload"), serverId },
          },
        );
        if (!moved.ok) {
          toast.error(moved.error);
          return;
        }
      }
      const res = await gqlAction(
        `mutation($serviceId: String!) { redeploy(serviceId: $serviceId) { id } }`,
        { serviceId },
        (d: { redeploy: { id: string } }) => d.redeploy,
      );
      if (res.ok && res.data) {
        toast.success("Deploying…");
        router.push(`/services/${slug}/deployments/${res.data.id}`);
      } else if (!res.ok) {
        toast.error(res.error);
      }
    });
  }

  // Persist a PARTIAL build config. updateServiceBuild merges field-by-field, so
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
        `mutation($id: String!, $build: BuildConfigInput!) { updateServiceBuild(id: $id, build: $build) { id } }`,
        { id: serviceId, build: input },
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
    persistBuildPatch(
      {
        buildMethod: build.buildMethod,
        settings: build.methodSettings,
        installCommand: build.installCommand,
        buildCommand: build.buildCommand,
        outputDir: build.outputDirectory,
        startCommand: build.startCommand,
        runtimeVersion: build.runtimeVersion,
        port: build.port,
      },
      () => setSavedBuildKey(committed),
      "Build settings saved",
    );
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
    setAutoDeploy(v);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $value: Boolean!) { setServiceAutoDeploy(id: $id, value: $value) { id } }`,
        { id: serviceId, value: v },
      );
      if (res.ok) router.refresh();
      else toast.error(res.error);
    });
  }

  return (
    <>
      <div className="space-y-6">
        {/* Deploy source */}
        <Card>
          <CardHeader>
            <CardTitle className="flex w-fit items-center gap-2 text-base">
              Deploy Source
              <InfoTip content="Change how this service is deployed and which server runs it." />
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
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <FieldLabel info="The Git repository URL to clone and deploy. The provider (GitHub, GitLab, Bitbucket) is detected from the host in the URL.">
                    Repository URL
                  </FieldLabel>
                  <div className="relative">
                    <GitHubIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={repoUrl}
                      onChange={(e) => setRepoUrl(e.target.value)}
                      placeholder="https://github.com/acme/my-app"
                      className="pl-9 font-mono text-sm"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <FieldLabel
                    info={
                      <>
                        The branch Deplo deploys from and watches for pushes.
                        Defaults to <code className="font-mono">main</code>.
                      </>
                    }
                  >
                    Production Branch
                  </FieldLabel>
                  <div className="relative">
                    <GitBranch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={branch}
                      onChange={(e) => setBranch(e.target.value)}
                      className="pl-9"
                    />
                  </div>
                </div>
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
              <UploadInput serviceId={serviceId} current={initialUpload} />
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
                  <FullComposeDialog serviceId={serviceId} />
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
                info="The server (host machine) that builds and runs this service."
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
                  Saving redeploys this service on the new server and copies its data
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
          <Card>
            <CardHeader>
              <CardTitle className="flex w-fit items-center gap-2 text-base">
                Build &amp; Output Settings
                <InfoTip content="How Deplo installs, builds and runs your app inside Docker." />
              </CardTitle>
            </CardHeader>
            <CardContent>
              <BuildConfigFields build={build} onBuildChange={setBuild} />
            </CardContent>
            <CardFooter className="justify-between border-t border-border pt-4">
              <DirtyHint dirty={buildDirty} />
              <Button size="sm" onClick={saveBuild} disabled={pending || !buildDirty}>
                <Save className="size-4" />
                Save build settings
              </Button>
            </CardFooter>
          </Card>
        )}

        {/* Automatic deployments — deploy-on-push behaviour. */}
        <Card>
          <CardHeader>
            <CardTitle className="flex w-fit items-center gap-2 text-base">
              Automatic deployments
              <InfoTip content="Deploy automatically on every push to the production branch." />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div>
                <p className="text-sm font-medium">Deploy on push</p>
                <p className="text-xs text-muted-foreground">
                  Every push to the production branch triggers a new deployment.
                </p>
              </div>
              <Switch
                checked={autoDeploy}
                onCheckedChange={toggleAuto}
                disabled={pending}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Warn before leaving with unsaved source/build edits (auto-deploy saves
          on change, so it doesn't count toward this). */}
      <UnsavedChangesGuard when={overallDirty} />
    </>
  );
}
