import "server-only";

import type { GitRepo } from "../types/build";
import type { CommitSignature } from "../types/deployment";
import { getInstallationToken, githubGet, OWNER_REPO_RE } from "./app";
import { githubFullName } from "./repo-id";

export interface BranchHead {
  sha: string;
  message: string;
  author: string;
  signature: CommitSignature | null;
}

interface GithubCommit {
  sha?: string;
  commit?: {
    message?: string;
    author?: { name?: string };
    verification?: { verified?: boolean; reason?: string };
  };
}

// Any signature GitHub did not accept is "unverified", the way GitHub's own UI shows it.
export function signatureOf(
  v: { verified?: boolean; reason?: string } | undefined,
): CommitSignature | null {
  if (v?.verified) return "verified";
  return v?.reason && v.reason !== "unsigned" ? "unverified" : null;
}

async function readCommit<T>(
  fullName: string,
  path: string,
  installationId: string | null,
  pick: (json: T) => GithubCommit | undefined,
): Promise<BranchHead | null> {
  if (!OWNER_REPO_RE.test(fullName)) return null;
  try {
    const token = installationId
      ? await getInstallationToken(installationId)
      : null;
    const res = await githubGet(
      `/repos/${fullName}${path}`,
      token,
      AbortSignal.timeout(8_000),
    );
    if (!res.ok) return null;
    const c = pick((await res.json()) as T);
    if (!c?.sha) return null;
    return {
      sha: c.sha,
      message: c.commit?.message ?? "",
      author: c.commit?.author?.name ?? "",
      signature: signatureOf(c.commit?.verification),
    };
  } catch {
    return null;
  }
}

export function branchHead(
  fullName: string,
  branch: string,
  installationId: string | null,
): Promise<BranchHead | null> {
  return readCommit(
    fullName,
    `/branches/${encodeURIComponent(branch)}`,
    installationId,
    (json: { commit?: GithubCommit }) => json.commit,
  );
}

export async function publicBranchHead(
  fullName: string,
  branch: string,
): Promise<string | null> {
  return (await branchHead(fullName, branch, null))?.sha ?? null;
}

// The commit a build actually cloned, which a preview only learns then.
export async function commitSignatureAt(
  repo: Pick<GitRepo, "repo" | "url" | "installationId">,
  sha: string,
): Promise<CommitSignature | null> {
  const fullName = githubFullName(repo);
  if (!fullName || !repo.installationId || !/^[0-9a-f]{7,64}$/i.test(sha))
    return null;
  const head = await readCommit(
    fullName,
    `/commits/${sha}`,
    repo.installationId,
    (json: GithubCommit) => json,
  );
  return head?.signature ?? null;
}
