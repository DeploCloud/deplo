"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Save,
  Trash2,
  GitBranch,
  Container,
  FileText,
  Upload,
  Image as ImageIcon,
  Server as ServerIcon,
} from "lucide-react";
import { GitHubIcon } from "@/components/shared/brand-icons";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ComposeEditor } from "@/components/projects/compose-editor";
import { ComposeLintSummary } from "@/components/projects/compose-lint-summary";
import { FullComposeDialog } from "@/components/projects/full-compose-dialog";
import { ImageInput } from "@/components/projects/image-input";
import { ProjectLogo } from "@/components/shared/project-logo";
import {
  LOGO_ACCEPT_ATTR,
  LOGO_IMAGE_TYPES,
  MAX_LOGO_BYTES,
} from "@/lib/projects/logo-shared";
import {
  GithubRepoPicker,
  type GithubSelection,
} from "@/components/projects/github-repo-picker";
import { GithubConnectButton } from "@/components/projects/github-connect-button";
import { UploadInput, type CurrentUpload } from "@/components/projects/upload-input";
import { hasBlockingErrors, type LintDiagnostic } from "@/lib/deploy/compose-lint";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmAction } from "@/components/shared/confirm-action";
import {
  BuildConfigFields,
  applyFrameworkToBuild,
} from "@/components/projects/build-config-fields";
import type { GithubInstallationDTO } from "@/lib/data/github";
import type {
  BuildConfig,
  DeploySource,
  FrameworkId,
  GitRepo,
} from "@/lib/types";
import { formatBytes, serverLabel, usesComposeStack } from "@/lib/utils";
import { useRouter } from "next/navigation";
import { gqlAction } from "@/lib/graphql-client";

