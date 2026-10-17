import "server-only";

import { resolveCloneUrl } from "../git/clone-url";
import { connectAgent } from "../infra/agent-client/connect";
import { agentPreflight } from "../infra/agent-client/preflight";
import type { GitRepo } from "../types/build";

export async function readGitCompose(
  serverId: string,
  repo: GitRepo,
  composePath: string,
  rootDirectory: string,
  branch: string,
  commit: string,
  publicCloneUrl?: string,
) {
  const hello = await agentPreflight(serverId);
  if (!hello.capabilities.includes("deploy.compose.git"))
    throw new Error("Update the server agent to deploy Compose files from Git");
  const clone = new URL(publicCloneUrl ?? (await resolveCloneUrl(repo)));
  const token = decodeURIComponent(clone.password);
  clone.username = "";
  clone.password = "";
  const source = {
    url: clone.toString(),
    token,
    branch,
    commit,
    subdir: rootDirectory,
  };
  const connection = await connectAgent(serverId);
  try {
    const result = await connection.readRepoCompose({ source, composePath });
    if (
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(result.commitSha) ||
      (commit && result.commitSha !== commit)
    )
      throw new Error("Repository revision changed. Analyze it again.");
    return {
      compose: result.composeYaml,
      commitSha: result.commitSha,
      git: { ...source, commit: result.commitSha },
    };
  } finally {
    connection.close();
  }
}
