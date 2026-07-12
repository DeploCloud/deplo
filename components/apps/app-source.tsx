import * as React from "react";
import { GitBranch, Layers, Container, Package } from "lucide-react";
import { GitHubIcon } from "@/components/shared/brand-icons";
import { usesComposeStack } from "@/lib/utils";
import type { GitRepo } from "@/lib/types";

/** The project fields needed to identify its source. Structurally satisfied by
 *  both `App` and `AppSummary`. */
export type AppSourceLike = {
  source: string;
  compose: string | null;
  repo: GitRepo | null;
  dockerImage: string | null;
};

export interface AppSourceDescriptor {
  /** Icon component (lucide or a brand glyph) — render as `<Icon className=… />`. */
  Icon: React.ComponentType<{ className?: string }>;
  /** Short human label for what backs the app (repo, "Compose", image, …). */
  label: string;
  /**
   * True ONLY for a git-backed source (github / plain git), where a branch and
   * commit are meaningful. A compose stack, a docker image or an uploaded
   * archive has no git — so the UI must not invent a branch for it. This is the
   * single source of truth the app card AND the app overview share, so
   * they can never disagree about what an app's source is.
   */
  isGit: boolean;
}

/**
 * Describe where an app's code/image comes from, for display. `compose` is
 * authoritative first (via {@link usesComposeStack}, which also catches legacy
 * template apps), then a real git repo, then docker-image / upload, then a
 * generic container fallback.
 */
export function describeAppSource(
  project: AppSourceLike,
): AppSourceDescriptor {
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
