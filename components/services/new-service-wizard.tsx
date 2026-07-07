"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  GitBranch,
  Sparkles,
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
import { ComposeEditor } from "@/components/services/compose-editor";
import { ComposeLintSummary } from "@/components/services/compose-lint-summary";
import { ImageInput } from "@/components/services/image-input";
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
import { FrameworkGlyph } from "@/components/shared/framework-icon";
import {
  BuildConfigFields,
  applyFrameworkToBuild,
} from "@/components/services/build-config-fields";
import { FRAMEWORKS, buildConfigFor } from "@/lib/frameworks";
import type { DeploySource, FrameworkId } from "@/lib/types";
import { deploySourceEnumName } from "@/lib/types";
import { gqlAction } from "@/lib/graphql-client";
import { cn, serverLabel } from "@/lib/utils";
import { GithubRepoPicker, type GithubSelection } from "@/components/services/github-repo-picker";
import { GithubConnectButton } from "@/components/services/github-connect-button";
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

/** Lightweight client-side repo -> framework heuristic (Vercel-style guess). */
function guessFramework(repo: string): FrameworkId {
  const r = repo.toLowerCase();
  const pairs: [string, FrameworkId][] = [
    ["sveltekit", "sveltekit"],
    ["svelte", "svelte"],
    ["astro", "astro"],
    ["nuxt", "nuxt"],
    ["remix", "remix"],
    ["gatsby", "gatsby"],
    ["angular", "angular"],
    ["vue", "vue"],
    ["next", "nextjs"],
    ["react", "react"],
    ["vite", "vite"],
    ["django", "python"],
    ["flask", "python"],
    ["fastapi", "python"],
    ["rust", "rust"],
    ["golang", "go"],
    ["php", "php"],
    ["laravel", "php"],
  ];
  for (const [k, v] of pairs) if (r.includes(k)) return v;
  return "nextjs";
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

export function NewServiceWizard({
  servers,
  template,
  presetRepo,
  presetName,
  installations,
}: {
  servers: WizardServer[];
  template?: WizardTemplate;
  presetRepo?: string;
  presetName?: string;
  installations: GithubInstallationDTO[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const isTemplate = Boolean(template);
  const [ghSelection, setGhSelection] = React.useState<GithubSelection | null>(
    null,
  );
  // Templates start in a locked summary view. "Edit template" unlocks the full
  // source/framework/build configuration so the user can tweak before deploying.
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
  const [name, setName] = React.useState(presetName ?? template?.name ?? "");
  const [branch, setBranch] = React.useState("main");
  const [framework, setFramework] = React.useState<FrameworkId>(
    isTemplate ? "docker" : "nextjs",
  );
  const [detected, setDetected] = React.useState<FrameworkId | null>(null);
  const [autoDeploy, setAutoDeploy] = React.useState(true);
  const [advanced, setAdvanced] = React.useState(false);
  const [build, setBuild] = React.useState(() =>
    buildConfigFor(isTemplate ? "docker" : "nextjs"),
  );

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
    if (parsed) {
      const guessed = guessFramework(parsed.repo);
      setDetected(guessed);
      applyFramework(guessed);
      if (!name) setName(parsed.repo.split("/")[1] ?? "");
    } else {
      setDetected(null);
    }
  }

  function applyFramework(fw: FrameworkId) {
    setFramework(fw);
    setBuild((b) => applyFrameworkToBuild(b, fw));
  }

  function onSourceChange(next: DeploySource) {
    setSource(next);
    setDetected(null);
    if (next === "docker-image") applyFramework("docker");
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
      toast.error("Enter a service name");
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
    };
    let image: string | null = null;
    let serviceFramework = framework;

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
      serviceFramework = "docker";
      if (!isTemplate && !dockerImage.trim()) {
        toast.error("Enter a Docker image reference");
        return;
      }
      image = isTemplate ? null : dockerImage.trim();
    } else if (source === "compose") {
      // Hand-written stack: the engine auto-detects the service to expose, so no
      // expose/exposes metadata is sent (templates supply theirs separately).
      serviceFramework = "docker";
    } else if (source === "upload") {
      // Upload: a code archive is attached after creation; no repo/image.
    }

    // The build config only matters when Deplo builds an image. For a prebuilt
    // image or a compose stack the build section is hidden, so persisting the
    // editor's seed (e.g. nixpacks/bun) would land a misleading build method on
    // the service; send docker defaults instead so settings reflects reality.
    const payloadBuild = buildsImage ? build : buildConfigFor("docker");

    startTransition(async () => {
      const res = await gqlAction(
        `mutation($input: CreateServiceInput!) {
          createService(input: $input) { slug }
        }`,
        {
          input: {
            name: name.trim(),
            framework: serviceFramework,
            // A template deploying its own stack is stored as the `compose` source
            // so settings opens on the Compose tab and the deploy engine is
            // unambiguous.
            source: deploySourceEnumName(useCompose ? "compose" : source),
            serverId,
            dockerImage: image,
            // Seed the service's display logo from the template so a deployed
            // template carries its icon; editable later from service settings.
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
          },
        },
        (d: { createService: { slug: string } }) => d.createService,
      );
      if (res.ok && res.data) {
        // An upload project has no archive yet, so nothing deploys until the
        // user uploads one from Settings — don't claim it's deploying.
        toast.success(
          source === "upload"
            ? "Service created — upload an archive from Settings to deploy"
            : "Service created — deploying…",
        );
        router.push(`/services/${res.data.slug}`);
      } else if (!res.ok) {
        toast.error(res.error);
      }
    });
  }

  // Card order: configure the service first, then pick the source, then choose
  // which server runs it (3rd). Template-only compose/env follow afterwards.
  return (
    <div className="space-y-6">
      {/* 1. Configure */}
      <Card>
        <CardHeader>
          <CardTitle>Configure Service</CardTitle>
          <CardDescription>
            Review the settings. Override anything you need.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">Service Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-app"
              />
            </div>
            {usesGit && source !== "github" && (
              <div className="space-y-2">
                <Label htmlFor="branch">Production Branch</Label>
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
              service settings page shows, kept inside a collapse so creation
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
                  <BuildConfigFields
                    build={build}
                    framework={framework}
                    onBuildChange={setBuild}
                    onFrameworkChange={applyFramework}
                  />
                </div>
              )}
            </>
          )}

          {usesGit && (
            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div className="flex items-center gap-2">
                <FrameworkGlyph framework={framework} className="size-5" />
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
            <div className="flex size-12 items-center justify-center overflow-hidden rounded-lg border border-border bg-white p-2">
              {template!.logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={template!.logo}
                  alt={template!.name}
                  className="size-full object-contain"
                />
              ) : (
                <Container className="size-6 text-black" />
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
                  ? `Customising ${template!.name}. Change the source, framework or build before deploying.`
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
                      applyFramework(guessFramework(sel.fullName));
                    }
                  }}
                />
              ))}

            {source === "git" && (
              <div className="space-y-2">
                <Label htmlFor="repo">Repository URL</Label>
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
                {detected && (
                  <div className="flex items-center gap-1.5 text-xs text-[var(--success)]">
                    <Sparkles className="size-3.5" />
                    Detected framework: {FRAMEWORKS[detected].name}
                  </div>
                )}
              </div>
            )}

            {source === "docker-image" && (
              <div className="space-y-2">
                <Label htmlFor="image">Docker image</Label>
                <ImageInput
                  id="image"
                  value={dockerImage}
                  onChange={setDockerImage}
                />
                <p className="text-xs text-muted-foreground">
                  Pulls a prebuilt image from any registry. No build step runs.
                  Start typing to search; add <code className="font-mono">:</code>{" "}
                  for tags.
                </p>
              </div>
            )}

            {source === "upload" && (
              <div className="rounded-lg border border-dashed border-border p-6 text-center">
                <Upload className="mx-auto mb-2 size-6 text-muted-foreground" />
                <p className="text-sm">
                  Create the service, then upload a code archive from its
                  Settings page to trigger the first build.
                </p>
              </div>
            )}

            {source === "compose" && (
              <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
                Write your docker-compose stack in the Docker Compose editor
                below. Deplo deploys it as-is and routes it through Traefik.
              </p>
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
            Choose which server runs this {isTemplate ? "template" : "service"}.
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

      {useCompose && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="size-4" />
              Docker Compose
            </CardTitle>
            <CardDescription>
              {isTemplate
                ? "The stack Deplo will deploy. Edit it directly to customise images, ports, volumes or services before deploying."
                : "The stack Deplo will deploy. Deplo routes the first service that publishes a port through Traefik with automatic HTTPS."}
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

      <div className="flex items-center justify-end gap-2">
        <Badge variant="outline" className="mr-auto gap-1.5">
          <Check className="size-3 text-[var(--success)]" />
          Docker + Traefik configured
        </Badge>
        {locked && (
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={() => setEditing(true)}
          >
            <Pencil className="size-4" />
            Edit
          </Button>
        )}
        <Button onClick={deploy} disabled={pending} size="lg">
          <Rocket className="size-4" />
          {pending ? "Deploying…" : "Deploy"}
        </Button>
      </div>
    </div>
  );
}
