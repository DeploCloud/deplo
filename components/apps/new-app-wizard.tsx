"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  GitBranch,
  Container,
  FileText,
  Server as ServerIcon,
  Pencil,
  Variable,
} from "lucide-react";

import { GitHubIcon } from "@/components/shared/brand-icons";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import { Switch } from "@/components/ui/switch";
import { DocsLink } from "@/components/ui/docs-link";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { ImageInput } from "@/components/apps/image-input";
import { UploadInput } from "@/components/apps/upload-input";
import { BuildConfigFields } from "@/components/apps/build-config-fields";
import { RootDirectoryFields } from "@/components/apps/settings/root-directory-fields";
import {
  FrameworkRow,
  FrameworkRowSkeleton,
} from "@/components/apps/framework-badge";
import { useRepoFramework } from "@/components/apps/use-repo-framework";
import {
  GithubRepoPicker,
  type GithubSelection,
} from "@/components/apps/github-repo-picker";
import {
  GitSourcePicker,
  type GitSourceValue,
} from "@/components/apps/git-source-picker";
import { GithubConnectButton } from "@/components/apps/github-connect-button";
import {
  GitDeployOptions,
  watchPathsToArray,
  DEFAULT_GIT_DEPLOY_OPTIONS,
  type GitDeployOptionsValue,
} from "@/components/apps/git-deploy-options";
import { ArchiveDropZone } from "@/components/apps/archive-drop-zone";
import { SOURCE_TABS, sourceLabelFor } from "@/components/apps/source-tabs";
import {
  WizardCard,
  WizardStage,
  useStepSwap,
} from "@/components/apps/wizard/wizard-card";
import { SourceTiles } from "@/components/apps/wizard/source-tiles";
import { ComposeDialog } from "@/components/apps/wizard/compose-dialog";
import {
  EnvDraftDialog,
  type DraftEnvRow,
  type LinkableSharedVar,
} from "@/components/apps/wizard/env-draft-dialog";
import {
  AdvancedSection,
  AdvancedGroup,
} from "@/components/apps/wizard/advanced-section";
import { CommandField } from "@/components/apps/wizard/command-field";

import {
  hasBlockingErrors,
  lintCompose,
  composeServiceNames,
  type LintDiagnostic,
} from "@/lib/deploy/compose-lint";
import { validateComposeUpArgs } from "@/lib/deploy/compose-args";
import {
  clearPendingArchive,
  peekPendingArchive,
} from "@/lib/deploy/pending-archive";
import { uploadArchive } from "@/lib/deploy/upload-client";
import { buildConfigFor } from "@/lib/frameworks";
import { archiveExt } from "@/lib/deploy/upload-shared";
import type { BuildConfig, DeploySource } from "@/lib/types";
import { deploySourceEnumName } from "@/lib/types";
import { gqlAction } from "@/lib/graphql-client";
import { serverLabel } from "@/lib/utils";
import type { GitConnectionDTO } from "@/lib/data/git-connections";
import type { GithubInstallationDTO } from "@/lib/data/github";

export interface WizardServer {
  id: string;
  name: string;
  type: "localhost" | "remote";
}

/** A host that can compile for another machine (Settings → Servers marks one). */
export interface WizardBuildServer {
  id: string;
  name: string;
  hostArch: string;
  buildOnly: boolean;
}

export interface WizardTemplate {
  id: string;
  name: string;
  variantName?: string;
  description: string;
  logo: string | null;
  compose: string;
  env: { key: string; value: string }[];
  /** Which compose service + port Traefik exposes for this template (first). */
  expose: { service: string; port: number } | null;
  /** Every publicly-routed service (multi-domain templates expose 2+). */
  exposes: { service: string; port: number; host?: string }[];
  /** Pre-generated nip.io domain baked into the template's env. */
  autoDomain: string | null;
  /** Template config files to materialise at deploy time. */
  mounts: { filePath: string; content: string }[];
}

