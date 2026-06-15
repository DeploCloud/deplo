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
  FileCode2,
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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
import { SimpleTooltip } from "@/components/ui/tooltip";
import { FRAMEWORK_LIST, FRAMEWORKS, buildConfigFor } from "@/lib/frameworks";
import type { DeploySource, FrameworkId } from "@/lib/types";
import { createProjectAction } from "@/lib/actions/projects";
import { cn, serverLabel } from "@/lib/utils";

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
  { id: "dockerfile", label: "Dockerfile", icon: FileCode2 },
  { id: "upload", label: "Upload", icon: Upload },
];

export function NewProjectWizard({
  servers,
  template,
  presetRepo,
  presetName,
}: {
  servers: WizardServer[];
  template?: WizardTemplate;
  presetRepo?: string;
  presetName?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const isTemplate = Boolean(template);
  // Templates start in a locked summary view. "Edit template" unlocks the full
  // source/framework/build configuration so the user can tweak before deploying.
  const [editing, setEditing] = React.useState(false);
  const locked = isTemplate && !editing;

  const defaultServerId =
    servers.find((s) => s.type === "localhost")?.id ?? servers[0]?.id ?? "";

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

  // Template-only: editable docker-compose and environment variables.
  const [compose, setCompose] = React.useState(template?.compose ?? "");
  const [envRows, setEnvRows] = React.useState<{ key: string; value: string }[]>(
    template?.env ?? [],
  );

  const preset = FRAMEWORKS[framework];
  const usesGit =
    source === "github" || source === "git" || source === "dockerfile";

  function onRepoChange(value: string) {
    setRepoUrl(value);
    const parsed = parseRepo(value);
    if (parsed && source !== "dockerfile") {
      const guessed = guessFramework(parsed.repo);
      setDetected(guessed);
      applyFramework(guessed);
      if (!name) setName(parsed.repo.split("/")[1] ?? "");
    } else {
      setDetected(null);
      if (parsed && !name) setName(parsed.repo.split("/")[1] ?? "");
    }
  }

  function applyFramework(fw: FrameworkId) {
    setFramework(fw);
    setBuild((b) => ({
      ...buildConfigFor(fw),
      rootDirectory: b.rootDirectory,
    }));
  }

  function onSourceChange(next: DeploySource) {
    setSource(next);
    setDetected(null);
    if (next === "docker-image" || next === "dockerfile") {
      applyFramework("docker");
    }
  }

  function deploy() {
    if (!name.trim()) {
      toast.error("Enter a project name");
      return;
    }
    if (!serverId) {
      toast.error("Select a server to deploy to");
      return;
    }

    let repo = null as null | {
      provider: "github" | "gitlab" | "bitbucket" | "git";
      url: string;
      repo: string;
      branch: string;
    };
    let image: string | null = null;
    let projectFramework = framework;

    if (source === "github" || source === "git") {
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
    } else if (source === "dockerfile") {
      const parsed = parseRepo(repoUrl);
      if (!parsed) {
        toast.error("Enter the repository that contains your Dockerfile");
        return;
      }
      projectFramework = "docker";
      repo = {
        provider: parsed.provider,
        url: repoUrl.startsWith("http")
          ? repoUrl
          : `https://github.com/${parsed.repo}`,
        repo: parsed.repo,
        branch: branch || "main",
      };
    } else if (source === "docker-image") {
      projectFramework = "docker";
      if (!isTemplate && !dockerImage.trim()) {
        toast.error("Enter a Docker image reference");
        return;
      }
      image = isTemplate ? null : dockerImage.trim();
    } else if (source === "upload") {
      // Upload: a code archive is attached after creation; no repo/image.
    }

    startTransition(async () => {
      const res = await createProjectAction({
        name: name.trim(),
        framework: projectFramework,
        source,
        serverId,
        dockerImage: image,
        compose: isTemplate ? compose : null,
        env: isTemplate
          ? envRows.filter((e) => e.key.trim())
          : undefined,
        repo,
        build: {
          installCommand: build.installCommand,
          buildCommand: build.buildCommand,
          outputDirectory: build.outputDirectory,
          startCommand: build.startCommand,
          rootDirectory: build.rootDirectory,
          nodeVersion: build.nodeVersion,
          port: build.port,
        },
        autoDeploy: usesGit ? autoDeploy : false,
      });
      if (res.ok && res.data) {
        toast.success("Project created  deploying…");
        router.push(`/projects/${res.data.slug}`);
      } else if (!res.ok) {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="space-y-6">
      {/* Target server  front and centre, especially for templates. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ServerIcon className="size-4" />
            Deploy to
          </CardTitle>
          <CardDescription>
            Choose which server runs this {isTemplate ? "template" : "project"}.
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
        </CardContent>
      </Card>

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
              {SOURCE_TABS.map((tab) => {
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

            {(source === "github" ||
              source === "git" ||
              source === "dockerfile") && (
              <div className="space-y-2">
                <Label htmlFor="repo">
                  {source === "dockerfile"
                    ? "Repository containing the Dockerfile"
                    : "Repository URL"}
                </Label>
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
                {detected && source !== "dockerfile" && (
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
                <div className="relative">
                  <Container className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="image"
                    value={dockerImage}
                    onChange={(e) => setDockerImage(e.target.value)}
                    placeholder="ghcr.io/acme/app:latest"
                    className="pl-9 font-mono text-sm"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Pulls a prebuilt image from any registry. No build step runs.
                </p>
              </div>
            )}

            {source === "upload" && (
              <div className="rounded-lg border border-dashed border-border p-6 text-center">
                <Upload className="mx-auto mb-2 size-6 text-muted-foreground" />
                <p className="text-sm">
                  Create the project, then upload a code archive from the
                  project page to trigger the first build.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {isTemplate && (
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
          <CardContent>
            <Textarea
              value={compose}
              onChange={(e) => setCompose(e.target.value)}
              spellCheck={false}
              rows={14}
              className="font-mono text-xs leading-relaxed"
              placeholder="services:&#10;  app:&#10;    image: ..."
            />
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

      {/* Configure */}
      <Card>
        <CardHeader>
          <CardTitle>Configure Project</CardTitle>
          <CardDescription>
            Review the settings. Override anything you need.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">Project Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-app"
              />
            </div>
            {usesGit && (
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

          {!locked && source !== "docker-image" && (
            <div className="space-y-2">
              <Label>Framework Preset</Label>
              <Select
                value={framework}
                onValueChange={(v) => applyFramework(v as FrameworkId)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FRAMEWORK_LIST.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      <span className="flex items-center gap-2">
                        <FrameworkGlyph framework={f.id} />
                        {f.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {preset.description}
              </p>
            </div>
          )}

          {/* Advanced build settings  only relevant when Deplo builds the app. */}
          {!locked && source !== "docker-image" && (
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
                <div className="grid gap-4 rounded-lg border border-border p-4 sm:grid-cols-2">
                  <BuildField
                    label="Root Directory"
                    tooltip="Directory in the repo where your app lives."
                    value={build.rootDirectory}
                    onChange={(v) =>
                      setBuild((b) => ({ ...b, rootDirectory: v }))
                    }
                  />
                  <BuildField
                    label="Node.js Version"
                    tooltip="Runtime version used for the build container."
                    value={build.nodeVersion}
                    onChange={(v) =>
                      setBuild((b) => ({ ...b, nodeVersion: v }))
                    }
                  />
                  <BuildField
                    label="Install Command"
                    tooltip="Command to install dependencies."
                    value={build.installCommand}
                    onChange={(v) =>
                      setBuild((b) => ({ ...b, installCommand: v }))
                    }
                  />
                  <BuildField
                    label="Build Command"
                    tooltip="Command that produces the production build."
                    value={build.buildCommand}
                    onChange={(v) =>
                      setBuild((b) => ({ ...b, buildCommand: v }))
                    }
                  />
                  <BuildField
                    label="Output Directory"
                    tooltip="Directory containing the build output."
                    value={build.outputDirectory}
                    onChange={(v) =>
                      setBuild((b) => ({ ...b, outputDirectory: v }))
                    }
                  />
                  <BuildField
                    label="Start Command"
                    tooltip="Command to run the server (leave empty for static)."
                    value={build.startCommand}
                    onChange={(v) =>
                      setBuild((b) => ({ ...b, startCommand: v }))
                    }
                  />
                  <div className="space-y-2">
                    <Label>Container Port</Label>
                    <Input
                      type="number"
                      value={build.port}
                      onChange={(e) =>
                        setBuild((b) => ({
                          ...b,
                          port: Number(e.target.value) || 3000,
                        }))
                      }
                    />
                  </div>
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
                    Deploy on every push to {branch || "main"}.
                  </p>
                </div>
              </div>
              <Switch checked={autoDeploy} onCheckedChange={setAutoDeploy} />
            </div>
          )}
        </CardContent>
      </Card>

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

function BuildField({
  label,
  tooltip,
  value,
  onChange,
}: {
  label: string;
  tooltip: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-2">
      <SimpleTooltip content={tooltip}>
        <Label className="cursor-help underline decoration-dotted underline-offset-4">
          {label}
        </Label>
      </SimpleTooltip>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-xs"
      />
    </div>
  );
}
