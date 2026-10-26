import { deploySourceEnumName, type DeploySource } from "@/lib/types/app";
import type { NewRepo } from "@/lib/data/new-repos";

import { nameFromRepo } from "./new-app-wizard/source-hints";
import type { CreateAppVariables } from "./new-app-wizard/types";

// One click names only the repository; the server picks the server, build method and domain.
export function newRepoAppInput(repo: NewRepo): {
  source: DeploySource;
  input: CreateAppVariables;
} {
  const source: DeploySource = repo.installationId ? "github" : "git";
  return {
    source,
    input: {
      name: nameFromRepo(repo.fullName),
      source: deploySourceEnumName(source),
      repo: {
        provider: repo.provider,
        url: repo.url,
        repo: repo.fullName,
        branch: repo.defaultBranch,
        installationId: repo.installationId,
        connectionId: repo.connectionId,
      },
      folderId: null,
      projectId: null,
      environmentId: null,
    },
  };
}
