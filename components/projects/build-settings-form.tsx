"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Save,
  Trash2,
  GitBranch,
  Container,
  FileCode2,
  Upload,
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
import { FrameworkGlyph } from "@/components/shared/framework-icon";
import { FRAMEWORK_LIST, buildConfigFor } from "@/lib/frameworks";
import type { BuildConfig, DeploySource, FrameworkId, GitRepo } from "@/lib/types";
import { serverLabel } from "@/lib/utils";
import {
  updateBuildAction,
  setAutoDeployAction,
  renameProjectAction,
  deleteProjectAction,
  updateSourceAction,
} from "@/lib/actions/projects";

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
  { id: "dockerfile", label: "Dockerfile", icon: FileCode2 },
  { id: "upload", label: "Upload", icon: Upload },
];

export function BuildSettingsForm({
  projectId,
  name: initialName,
  framework: initialFramework,
  build: initialBuild,
  autoDeploy: initialAutoDeploy,
  source: initialSource,
  repo: initialRepo,
  dockerImage: initialDockerImage,
  serverId: initialServerId,
  servers,
}: {
  projectId: string;
  name: string;
  framework: FrameworkId;
  build: BuildConfig;
  autoDeploy: boolean;
  source: DeploySource;
  repo: GitRepo | null;
  dockerImage: string | null;
  serverId: string;
  servers: SettingsServer[];
}) {
  const [name, setName] = React.useState(initialName);
  const [framework, setFramework] = React.useState<FrameworkId>(initialFramework);
  const [build, setBuild] = React.useState<BuildConfig>(initialBuild);
  const [autoDeploy, setAutoDeploy] = React.useState(initialAutoDeploy);
  const [pending, startTransition] = React.useTransition();

  // Source state
  const [source, setSource] = React.useState<DeploySource>(initialSource);
  const [serverId, setServerId] = React.useState(initialServerId);
  const [repoUrl, setRepoUrl] = React.useState(initialRepo?.url ?? "");
  const [branch, setBranch] = React.useState(initialRepo?.branch ?? "main");
  const [dockerImage, setDockerImage] = React.useState(initialDockerImage ?? "");

  const usesGit = source === "github" || source === "git" || source === "dockerfile";

  function applyFramework(fw: FrameworkId) {
    setFramework(fw);
    setBuild((b) => ({ ...buildConfigFor(fw), rootDirectory: b.rootDirectory }));
  }

  function saveName() {
    startTransition(async () => {
      const res = await renameProjectAction(projectId, name);
      if (res.ok) toast.success("Project renamed");
      else toast.error(res.error);
    });
  }

  function saveSource() {
    let repo: GitRepo | null = null;
    if (usesGit) {
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
    startTransition(async () => {
      const res = await updateSourceAction(projectId, {
        source,
        serverId,
        dockerImage: image,
        repo,
      });
      if (res.ok) toast.success("Deploy source saved");
      else toast.error(res.error);
    });
  }

  function saveBuild() {
    startTransition(async () => {
      const res = await updateBuildAction(projectId, {
        framework,
        installCommand: build.installCommand,
        buildCommand: build.buildCommand,
        outputDirectory: build.outputDirectory,
        startCommand: build.startCommand,
        rootDirectory: build.rootDirectory,
        nodeVersion: build.nodeVersion,
        port: build.port,
      });
      if (res.ok) toast.success("Build settings saved");
      else toast.error(res.error);
    });
  }

  function toggleAuto(v: boolean) {
    setAutoDeploy(v);
    startTransition(async () => {
      const res = await setAutoDeployAction(projectId, v);
      if (!res.ok) toast.error(res.error);
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
                    if (tab.id === "docker-image" || tab.id === "dockerfile") {
                      applyFramework("docker");
                    }
                  }}
                >
                  <Icon className="size-4" />
                  {tab.label}
                </Button>
              );
            })}
          </div>

          {usesGit && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>
                  {source === "dockerfile"
                    ? "Repository (with Dockerfile)"
                    : "Repository URL"}
                </Label>
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
              <div className="relative">
                <Container className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={dockerImage}
                  onChange={(e) => setDockerImage(e.target.value)}
                  placeholder="ghcr.io/acme/app:latest"
                  className="pl-9 font-mono text-sm"
                />
              </div>
            </div>
          )}

          {source === "upload" && (
            <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
              This project deploys from uploaded archives. Upload a new build from
              the project page.
            </p>
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
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Framework Preset</Label>
              <Select value={framework} onValueChange={(v) => applyFramework(v as FrameworkId)}>
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
            </div>
            <Field label="Root Directory" value={build.rootDirectory} onChange={(v) => setBuild((b) => ({ ...b, rootDirectory: v }))} />
            <Field label="Install Command" value={build.installCommand} onChange={(v) => setBuild((b) => ({ ...b, installCommand: v }))} />
            <Field label="Build Command" value={build.buildCommand} onChange={(v) => setBuild((b) => ({ ...b, buildCommand: v }))} />
            <Field label="Output Directory" value={build.outputDirectory} onChange={(v) => setBuild((b) => ({ ...b, outputDirectory: v }))} />
            <Field label="Start Command" value={build.startCommand} onChange={(v) => setBuild((b) => ({ ...b, startCommand: v }))} />
            <Field label="Node.js Version" value={build.nodeVersion} onChange={(v) => setBuild((b) => ({ ...b, nodeVersion: v }))} />
            <div className="space-y-2">
              <Label>Container Port</Label>
              <Input
                type="number"
                value={build.port}
                onChange={(e) => setBuild((b) => ({ ...b, port: Number(e.target.value) || 3000 }))}
              />
            </div>
          </div>
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
            onConfirm={() => deleteProjectAction(projectId)}
          />
        </CardFooter>
      </Card>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-xs"
      />
    </div>
  );
}
