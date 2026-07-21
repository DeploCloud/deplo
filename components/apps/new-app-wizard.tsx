"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  GitBranch,
  ChevronDown,
  Rocket,
  Check,
  Container,
  Upload,
  Server as ServerIcon,
  Pencil,
  RotateCcw,
  Plus,
  Trash2,
  FileText,
} from "lucide-react";
import { GitHubIcon } from "@/components/shared/brand-icons";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
// Textarea no longer used here — the compose editor replaces it.
import { Label } from "@/components/ui/label";
import { FieldLabel } from "@/components/ui/info-tip";
import { ComposeEditor } from "@/components/apps/compose-editor";
import { ComposeLintSummary } from "@/components/apps/compose-lint-summary";
import { ImageInput } from "@/components/apps/image-input";
import { hasBlockingErrors, type LintDiagnostic } from "@/lib/deploy/compose-lint";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { BuildConfigFields } from "@/components/apps/build-config-fields";
import { buildConfigFor } from "@/lib/frameworks";
import type { DeploySource } from "@/lib/types";
import { deploySourceEnumName } from "@/lib/types";
import { gqlAction } from "@/lib/graphql-client";
import { cn, serverLabel } from "@/lib/utils";
import { GithubRepoPicker, type GithubSelection } from "@/components/apps/github-repo-picker";
import { GithubConnectButton } from "@/components/apps/github-connect-button";
import { UploadInput } from "@/components/apps/upload-input";
import {
  GitDeployOptions,
  watchPathsToArray,
  DEFAULT_GIT_DEPLOY_OPTIONS,
  type GitDeployOptionsValue,
} from "@/components/apps/git-deploy-options";
import { uploadArchive } from "@/lib/deploy/upload-client";
import type { GithubInstallationDTO } from "@/lib/data/github";

export interface WizardServer {
  id: string;
  name: string;
  type: "localhost" | "remote";
}

