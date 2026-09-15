import { watchPathsToArray } from "@/components/apps/git-deploy-options";
import type { GitDeployOptionsValue } from "@/components/apps/git-deploy-options";
import type { GithubSelection } from "@/components/apps/github-repo-picker";
import type { GitSourceValue } from "@/components/apps/git-source-picker";
import type { DeploySource } from "@/lib/types/app";

export type SourceKeyInput = {
  source: DeploySource;
  serverId: string;
  gitValue: GitSourceValue;
  dockerImage: string;
  ghSelection: GithubSelection | null;
  compose: string;
  gitOptions: GitDeployOptionsValue;
};

export function normalizedGitOptions(o: GitDeployOptionsValue) {
  return {
    triggerType: o.triggerType,
    watchPaths: watchPathsToArray(o.watchPaths),
    submodules: o.submodules,
  };
}

export function computeSourceKey(s: SourceKeyInput): string {
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
    gitOptions: usesRepo ? normalizedGitOptions(s.gitOptions) : null,
  });
}