/**
 * Where the new app lands (ADR-0009 - one home only): the folder, or the project
 * environment, the user had open on the Overview when they hit "New app".
 */
export interface WizardPlacement {
  label: string;
  folderId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
}

type Step = "source" | "details" | "configure";

/** The build server picker's "let Deplo choose" row - a Select cannot hold null. */
const AUTO_BUILD_SERVER = "__auto__";

function parseRepo(url: string): {
  repo: string;
  provider: "github" | "gitlab" | "bitbucket" | "git";
} | null {
  const clean = url.trim().replace(/\.git$/, "");
  const m = clean.match(
    /(?:github|gitlab|bitbucket)\.com[/:]([\w.-]+\/[\w.-]+)/i,
  );
  const provider = /gitlab/i.test(clean)
    ? "gitlab"
    : /bitbucket/i.test(clean)
      ? "bitbucket"
      : /github/i.test(clean)
        ? "github"
        : "git";
  if (m) return { repo: m[1], provider };
  if (/^[\w.-]+\/[\w.-]+$/.test(clean))
    return { repo: clean, provider: "github" };
  if (/^https?:\/\/.+\/.+/.test(clean)) {
    const tail = clean.replace(/^https?:\/\/[^/]+\//, "");
    return { repo: tail, provider: "git" };
  }
  return null;
}

/** The app name an image reference suggests: `ghcr.io/acme/api:v2` ⇒ `api`. */
function nameFromImage(ref: string): string {
  const path = ref.trim().split("@")[0];
  const lastSegment = path.split("/").pop() ?? "";
  return lastSegment.split(":")[0] ?? "";
}

/** The app name an archive suggests: `shop.tar.gz` ⇒ `shop`. */
function nameFromArchive(filename: string): string {
  const ext = archiveExt(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
}

export function NewAppWizard({
  servers,
  buildServers,
  sharedVars,
  template,
  presetRepo,
  presetName,
  presetSource,
  installations,
  connections,
  placement,
  exitHref,
}: {
  servers: WizardServer[];
  /** Hosts offerable under Advanced → Build on. */
  buildServers: WizardBuildServer[];
  /** The team's shared variables, empty when the creator can't manage env. */
  sharedVars: LinkableSharedVar[];
  template?: WizardTemplate;
  presetRepo?: string;
  presetName?: string;
  /** A source the caller already knows - a dropped archive opens on Upload. */
  presetSource?: DeploySource | null;
  installations: GithubInstallationDTO[];
  connections: GitConnectionDTO[];
  placement?: WizardPlacement | null;
  /** Where Cancel goes - the Overview drill-in, or the template catalog. */
  exitHref: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const isTemplate = Boolean(template);

  // An archive dropped on another page rides a module variable across the
  // client-side navigation. Read (not consumed) during render so the state below
  // can start from it; the effect at the end of this block is what drops it.
  const [dropped] = React.useState(peekPendingArchive);
  React.useEffect(() => clearPendingArchive(), []);

  // A template arrives resolved (its stack, env and routing are decided), so the
  // wizard opens on the last card. A dropped archive already answered step one.
  const [source, setSource] = React.useState<DeploySource | null>(
    isTemplate
      ? "docker-image"
      : dropped
        ? "upload"
        : (presetSource ?? (presetRepo ? "git" : null)),
  );
  const { step, direction, leaving, go } = useStepSwap<Step>(
    isTemplate || presetSource || presetRepo || dropped ? "details" : "source",
  );

  const [ghSelection, setGhSelection] = React.useState<GithubSelection | null>(
    null,
  );
  const [gitValue, setGitValue] = React.useState<GitSourceValue>({
    provider: presetRepo ? "github" : "git",
    url: presetRepo ? `https://github.com/${presetRepo}` : "",
    repo: presetRepo ?? "",
    branch: "main",
    connectionId: null,
  });
  const [dockerImage, setDockerImage] = React.useState("");
  // A code archive picked here and held until deploy, then streamed to the
  // freshly-created app (there's no app to POST to yet).
  const [uploadFile, setUploadFile] = React.useState<File | null>(dropped);
  const [compose, setCompose] = React.useState(template?.compose ?? "");
  const [composeDiags, setComposeDiags] = React.useState<LintDiagnostic[]>(
    () => (template?.compose ? lintCompose(template.compose) : []),
  );

  const [name, setName] = React.useState(
    presetName ??
      template?.name ??
      (dropped ? nameFromArchive(dropped.name) : ""),
  );
  const [nameTouched, setNameTouched] = React.useState(
    Boolean(presetName ?? template?.name),
  );
  const [serverId, setServerId] = React.useState(servers[0]?.id ?? "");
  const [buildServerId, setBuildServerId] = React.useState<string | null>(null);
  const [autoDeploy, setAutoDeploy] = React.useState(true);
  const [gitOptions, setGitOptions] = React.useState<GitDeployOptionsValue>(
    DEFAULT_GIT_DEPLOY_OPTIONS,
  );
  const [composeUpArgs, setComposeUpArgs] = React.useState("");
  const [envRows, setEnvRows] = React.useState<DraftEnvRow[]>(
    template?.env ?? [],
  );
  const [sharedIds, setSharedIds] = React.useState<string[]>([]);
  const [composeOpen, setComposeOpen] = React.useState(false);
  const [envOpen, setEnvOpen] = React.useState(false);

  // What the user has actually chosen. `build` below is this with what the
  // repository told us layered on.
  const [draftBuild, setDraftBuild] = React.useState(() => buildConfigFor());
  const [portTouched, setPortTouched] = React.useState(false);
  const [commandsTouched, setCommandsTouched] = React.useState(false);

  const usesGit = source === "github" || source === "git";
  // Build settings only apply when Deplo turns code into an image. A prebuilt
  // image and a compose stack are deployed as-is.
  const buildsImage = source !== "docker-image" && source !== "compose";
  const templateCompose = isTemplate && source === "docker-image";
  const useCompose = templateCompose || source === "compose";

  // ── What the repository tells us about itself ─────────────────────────────
  const gitRepoParsed = source === "git" ? parseRepo(gitValue.url) : null;
  const detectRepo =
    source === "github" && ghSelection
      ? {
          repo: ghSelection.fullName,
          url: `https://github.com/${ghSelection.fullName}`,
          branch: ghSelection.branch || "",
          installationId: ghSelection.installationId,
        }
      : gitRepoParsed && gitRepoParsed.provider === "github"
        ? {
            repo: gitRepoParsed.repo,
            url: gitValue.url.trim(),
            branch: gitValue.branch,
            installationId: null,
          }
        : null;

  const {
    framework,
    commands,
    detecting: detectingFramework,
  } = useRepoFramework({
    repo: buildsImage ? (detectRepo?.repo ?? null) : null,
    url: detectRepo?.url,
    branch: detectRepo?.branch,
    installationId: detectRepo?.installationId,
    buildMethod: draftBuild.buildMethod,
    rootDirectory: draftBuild.rootDirectory,
  });

  // The port follows the recognised framework's own server instead of a
  // hardcoded 3000, and the commands follow the repo's package.json - until the
  // user edits either, after which what they typed wins.
  const build = React.useMemo(() => {
    let next = draftBuild;
    if (framework && !portTouched && next.port !== framework.defaultPort) {
      next = { ...next, port: framework.defaultPort };
    }
    if (!commandsTouched && (commands.buildCommand || commands.startCommand)) {
      next = {
        ...next,
        buildCommand: commands.buildCommand ?? next.buildCommand,
        startCommand: commands.startCommand ?? next.startCommand,
      };
    }
    return next;
  }, [draftBuild, framework, portTouched, commands, commandsTouched]);

  const prefilledBuild = !commandsTouched ? commands.buildCommand : null;
  const prefilledStart = !commandsTouched ? commands.startCommand : null;

  function onBuildChange(next: BuildConfig) {
    if (next.port !== build.port) setPortTouched(true);
    if (
      next.buildCommand !== build.buildCommand ||
      next.startCommand !== build.startCommand
    ) {
      setCommandsTouched(true);
    }
    setDraftBuild(next);
  }

  /** Name the app after whatever the user just picked, until they type one. */
  function suggestName(suggested: string) {
    if (!nameTouched && suggested) setName(suggested);
  }

  function onGitChange(value: GitSourceValue) {
    setGitValue(value);
    if (value.repo) suggestName(value.repo.split("/").pop() ?? "");
  }

  function onComposeSaved(next: string, diagnostics: LintDiagnostic[]) {
    setCompose(next);
    setComposeDiags(diagnostics);
    suggestName(composeServiceNames(next)[0] ?? "");
  }

  const selectedServer = servers.find((s) => s.id === serverId);
  const composeServices = React.useMemo(
    () => (compose.trim() ? composeServiceNames(compose) : []),
    [compose],
  );
  const composeArgsProblem = composeUpArgs.trim()
    ? validateComposeUpArgs(composeUpArgs.trim())
    : null;

  // ── Navigation ───────────────────────────────────────────────────────────
  function sourceReady(): boolean {
    if (source === "github") return Boolean(ghSelection);
    if (source === "git") return Boolean(parseRepo(gitValue.url));
    if (source === "docker-image")
      return isTemplate || Boolean(dockerImage.trim());
    if (source === "upload") return Boolean(uploadFile);
    if (source === "compose") return Boolean(compose.trim());
    return false;
  }

  const nextDisabled =
    step === "source"
      ? !source
      : step === "details"
        ? !sourceReady() || (!usesGit && !name.trim())
        : !name.trim();

  function onBack() {
    if (step === "source" || isTemplate) {
      router.push(exitHref);
      return;
    }
    go(step === "configure" ? "details" : "source", "back");
  }

  function onNext() {
    if (step === "source") {
      go("details", "forward");
      return;
    }
    if (step === "details" && usesGit) {
      go("configure", "forward");
      return;
    }
    deploy();
  }

  // ── Deploy ───────────────────────────────────────────────────────────────
  function deploy() {
    if (!name.trim()) {
      toast.error("Enter an app name");
      return;
    }
    if (!serverId) {
      toast.error("Select a server to deploy to");
      return;
    }
    if (useCompose && hasBlockingErrors(composeDiags)) {
      toast.error("Fix the compose errors before deploying");
      return;
    }
    if (source === "compose" && !compose.trim()) {
      toast.error("Write a docker-compose stack to deploy");
      return;
    }
    if (composeArgsProblem) {
      toast.error(composeArgsProblem);
      return;
    }

    let repo = null as null | {
      provider: string;
      url: string;
      repo: string;
      branch: string;
      installationId?: string | null;
      connectionId?: string | null;
      triggerType?: "push" | "tag";
      watchPaths?: string[];
      submodules?: boolean;
    };
    let image: string | null = null;

    if (source === "github") {
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
    } else if (source === "git") {
      // A bare owner/repo still means GitHub, the way it always has; anything
      // else comes back from the picker already resolved.
      const parsed = parseRepo(gitValue.url);
      if (!parsed) {
        toast.error("Enter a valid Git repository URL");
        return;
      }
      repo = {
        provider: gitValue.connectionId ? gitValue.provider : parsed.provider,
        url: gitValue.url.startsWith("http")
          ? gitValue.url
          : `https://github.com/${parsed.repo}`,
        repo: gitValue.connectionId ? gitValue.repo : parsed.repo,
        branch: gitValue.branch || "main",
        connectionId: gitValue.connectionId,
      };
    } else if (source === "docker-image") {
      if (!isTemplate && !dockerImage.trim()) {
        toast.error("Enter a Docker image reference");
        return;
      }
      image = isTemplate ? null : dockerImage.trim();
    }

    if (repo) {
      repo = {
        ...repo,
        triggerType: gitOptions.triggerType,
        watchPaths: watchPathsToArray(gitOptions.watchPaths),
        submodules: gitOptions.submodules,
      };
    }

    const payloadBuild = buildsImage
      ? build
      : buildConfigFor({ buildMethod: "dockerfile" });
    const filledEnv = envRows.filter((e) => e.key.trim());

    startTransition(async () => {
      const res = await gqlAction(
        `mutation($input: CreateAppInput!) {
          createApp(input: $input) { id slug latestDeployment { id } }
        }`,
        {
          input: {
            name: name.trim(),
            // A template deploying its own stack is stored as the `compose`
            // source so settings opens on the Compose tab and the deploy engine
            // is unambiguous.
            source: deploySourceEnumName(useCompose ? "compose" : source!),
            serverId,
            buildServerId,
            composeUpArgs: useCompose ? composeUpArgs.trim() || null : null,
            dockerImage: image,
            // Seed the app's display logo from the template so a deployed
            // template carries its icon; editable later from app settings.
            logo: isTemplate ? template!.logo : null,
            compose: useCompose ? compose : null,
            env: filledEnv.length
              ? filledEnv.map((e) => ({
                  key: e.key.trim(),
                  value: e.value,
                  // Undefined lets the key's own name decide, which is what a
                  // template's generated passwords want.
                  type: e.secret ? "secret" : undefined,
                }))
              : undefined,
            sharedVarIds: sharedIds.length ? sharedIds : null,
            repo,
            build: {
              buildMethod: payloadBuild.buildMethod,
              settings: payloadBuild.methodSettings,
              installCommand: payloadBuild.installCommand,
              buildCommand: payloadBuild.buildCommand,
              outputDir: payloadBuild.outputDirectory,
              startCommand: payloadBuild.startCommand,
              rootDir: payloadBuild.rootDirectory,
              runtimeVersion: payloadBuild.runtimeVersion,
              port: payloadBuild.port,
            },
            autoDeploy: usesGit ? autoDeploy : false,
            // Routing metadata is template-only; a hand-written compose stack
            // lets the engine auto-detect which service to expose.
            composeService: templateCompose
              ? (template!.expose?.service ?? null)
              : null,
            composePort: templateCompose
              ? (template!.expose?.port ?? null)
              : null,
            extraDomains: templateCompose
              ? template!.exposes
                  .slice(1)
                  .filter((e) => e.host)
                  .map((e) => ({
                    service: e.service,
                    port: e.port,
                    host: e.host!,
                  }))
              : null,
            autoDomain: templateCompose ? template!.autoDomain : null,
            mounts: templateCompose ? template!.mounts : null,
            folderId: placement?.folderId ?? null,
            projectId: placement?.projectId ?? null,
            environmentId: placement?.environmentId ?? null,
          },
        },
        (d: {
          createApp: {
            id: string;
            slug: string;
            latestDeployment: { id: string } | null;
          };
        }) => d.createApp,
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const app = res.data;
      if (!app) return;

      // Invalidate the router cache so the shared dashboard layout re-runs on
      // the destination, otherwise the topbar breadcrumb's team snapshot is
      // stale and the brand-new app is missing from it until a hard reload.
      router.refresh();

      if (source === "upload" && uploadFile) {
        try {
          await uploadArchive(app.id, uploadFile);
        } catch (e) {
          // The app exists but the archive didn't land - send the user to its
          // settings to retry rather than deploying nothing.
          toast.error(
            `App created, but the upload failed (${
              e instanceof Error ? e.message : "unknown error"
            }). Upload the archive from Settings.`,
          );
          router.push(`/apps/${app.slug}/settings`);
          return;
        }
        const dep = await gqlAction(
          `mutation($appId: String!) { redeploy(appId: $appId) { id } }`,
          { appId: app.id },
          (d: { redeploy: { id: string } }) => d.redeploy,
        );
        if (dep.ok && dep.data) {
          toast.success("Deployment started");
          router.push(`/apps/${app.slug}/deployments/${dep.data.id}?created=1`);
        } else {
          // The archive is stored; only the deploy kick-off failed.
          if (!dep.ok) toast.error(dep.error);
          router.push(`/apps/${app.slug}/settings`);
        }
        return;
      }

      const firstDeploymentId = app.latestDeployment?.id;
      toast.success(
        firstDeploymentId
          ? "Deployment started"
          : source === "upload"
            ? "App created - upload an archive from Settings to deploy"
            : "App created - it needs someone with permission to deploy",
      );
      router.push(
        firstDeploymentId
          ? `/apps/${app.slug}/deployments/${firstDeploymentId}?created=1`
          : `/apps/${app.slug}`,
      );
    });
  }

  // ── Cards ────────────────────────────────────────────────────────────────
  const meta = placement ? (
    <p className="text-xs text-muted-foreground">
      Creating in <span className="text-foreground">{placement.label}</span>
    </p>
  ) : null;

  const advanced = (
    <AdvancedSection
      summary={selectedServer ? serverLabel(selectedServer) : undefined}
    >
      <AdvancedGroup title="Deploy to">
        <Select value={serverId} onValueChange={setServerId}>
          <SelectTrigger>
            <SelectValue placeholder="Select a server" />
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
      </AdvancedGroup>

      <AdvancedGroup title="Environment variables">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {envRows.length + sharedIds.length === 0
              ? "None yet"
              : `${envRows.length} typed, ${sharedIds.length} shared`}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => setEnvOpen(true)}
          >
            <Variable className="size-4" />
            Edit variables
          </Button>
        </div>
      </AdvancedGroup>

      {buildsImage && (
        <>
          {/* No wrapper title: these fields carry their own headings, and the
              commands are only here when no step of the wizard asked for them. */}
          <BuildConfigFields
            build={build}
            onBuildChange={onBuildChange}
            commands={!usesGit}
          />
          <AdvancedGroup title="Build path">
            <RootDirectoryFields build={build} onBuildChange={onBuildChange} />
          </AdvancedGroup>
          <AdvancedGroup title="Build on">
            <Select
              value={buildServerId ?? AUTO_BUILD_SERVER}
              onValueChange={(v) =>
                setBuildServerId(v === AUTO_BUILD_SERVER ? null : v)
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO_BUILD_SERVER}>Automatic</SelectItem>
                {buildServers.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    <span className="flex items-center gap-2">
                      <ServerIcon className="size-4 text-muted-foreground" />
                      {s.name}
                      {s.buildOnly && (
                        <Badge variant="outline">Build server</Badge>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </AdvancedGroup>
        </>
      )}

      {usesGit && (
        <AdvancedGroup title="Git">
          <GitDeployOptions value={gitOptions} onChange={setGitOptions} />
        </AdvancedGroup>
      )}

      {useCompose && (
        <AdvancedGroup title="Extra compose flags">
          <Input
            id="compose-up-args"
            value={composeUpArgs}
            onChange={(e) => setComposeUpArgs(e.target.value)}
            placeholder="--pull always"
            className="font-mono text-sm"
            aria-invalid={Boolean(composeArgsProblem)}
          />
          {composeArgsProblem && (
            <p className="mt-1 text-xs text-destructive">
              {composeArgsProblem}
            </p>
          )}
        </AdvancedGroup>
      )}
    </AdvancedSection>
  );

  const nameField = (
    <div className="space-y-2">
      <FieldLabel
        htmlFor="name"
        info="Shown everywhere in Deplo. It also seeds the app's URL, which is frozen after creation."
      >
        App name
      </FieldLabel>
      <Input
        id="name"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setNameTouched(true);
        }}
        placeholder="my-app"
      />
    </div>
  );

  const noServer = servers.length === 0 && (
    <EmptyState
      icon={ServerIcon}
      title="No server connected"
      docs="servers.add"
      description="Deplo runs your apps on a server, and none is connected yet."
      action={
        <Button asChild>
          <Link href="/settings/servers">Add a server</Link>
        </Button>
      }
    />
  );

  return (
    <>
      {/* Dropping an archive anywhere in the wizard is the Upload source. */}
      <ArchiveDropZone
        onFile={(file) => {
          setUploadFile(file);
          setSource("upload");
          suggestName(nameFromArchive(file.name));
          if (step === "source") go("details", "forward");
        }}
      />

      <WizardStage step={step} direction={direction} leaving={leaving}>
        {step === "source" ? (
          <WizardCard
            title="New app"
            description="Where does it come from? Deplo builds it and configures Docker and Traefik for you."
            meta={meta}
            backLabel="Cancel"
            onBack={onBack}
            onNext={onNext}
            nextDisabled={nextDisabled}
          >
            <SourceTiles value={source} onSelect={setSource} />
          </WizardCard>
        ) : step === "details" ? (
          <WizardCard
            title={
              isTemplate
                ? templateTitle(template!)
                : `Deploy from ${sourceLabelFor(source!)}`
            }
            description={
              isTemplate ? template!.description : detailsDescription(source!)
            }
            meta={meta}
            backLabel={isTemplate ? "Back to templates" : "Back"}
            onBack={onBack}
            onNext={onNext}
            nextLabel={usesGit ? "Next" : "Deploy"}
            deploy={!usesGit}
            nextDisabled={nextDisabled}
            pending={pending}
          >
            {source === "github" &&
              (installations.length === 0 ? (
                <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-6 text-center">
                  <GitHubIcon className="size-6 text-muted-foreground" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium">
                      Connect GitHub to import a repo
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Deplo creates a GitHub App with only the permissions it
                      needs, then you pick which repositories it can access.
                    </p>
                  </div>
                  <GithubConnectButton size="sm" />
                </div>
              ) : (
                <GithubRepoPicker
                  installations={installations}
                  onChange={(sel) => {
                    setGhSelection(sel);
                    if (sel) suggestName(sel.fullName.split("/")[1] ?? "");
                  }}
                />
              ))}

            {source === "git" && (
              <GitSourcePicker
                connections={connections}
                initial={{
                  url: gitValue.url,
                  repo: gitValue.repo,
                  branch: gitValue.branch,
                }}
                onChange={onGitChange}
              />
            )}

            {source === "docker-image" && !isTemplate && (
              <div className="space-y-2">
                <FieldLabel
                  htmlFor="image"
                  info="Pulls a prebuilt image from any registry. No build step runs. Start typing to search."
                  docs="deploy.dockerImage"
                >
                  Docker image
                </FieldLabel>
                <ImageInput
                  id="image"
                  value={dockerImage}
                  onChange={(v) => {
                    setDockerImage(v);
                    suggestName(nameFromImage(v));
                  }}
                />
              </div>
            )}

            {source === "upload" && (
              <UploadInput
                file={uploadFile}
                onSelect={(file) => {
                  setUploadFile(file);
                  if (file) suggestName(nameFromArchive(file.name));
                }}
              />
            )}

            {isTemplate && (
              <div className="flex items-center gap-4 rounded-lg border border-border p-3">
                <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border p-2">
                  {template!.logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={template!.logo}
                      alt={templateTitle(template!)}
                      className="size-full object-contain"
                    />
                  ) : (
                    <Container className="size-6 text-foreground" />
                  )}
                </div>
                <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                  Deplo provisions the stack and exposes it through Traefik.{" "}
                  <DocsLink topic="deploy.fromTemplate" />
                </p>
              </div>
            )}

            {useCompose && (
              <ComposeSummary
                services={composeServices}
                diagnostics={composeDiags}
                onOpen={() => setComposeOpen(true)}
              />
            )}

            {!usesGit && nameField}
            {!usesGit && noServer}
            {!usesGit && servers.length > 0 && advanced}
          </WizardCard>
        ) : (
          <WizardCard
            title="Set up the app"
            description="Deplo read your repository. Change anything that looks wrong."
            meta={meta}
            onBack={onBack}
            onNext={onNext}
            nextLabel="Deploy"
            deploy
            nextDisabled={nextDisabled}
            pending={pending}
          >
            {nameField}

            {detectingFramework ? (
              <FrameworkRowSkeleton />
            ) : (
              framework && (
                <FrameworkRow
                  id={framework.id}
                  caption={`Detected in your repository · container port ${build.port}`}
                />
              )
            )}

            <CommandField
              id="build-command"
              label="Build command"
              info="Run to compile the app. Leave it empty and the builder works it out."
              value={build.buildCommand ?? ""}
              onChange={(v) => onBuildChange({ ...build, buildCommand: v })}
              detected={prefilledBuild}
              placeholder="Detected at build time"
            />
            <CommandField
              id="start-command"
              label="Deploy command"
              info="Run to start the container. Leave it empty and the builder works it out."
              value={build.startCommand ?? ""}
              onChange={(v) => onBuildChange({ ...build, startCommand: v })}
              detected={prefilledStart}
              placeholder="Detected at build time"
            />

            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div className="flex items-center gap-2">
                <GitBranch className="size-5 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Automatic deployments</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Deploy on every push to{" "}
                    {(source === "github"
                      ? ghSelection?.branch
                      : gitValue.branch) || "main"}
                    .
                  </p>
                </div>
              </div>
              <Switch checked={autoDeploy} onCheckedChange={setAutoDeploy} />
            </div>

            {noServer}
            {servers.length > 0 && advanced}
          </WizardCard>
        )}
      </WizardStage>

      <ComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        value={compose}
        onSave={onComposeSaved}
        title={isTemplate ? templateTitle(template!) : "Docker Compose"}
      />
      <EnvDraftDialog
        open={envOpen}
        onOpenChange={setEnvOpen}
        rows={envRows}
        sharedIds={sharedIds}
        sharedVars={sharedVars}
        onSave={(rows, ids) => {
          setEnvRows(rows);
          setSharedIds(ids);
        }}
      />
    </>
  );
}

function templateTitle(t: WizardTemplate): string {
  return t.variantName ? `${t.name} · ${t.variantName}` : t.name;
}

function detailsDescription(source: DeploySource): string {
  return (
    SOURCE_TABS.find((t) => t.id === source)?.blurb ??
    "Where your code or image comes from."
  );
}

/**
 * What the card says about a stack it is not showing: how big it is, whether the
 * linter is happy, and the way into the editor.
 */
function ComposeSummary({
  services,
  diagnostics,
  onOpen,
}: {
  services: string[];
  diagnostics: LintDiagnostic[];
  onOpen: () => void;
}) {
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
      <div className="flex min-w-0 items-center gap-3">
        <FileText className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {services.length === 0
              ? "No stack yet"
              : `${services.length} service${services.length === 1 ? "" : "s"}`}
          </p>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {errors > 0
              ? `${errors} error${errors === 1 ? "" : "s"} to fix`
              : services.length === 0
                ? "Paste or write your docker-compose.yml"
                : services.join(", ")}
          </p>
        </div>
      </div>
      <Button type="button" variant="outline" onClick={onOpen}>
        {services.length === 0 ? (
          <>
            <FileText className="size-4" />
            Write compose
          </>
        ) : (
          <>
            <Pencil className="size-4" />
            Edit compose
          </>
        )}
      </Button>
    </div>
  );
}