export interface WizardTemplate {
  id: string;
  name: string;
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
 * Where the new app lands (ADR-0009 — one home only): the folder, or the
 * project environment, the user had open on the Overview when they hit "New
 * app". Resolved server-side by the /new page from the `?folder=` / `?project=`
 * / `?env=` drill-in params; absent ⇒ the app is created at the top level.
 */
export interface WizardPlacement {
  /** What the summary rail shows, e.g. "Marketing" or "Shop · Production". */
  label: string;
  folderId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
}

function parseRepo(
  url: string,
): {
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

export function NewAppWizard({
  servers,
  template,
  presetRepo,
  presetName,
  installations,
  placement,
}: {
  servers: WizardServer[];
  template?: WizardTemplate;
  presetRepo?: string;
  presetName?: string;
  installations: GithubInstallationDTO[];
  /** Drill-in context: the folder / project environment the app is created in. */
  placement?: WizardPlacement | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const isTemplate = Boolean(template);
  const [ghSelection, setGhSelection] = React.useState<GithubSelection | null>(
    null,
  );
  // Templates start in a locked summary view. "Edit template" unlocks the full
  // source/build configuration so the user can tweak before deploying.
  const [editing, setEditing] = React.useState(false);
  const locked = isTemplate && !editing;

  const defaultServerId = servers[0]?.id ?? "";

  const [serverId, setServerId] = React.useState(defaultServerId);
  const [source, setSource] = React.useState<DeploySource>(
    isTemplate ? "docker-image" : "github",
  );
  const [repoUrl, setRepoUrl] = React.useState(
    presetRepo ? `https://github.com/${presetRepo}` : "",
  );
  const [dockerImage, setDockerImage] = React.useState("");
  // "Upload" source: a code archive picked here and held until deploy, then
  // streamed to the freshly-created app (there's no app to POST to yet).
  const [uploadFile, setUploadFile] = React.useState<File | null>(null);
  const [name, setName] = React.useState(presetName ?? template?.name ?? "");
  const [branch, setBranch] = React.useState("main");
  const [autoDeploy, setAutoDeploy] = React.useState(true);
  const [gitOptions, setGitOptions] = React.useState<GitDeployOptionsValue>(
    DEFAULT_GIT_DEPLOY_OPTIONS,
  );
  const [advanced, setAdvanced] = React.useState(false);
  const [build, setBuild] = React.useState(() => buildConfigFor());

  // The compose editor is shared by templates (their baked stack) and the
  // non-template Compose source tab; env rows stay template-only.
  const [compose, setCompose] = React.useState(template?.compose ?? "");
  const [composeDiags, setComposeDiags] = React.useState<LintDiagnostic[]>([]);
  const [envRows, setEnvRows] = React.useState<{ key: string; value: string }[]>(
    template?.env ?? [],
  );

  const usesGit = source === "github" || source === "git";
  // Build & output settings only apply when Deplo turns code into an image. A
  // prebuilt docker image and a compose stack are deployed as-is.
  const buildsImage = source !== "docker-image" && source !== "compose";

  function onRepoChange(value: string) {
    setRepoUrl(value);
    const parsed = parseRepo(value);
    if (parsed && !name) setName(parsed.repo.split("/")[1] ?? "");
  }

  function onSourceChange(next: DeploySource) {
    setSource(next);
  }

  // Whether this deploy ships a docker-compose stack. Two ways in:
  //  - a template still on its own source (docker-image) deploys its baked stack
  //    with the template's expose/exposes/mounts/autoDomain metadata;
  //  - a non-template project that picks the Compose source tab and writes its
  //    own stack — the deploy engine auto-detects the service to expose. The
  //    Compose tab is hidden for templates (it would drop their routing/mount
  //    metadata), so source === "compose" only ever fires for non-templates.
  const templateCompose = isTemplate && source === "docker-image";
  const useCompose = templateCompose || source === "compose";

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

    let repo = null as null | {
      provider: "github" | "gitlab" | "bitbucket" | "git";
      url: string;
      repo: string;
      branch: string;
      installationId?: string | null;
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
      const parsed = parseRepo(repoUrl);
      if (!parsed) {
        toast.error("Enter a valid Git repository URL");
        return;
      }
      repo = {
        provider: parsed.provider,
        url: repoUrl.startsWith("http")
          ? repoUrl
          : `https://github.com/${parsed.repo}`,
        repo: parsed.repo,
        branch: branch || "main",
      };
    } else if (source === "docker-image") {
      if (!isTemplate && !dockerImage.trim()) {
        toast.error("Enter a Docker image reference");
        return;
      }
      image = isTemplate ? null : dockerImage.trim();
    } else if (source === "compose") {
      // Hand-written stack: the engine auto-detects the service to expose, so no
      // expose/exposes metadata is sent (templates supply theirs separately).
    } else if (source === "upload") {
      // Upload: a code archive is attached after creation; no repo/image.
    }

    // Carry the git deploy options (trigger type / watch paths / submodules) on
    // whichever repo the source produced (github or git).
    if (repo) {
      repo = {
        ...repo,
        triggerType: gitOptions.triggerType,
        watchPaths: watchPathsToArray(gitOptions.watchPaths),
        submodules: gitOptions.submodules,
      };
    }

    // The build config only matters when Deplo builds an image. For a prebuilt
    // image or a compose stack the build section is hidden, so persisting the
    // editor's seed would land a misleading build method on the app; send a
    // dockerfile default instead so settings reflects reality.
    const payloadBuild = buildsImage
      ? build
      : buildConfigFor({ buildMethod: "dockerfile" });

    startTransition(async () => {
      const res = await gqlAction(
        `mutation($input: CreateAppInput!) {
          createApp(input: $input) { id slug latestDeployment { id } }
        }`,
        {
          input: {
            name: name.trim(),
            // A template deploying its own stack is stored as the `compose` source
            // so settings opens on the Compose tab and the deploy engine is
            // unambiguous.
            source: deploySourceEnumName(useCompose ? "compose" : source),
            serverId,
            dockerImage: image,
            // Seed the app's display logo from the template so a deployed
            // template carries its icon; editable later from app settings.
            logo: isTemplate ? template!.logo : null,
            compose: useCompose ? compose : null,
            env: isTemplate
              ? envRows.filter((e) => e.key.trim())
              : undefined,
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
            // Routing metadata is template-only; a hand-written compose stack lets
            // the engine auto-detect which service to expose. The PRIMARY domain
            // routes to the first declared service (composeService/composePort);
            // every OTHER declared host becomes an extra Domain row at creation.
            composeService: templateCompose
              ? template!.expose?.service ?? null
              : null,
            composePort: templateCompose ? template!.expose?.port ?? null : null,
            extraDomains: templateCompose
              ? template!.exposes
                  .slice(1)
                  .filter((e) => e.host)
                  .map((e) => ({ service: e.service, port: e.port, host: e.host! }))
              : null,
            autoDomain: templateCompose ? template!.autoDomain : null,
            mounts: templateCompose ? template!.mounts : null,
            // File the app where it was created from (an open folder or project
            // environment on the Overview) instead of dropping it at the top
            // level; the server re-validates the destination.
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
      const service = res.data;
      if (!service) return;

      // Invalidate the router cache so the shared dashboard layout re-runs on the
      // destination — otherwise the topbar breadcrumb's team snapshot is stale and
      // the brand-new app is missing from it until a hard reload.
      router.refresh();

      // Upload source with an attached archive: stream it to the freshly-created
      // (idle) app, then deploy — so creation ends on the live build logs like
      // every other source instead of stranding the user on an empty app.
      if (source === "upload" && uploadFile) {
        try {
          await uploadArchive(service.id, uploadFile);
        } catch (e) {
          // The app exists but the archive didn't land — send the user to its
          // settings to retry rather than deploying nothing.
          toast.error(
            `App created, but the upload failed (${
              e instanceof Error ? e.message : "unknown error"
            }). Upload the archive from Settings.`,
          );
          router.push(`/apps/${service.slug}/settings`);
          return;
        }
        const dep = await gqlAction(
          `mutation($appId: String!) { redeploy(appId: $appId) { id } }`,
          { appId: service.id },
          (d: { redeploy: { id: string } }) => d.redeploy,
        );
        if (dep.ok && dep.data) {
          toast.success("Uploaded — deploying…");
          router.push(`/apps/${service.slug}/deployments/${dep.data.id}`);
        } else {
          // The archive is stored; only the deploy kick-off failed. Land on
          // settings so the user can hit Save & Deploy.
          if (!dep.ok) toast.error(dep.error);
          router.push(`/apps/${service.slug}/settings`);
        }
        return;
      }

      // Non-upload sources deploy on create; a fileless upload stays idle until
      // the user uploads from Settings — don't claim it's deploying.
      toast.success(
        source === "upload"
          ? "App created — upload an archive from Settings to deploy"
          : "App created — deploying…",
      );
      // Every non-upload source kicks off a first deployment inside createApp
      // (startDeployment sets latestDeployment synchronously before it returns), so
      // land on that deployment's live build logs — the same destination the
      // upload path above uses — instead of a still-empty overview. A fileless
      // "upload" app is born idle with no deployment, so it falls back to its
      // overview.
      const firstDeploymentId = service.latestDeployment?.id;
      router.push(
        firstDeploymentId
          ? `/apps/${service.slug}/deployments/${firstDeploymentId}`
          : `/apps/${service.slug}`,
      );
    });
  }

  // Values surfaced in the sticky summary rail (right column) — the at-a-glance
  // recap of what will be created, next to the primary deploy action.
  const sourceLabel = isTemplate
    ? template!.name
    : SOURCE_TABS.find((t) => t.id === source)?.label ?? source;
  const selectedServer = servers.find((s) => s.id === serverId);
  const serverSummary = selectedServer ? serverLabel(selectedServer) : "—";
  const domainSummary = template?.autoDomain ?? "Auto · HTTPS";

  // Card order: configure the app first, then pick the source, then choose
  // which server runs it (3rd). Template-only compose/env follow afterwards.
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[1fr_320px]">
      {/* Left column: the configuration cards, in creation order. */}
      <div className="min-w-0 space-y-6">
        {/* 1. Configure */}
        <Card>
          <CardHeader>
            <CardTitle>Configure App</CardTitle>
            <CardDescription>
              Review the settings. Override anything you need.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="name">App Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my-app"
                />
              </div>
              {usesGit && source !== "github" && (
                <div className="space-y-2">
                  <FieldLabel
                    htmlFor="branch"
                    info={
                      <>
                        The Git branch Deplo deploys from and watches for
                        pushes. Defaults to{" "}
                        <code className="font-mono">main</code>.
                      </>
                    }
                  >
                    Production Branch
                  </FieldLabel>
                  <div className="relative">
                    <GitBranch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="branch"
                      value={branch}
                      onChange={(e) => setBranch(e.target.value)}
                      className="pl-9"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Build & output settings — the same method-aware controls the
                app settings page shows, kept inside a collapse so creation
                stays lean. Only relevant when Deplo builds an image (not for a
                prebuilt docker image or a compose stack). */}
            {!locked && buildsImage && (
              <>
                <button
                  type="button"
                  onClick={() => setAdvanced((v) => !v)}
                  className="flex w-full cursor-pointer items-center justify-between rounded-md border border-border px-3 py-2 text-sm hover:bg-accent"
                >
                  <span className="font-medium">Build &amp; Output Settings</span>
                  <ChevronDown
                    className={cn(
                      "size-4 transition-transform",
                      advanced && "rotate-180",
                    )}
                  />
                </button>

                {advanced && (
                  <div className="rounded-lg border border-border p-4">
                    <BuildConfigFields build={build} onBuildChange={setBuild} />
                  </div>
                )}
              </>
            )}

            {usesGit && (
              <div className="flex items-center justify-between rounded-lg border border-border p-3">
                <div className="flex items-center gap-2">
                  <GitBranch className="size-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">Automatic deployments</p>
                    <p className="text-xs text-muted-foreground">
                      Deploy on every push to{" "}
                      {(source === "github" ? ghSelection?.branch : branch) ||
                        "main"}
                      .
                    </p>
                  </div>
                </div>
                <Switch checked={autoDeploy} onCheckedChange={setAutoDeploy} />
              </div>
            )}

            {/* Git deploy options — trigger type, watch paths, submodules. Same
                controls the app settings page shows. */}
            {usesGit && (
              <div className="rounded-lg border border-border p-4">
                <GitDeployOptions value={gitOptions} onChange={setGitOptions} />
              </div>
            )}
          </CardContent>
        </Card>

        {/* 2. Source */}
        {locked ? (
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
              <div className="space-y-1.5">
                <CardTitle>Template</CardTitle>
                <CardDescription>
                  Deplo provisions the template&apos;s container stack and exposes
                  it through Traefik with automatic HTTPS.
                </CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setEditing(true)}
              >
                <Pencil className="size-4" />
                Edit template
              </Button>
            </CardHeader>
            <CardContent className="flex items-center gap-4">
              <div className="flex size-12 items-center justify-center overflow-hidden rounded-lg border border-border p-2">
                {template!.logo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={template!.logo}
                    alt={template!.name}
                    className="size-full object-contain"
                  />
                ) : (
                  <Container className="size-6 text-foreground" />
                )}
              </div>
              <div>
                <p className="font-medium">{template!.name}</p>
                <p className="line-clamp-2 text-sm text-muted-foreground">
                  {template!.description}
                </p>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
              <div className="space-y-1.5">
                <CardTitle>Source</CardTitle>
                <CardDescription>
                  {isTemplate
                    ? `Customising ${template!.name}. Change the source or build before deploying.`
                    : "Where your code or image comes from. Deplo builds and runs it in Docker."}
                </CardDescription>
              </div>
              {isTemplate && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditing(false);
                    onSourceChange("docker-image");
                  }}
                >
                  <RotateCcw className="size-4" />
                  Reset to template
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                {SOURCE_TABS.filter(
                  // Templates edit their baked stack inline in the Docker Compose
                  // card below; a raw Compose source tab would only discard the
                  // template's expose/exposes/mounts/autoDomain metadata.
                  (tab) => tab.id !== "compose" || !isTemplate,
                ).map((tab) => {
                  const Icon = tab.icon;
                  return (
                    <Button
                      key={tab.id}
                      type="button"
                      variant={source === tab.id ? "default" : "outline"}
                      size="sm"
                      onClick={() => onSourceChange(tab.id)}
                    >
                      <Icon className="size-4" />
                      {tab.label}
                    </Button>
                  );
                })}
              </div>

              {source === "github" &&
                (installations.length === 0 ? (
                  <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-6 text-center">
                    <GitHubIcon className="size-6 text-muted-foreground" />
                    <div className="space-y-1">
                      <p className="text-sm font-medium">Connect GitHub to import a repo</p>
                      <p className="text-xs text-muted-foreground">
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
                      if (sel && !name) {
                        setName(sel.fullName.split("/")[1] ?? "");
                      }
                    }}
                  />
                ))}

              {source === "git" && (
                <div className="space-y-2">
                  <FieldLabel
                    htmlFor="repo"
                    info={
                      <>
                        HTTPS URL of a public repo — GitHub, GitLab or
                        Bitbucket. A bare{" "}
                        <code className="font-mono">owner/repo</code> is treated
                        as GitHub
                      </>
                    }
                  >
                    Repository URL
                  </FieldLabel>
                  <div className="relative">
                    <GitHubIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="repo"
                      value={repoUrl}
                      onChange={(e) => onRepoChange(e.target.value)}
                      placeholder="https://github.com/acme/my-app"
                      className="pl-9 font-mono text-sm"
                    />
                  </div>
                </div>
              )}

              {source === "docker-image" && (
                <div className="space-y-2">
                  <FieldLabel
                    htmlFor="image"
                    info={
                      <>
                        Pulls a prebuilt image from any registry. No build step
                        runs. Start typing to search; add{" "}
                        <code className="font-mono">:</code> for tags.
                      </>
                    }
                  >
                    Docker image
                  </FieldLabel>
                  <ImageInput
                    id="image"
                    value={dockerImage}
                    onChange={setDockerImage}
                  />
                </div>
              )}

              {source === "upload" && (
                <UploadInput onSelect={setUploadFile} />
              )}

              {source === "compose" && (
                <div className="space-y-2">
                  <ComposeEditor
                    value={compose}
                    onChange={setCompose}
                    onDiagnostics={setComposeDiags}
                    minHeight={300}
                  />
                  <ComposeLintSummary diagnostics={composeDiags} />
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* 3. Target server  pick where this runs, after choosing the source. */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ServerIcon className="size-4" />
              Deploy to
            </CardTitle>
            <CardDescription>
              Choose which server runs this {isTemplate ? "template" : "app"}.
              The master is the host running Deplo; remote servers appear here
              once connected.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Select value={serverId} onValueChange={setServerId}>
              <SelectTrigger className="max-w-md">
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
          </CardContent>
        </Card>

        {/* Templates carry their compose stack (source is docker-image, mapped to
            templateCompose), so their editor lives in its own card here. The
            from-scratch "compose" source renders the editor inline in the source
            card above instead. */}
        {templateCompose && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="size-4" />
                Docker Compose
              </CardTitle>
              <CardDescription>
                The stack Deplo will deploy. Edit it directly to customise images,
                ports, volumes or services before deploying.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <ComposeEditor
                value={compose}
                onChange={setCompose}
                onDiagnostics={setComposeDiags}
                minHeight={300}
              />
              <ComposeLintSummary diagnostics={composeDiags} />
            </CardContent>
          </Card>
        )}

        {isTemplate && (
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
              <div className="space-y-1.5">
                <CardTitle>Environment variables</CardTitle>
                <CardDescription>
                  Referenced as <code className="font-mono">{"${VAR}"}</code> in the
                  compose file. Generated secrets are prefilled; edit as needed.
                </CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setEnvRows((rows) => [...rows, { key: "", value: "" }])}
              >
                <Plus className="size-4" />
                Add
              </Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {envRows.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No variables. Add one if your compose file needs it.
                </p>
              )}
              {envRows.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={row.key}
                    onChange={(e) =>
                      setEnvRows((rows) =>
                        rows.map((r, j) =>
                          j === i ? { ...r, key: e.target.value } : r,
                        ),
                      )
                    }
                    placeholder="KEY"
                    className="font-mono text-xs sm:max-w-[40%]"
                  />
                  <Input
                    value={row.value}
                    onChange={(e) =>
                      setEnvRows((rows) =>
                        rows.map((r, j) =>
                          j === i ? { ...r, value: e.target.value } : r,
                        ),
                      )
                    }
                    placeholder="value"
                    className="flex-1 font-mono text-xs"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove variable"
                    onClick={() =>
                      setEnvRows((rows) => rows.filter((_, j) => j !== i))
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

      </div>

      {/* Right rail: an at-a-glance summary + the primary deploy action,
          sticky on desktop so the button stays reachable while scrolling. On
          mobile it drops below the config cards (natural bottom-of-form spot). */}
      <aside className="h-fit space-y-4 lg:sticky lg:top-20">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="space-y-2.5 text-sm">
              <div className="flex items-center gap-3">
                <dt className="shrink-0 text-muted-foreground">Name</dt>
                <dd className="min-w-0 flex-1 truncate text-right font-medium">
                  {name || "—"}
                </dd>
              </div>
              <div className="flex items-center gap-3">
                <dt className="shrink-0 text-muted-foreground">Source</dt>
                <dd className="min-w-0 flex-1 truncate text-right font-medium">
                  {sourceLabel}
                </dd>
              </div>
              <div className="flex items-center gap-3">
                <dt className="shrink-0 text-muted-foreground">Server</dt>
                <dd className="min-w-0 flex-1 truncate text-right font-medium">
                  {serverSummary}
                </dd>
              </div>
              <div className="flex items-center gap-3">
                <dt className="shrink-0 text-muted-foreground">Domain</dt>
                <dd className="min-w-0 flex-1 truncate text-right font-medium">
                  {domainSummary}
                </dd>
              </div>
              {/* Where it lands — so creating from inside a folder/environment
                  visibly stays there instead of silently going top level. */}
              <div className="flex items-center gap-3">
                <dt className="shrink-0 text-muted-foreground">Location</dt>
                <dd className="min-w-0 flex-1 truncate text-right font-medium">
                  {placement?.label ?? "Overview"}
                </dd>
              </div>
            </dl>

            <Badge variant="outline" className="w-full justify-center gap-1.5">
              <Check className="size-3 text-[var(--success)]" />
              Docker + Traefik configured
            </Badge>

            {locked && (
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="w-full"
                onClick={() => setEditing(true)}
              >
                <Pencil className="size-4" />
                Edit
              </Button>
            )}
            <Button
              onClick={deploy}
              disabled={pending}
              size="lg"
              className="w-full"
            >
              <Rocket className="size-4" />
              {pending ? "Deploying…" : "Deploy"}
            </Button>
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
