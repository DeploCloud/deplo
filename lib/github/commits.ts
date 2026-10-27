import "server-only";

import { getInstallationToken, githubGet, OWNER_REPO_RE } from "./app";

export interface BranchHead {
  sha: string;
  message: string;
  author: string;
}

export async function branchHead(
  fullName: string,
  branch: string,
  installationId: string | null,
): Promise<BranchHead | null> {
  if (!OWNER_REPO_RE.test(fullName)) return null;
  try {
    const token = installationId
      ? await getInstallationToken(installationId)
      : null;
    const res = await githubGet(
      `/repos/${fullName}/branches/${encodeURIComponent(branch)}`,
      token,
      AbortSignal.timeout(8_000),
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      commit?: {
        sha?: string;
        commit?: { message?: string; author?: { name?: string } };
      };
    };
    const sha = json.commit?.sha;
    if (!sha) return null;
    return {
      sha,
      message: json.commit?.commit?.message ?? "",
      author: json.commit?.commit?.author?.name ?? "",
    };
  } catch {
    return null;
  }
}

export async function publicBranchHead(
  fullName: string,
  branch: string,
): Promise<string | null> {
  return (await branchHead(fullName, branch, null))?.sha ?? null;
}
