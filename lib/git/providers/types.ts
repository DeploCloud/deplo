import type { GitPushEvent } from "../../deploy/git-webhook";
import type { GitProviderId } from "../../types/git";

// GitCredential - a connection's credentials, with the token already decrypted by the caller.
export interface GitCredential {
  provider: GitProviderId;
  // Origin with no trailing slash, e.g. https://gitlab.com.
  baseUrl: string;
  username: string;
  token: string;
}

// RepoSummary - one repository, in the shape the repo picker already renders for GitHub.
export interface RepoSummary {
  fullName: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  url: string;
  updatedAt: string;
}

// GitAccount - who a token belongs to, proven by calling the provider.
export interface GitAccount {
  login: string;
  avatarUrl: string;
  // ISO expiry when the provider reports one (GitLab does, Gitea does not).
  expiresAt: string | null;
  // Null is "we do not know", never "the token has nothing".
  scopes: string[] | null;
}

// WebhookRef - a registered webhook, reduced to what ensure/remove need.
export interface WebhookRef {
  id: string;
  url: string;
}

// ParsedPush - one ref moved by a delivery, normalised across providers.
export interface ParsedPush {
  event: GitPushEvent;
  repoFullName: string;
  commitMessage: string;
  author: string;
}

// VerifyResult - `bad` means a signature was present and did NOT match: drop it, 401.
export type VerifyResult = "ok" | "bad" | "unsigned";

// GitProviderApi - the REST half of a provider. Null on `git`, which has no API at all.
export interface GitProviderApi {
  whoami(c: GitCredential): Promise<GitAccount>;
  listRepos(c: GitCredential): Promise<RepoSummary[]>;
  listBranches(c: GitCredential, fullName: string): Promise<string[]>;
  listWebhooks(c: GitCredential, fullName: string): Promise<WebhookRef[]>;
  createWebhook(
    c: GitCredential,
    fullName: string,
    url: string,
    secret: string,
  ): Promise<void>;
  deleteWebhook(c: GitCredential, fullName: string, id: string): Promise<void>;
  // Repo-root-relative POSIX paths of every file at `ref`. For framework
  // detection, so a truncated list is fine - markers live near the root.
  listTree(c: GitCredential, fullName: string, ref: string): Promise<string[]>;
  // Raw bytes of one file, or null when absent/too large/unreadable.
  readFileBytes(
    c: GitCredential,
    fullName: string,
    ref: string,
    path: string,
  ): Promise<Buffer | null>;
  verify(secret: string, headers: Headers, rawBody: string): VerifyResult;
  // Every ref the delivery moved. Empty when it is not a push at all.
  parsePush(headers: Headers, payload: unknown): ParsedPush[];
}

// GitProviderAdapter - one git host: how it is named, addressed and called.
export interface GitProviderAdapter {
  label: string;
  // Prefilled in the connect dialog; null when the host is always self-hosted.
  defaultBaseUrl: string | null;
  // A fixed API origin, for a provider that does not serve its API from the host
  // it serves repositories from. Absent ⇒ the API lives on the connection's baseUrl.
  apiBaseUrl?: string;
  // Basic-auth username for the clone URL. Empty ⇒ the user must supply theirs.
  defaultUsername: string;
  // The page that mints a token: absolute, or a path relative to baseUrl.
  tokenHelpPath: string;
  api: GitProviderApi | null;
}