export interface SettingsServer {
  id: string;
  name: string;
  type: "localhost" | "remote";
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

export function BuildSettingsForm({
  projectId,
  slug,
  name: initialName,
  logo: initialLogo,
  framework: initialFramework,
  build: initialBuild,
  autoDeploy: initialAutoDeploy,
  source: initialSource,
  repo: initialRepo,
  dockerImage: initialDockerImage,
  upload: initialUpload,
  compose: initialCompose,
  expose,
  exposes,
  serverId: initialServerId,
  servers,
  installations,
}: {
  projectId: string;
  slug: string;
  name: string;
  logo: string | null;
  framework: FrameworkId;
  build: BuildConfig;
  autoDeploy: boolean;
  source: DeploySource;
  repo: GitRepo | null;
  dockerImage: string | null;
  upload: CurrentUpload | null;
  compose: string | null;
  expose: { service: string; port: number } | null;
  exposes: { service: string; port: number; host?: string }[] | null;
  serverId: string;
  servers: SettingsServer[];
  installations: GithubInstallationDTO[];
}) {
  const router = useRouter();
  const [name, setName] = React.useState(initialName);
  // Logo is stored inline as a base64 image data-URI (or a template's local
  // /templates path). `null` ⇒ no logo (framework icon). The picker reads a file
  // and converts it to a data-URI before saving, so nothing is fetched remotely.
  const [logo, setLogo] = React.useState<string | null>(initialLogo);
  const logoInputRef = React.useRef<HTMLInputElement>(null);
  const [framework, setFramework] = React.useState<FrameworkId>(initialFramework);
  const [build, setBuild] = React.useState<BuildConfig>(initialBuild);
  const [autoDeploy, setAutoDeploy] = React.useState(initialAutoDeploy);
  const [pending, startTransition] = React.useTransition();

  // Compose stack (template / multi-service deploys). Lives as a source tab.
  const [compose, setCompose] = React.useState(initialCompose ?? "");
  const [composeDiags, setComposeDiags] = React.useState<LintDiagnostic[]>([]);

  // Source state. Legacy template projects were stored as `docker-image` with a
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

  function applyFramework(fw: FrameworkId) {
    setFramework(fw);
    setBuild((b) => applyFrameworkToBuild(b, fw));
  }

  function saveName() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $name: String!) { renameProject(id: $id, name: $name) { id } }`,
        { id: projectId, name },
      );
      if (res.ok) {
        router.refresh();
        toast.success("Project renamed");
      } else toast.error(res.error);
    });
  }

  // Read a picked image into a base64 data-URI and persist it as the logo. The
  // image is validated (type + size) before reading so we never inline an
  // oversized blob into the project document.
  function pickLogo(file: File) {
    if (!LOGO_IMAGE_TYPES.includes(file.type as (typeof LOGO_IMAGE_TYPES)[number])) {
      toast.error("Unsupported image — use PNG, JPEG, WebP, GIF or SVG");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error(`Image too large (max ${formatBytes(MAX_LOGO_BYTES)})`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = typeof reader.result === "string" ? reader.result : "";
      if (!dataUri) {
        toast.error("Could not read image");
        return;
      }
      setLogo(dataUri);
      startTransition(async () => {
        const res = await gqlAction(
          `mutation($id: String!, $logo: String) { updateProjectLogo(id: $id, logo: $logo) { id } }`,
          { id: projectId, logo: dataUri },
        );
        if (res.ok) {
          router.refresh();
          toast.success("Logo updated");
        } else toast.error(res.error);
      });
    };
    reader.onerror = () => toast.error("Could not read image");
    reader.readAsDataURL(file);
  }

  function clearLogo() {
    setLogo(null);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $logo: String) { updateProjectLogo(id: $id, logo: $logo) { id } }`,
        { id: projectId, logo: null },
      );
      if (res.ok) {
        router.refresh();
        toast.success("Logo cleared");
      } else toast.error(res.error);
    });
  }

  function saveSource() {
    // The Upload source is committed by the upload control (its own route),
    // not by this form — and saving source=upload with no archive would break
    // the next deploy. Block it here so the button can't strand the project.
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
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $input: UpdateSourceInput!) { updateProjectSource(id: $id, input: $input) { id } }`,
        {
          id: projectId,
          input: {
            source,
            serverId,
            dockerImage: image,
            repo,
            compose: source === "compose" ? compose : undefined,
            expose: expose
              ? { service: expose.service, port: expose.port }
              : null,
            exposes: exposes ?? null,
          },
        },
      );
      if (res.ok) {
        router.refresh();
        toast.success("Deploy source saved");
      } else toast.error(res.error);
    });
  }

  function saveBuild() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $build: BuildConfigInput!) { updateProjectBuild(id: $id, build: $build) { id } }`,
        {
          id: projectId,
          build: {
            framework,
            buildMethod: build.buildMethod,
            settings: build.methodSettings,
            installCommand: build.installCommand,
            buildCommand: build.buildCommand,
            outputDir: build.outputDirectory,
            startCommand: build.startCommand,
            rootDir: build.rootDirectory,
            runtimeVersion: build.runtimeVersion,
            port: build.port,
          },
        },
      );
      if (res.ok) {
        router.refresh();
        toast.success("Build settings saved");
      } else toast.error(res.error);
    });
  }

  function toggleAuto(v: boolean) {
    setAutoDeploy(v);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $value: Boolean!) { setProjectAutoDeploy(id: $id, value: $value) { id } }`,
        { id: projectId, value: v },
      );
      if (res.ok) router.refresh();
      else toast.error(res.error);
    });
  }

  return (
    <div className="space-y-6">
      {/* General */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">General</CardTitle>
          <CardDescription>The display name for your project.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-w-md space-y-2">
            <Label>Project Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </CardContent>
        <CardFooter className="justify-end border-t border-border pt-4">
          <Button size="sm" onClick={saveName} disabled={pending}>
            <Save className="size-4" />
            Save
          </Button>
        </CardFooter>
      </Card>

      {/* Branding / logo */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Logo</CardTitle>
          <CardDescription>
            The image shown for this project on the dashboard. Deployed from a
            template? It defaults to the template&apos;s logo. Upload an image to
            change it, or remove it to fall back to the framework icon.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <ProjectLogo logo={logo} framework={framework} size={48} />
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => logoInputRef.current?.click()}
                disabled={pending}
              >
                <ImageIcon className="size-4" />
                {logo ? "Replace image" : "Upload image"}
              </Button>
              {logo && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={clearLogo}
                  disabled={pending}
                >
                  Remove
                </Button>
              )}
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            PNG, JPEG, WebP, GIF or SVG · up to {formatBytes(MAX_LOGO_BYTES)}.
            Saved as soon as you pick a file.
          </p>
          <input
            ref={logoInputRef}
            type="file"
            accept={LOGO_ACCEPT_ATTR}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) pickLogo(file);
              e.target.value = "";
            }}
          />
        </CardContent>
      </Card>

      {/* Deploy source */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Deploy Source</CardTitle>
          <CardDescription>
            Change how this project is deployed and which server runs it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {SOURCE_TABS.map((tab) => {
              const Icon = tab.icon;
              return (
                <Button
                  key={tab.id}
                  type="button"
                  variant={source === tab.id ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setSource(tab.id);
                    if (tab.id === "docker-image") applyFramework("docker");
                  }}
                >
                  <Icon className="size-4" />
                  {tab.label}
                </Button>
              );
            })}
          </div>

          {usesGithubApp &&
            (installations.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-6 text-center">
                <GitHubIcon className="size-6 text-muted-foreground" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    Connect GitHub to pick a repo
                  </p>
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
            ))}

          {usesGitUrl && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Repository URL</Label>
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
                <Label>Production Branch</Label>
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

          {source === "docker-image" && (
            <div className="space-y-2">
              <Label>Docker image</Label>
              <ImageInput value={dockerImage} onChange={setDockerImage} />
              <p className="text-xs text-muted-foreground">
                Start typing to search registries; add{" "}
                <code className="font-mono">:</code> to pick a tag. A green check
                confirms the image exists.
              </p>
            </div>
          )}

          {source === "upload" && (
            <UploadInput
              projectId={projectId}
              slug={slug}
              current={initialUpload}
            />
          )}

          {source === "compose" && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="flex items-center gap-1.5">
                  <FileText className="size-3.5" />
                  docker-compose.yml
                </Label>
                <FullComposeDialog projectId={projectId} />
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
            <Label className="flex items-center gap-1.5">
              <ServerIcon className="size-3.5" />
              Server
            </Label>
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
                      {s.type === "remote" && (
                        <Badge variant="secondary" className="ml-1">
                          remote
                        </Badge>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
        <CardFooter className="justify-end border-t border-border pt-4">
          <Button size="sm" onClick={saveSource} disabled={pending}>
            <Save className="size-4" />
            Save source
          </Button>
        </CardFooter>
      </Card>

      {/* Build & Output */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Build &amp; Output Settings</CardTitle>
          <CardDescription>
            How Deplo installs, builds and runs your app inside Docker.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BuildConfigFields
            build={build}
            framework={framework}
            onBuildChange={setBuild}
            onFrameworkChange={applyFramework}
          />
        </CardContent>
        <CardFooter className="justify-end border-t border-border pt-4">
          <Button size="sm" onClick={saveBuild} disabled={pending}>
            <Save className="size-4" />
            Save build settings
          </Button>
        </CardFooter>
      </Card>

      {/* Git / auto deploy */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Git</CardTitle>
          <CardDescription>Automatic deployment behaviour.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium">Automatic deployments</p>
              <p className="text-xs text-muted-foreground">
                Deploy automatically on every push to the production branch.
              </p>
            </div>
            <Switch checked={autoDeploy} onCheckedChange={toggleAuto} disabled={pending} />
          </div>
        </CardContent>
      </Card>

      {/* Danger zone */}
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-base text-destructive">Danger Zone</CardTitle>
          <CardDescription>
            Permanently delete this project and all of its data.
          </CardDescription>
        </CardHeader>
        <CardFooter className="justify-end">
          <ConfirmAction
            trigger={
              <Button variant="destructive" size="sm">
                <Trash2 className="size-4" />
                Delete Project
              </Button>
            }
            title={`Delete ${initialName}?`}
            description="This permanently removes the project, deployments, domains and environment variables. This cannot be undone."
            confirmLabel="Delete project"
            onConfirm={async () => {
              const res = await gqlAction(
                `mutation($id: String!) { deleteProject(id: $id) }`,
                { id: projectId },
              );
              if (res.ok) router.push("/");
              return res;
            }}
          />
        </CardFooter>
      </Card>
    </div>
  );
}
