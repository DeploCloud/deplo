import * as React from "react";
import { GitBranch, Layers, Container, Package } from "lucide-react";
import { GitHubIcon } from "@/components/shared/brand-icons";
import { usesComposeStack } from "@/lib/utils";
import type { GitRepo } from "@/lib/types/build";

export type AppSourceLike = {
  source: string;
  compose: string | null;
  repo: GitRepo | null;
  dockerImage: string | null;
};

export interface AppSourceDescriptor {
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
  isGit: boolean;
}

export function describeAppSource(project: AppSourceLike): AppSourceDescriptor {
  if (usesComposeStack(project)) {
    return { Icon: Layers, label: "Compose", isGit: false };
  }
  if (project.repo) {
    const Icon = project.source === "github" ? GitHubIcon : GitBranch;
    return {
      Icon,
      label: project.repo.repo || project.repo.url,
      isGit: true,
    };
  }
  if (project.source === "docker-image") {
    return {
      Icon: Container,
      label: project.dockerImage || "Docker image",
      isGit: false,
    };
  }
  if (project.source === "upload") {
    return { Icon: Package, label: "Upload", isGit: false };
  }
  return { Icon: Container, label: "Container", isGit: false };
}
