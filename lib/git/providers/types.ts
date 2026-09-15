import type { GitPushEvent } from "../../deploy/git-webhook";
import type { GitProviderId } from "../../types/git";

export interface GitCredential {
  provider: GitProviderId;
  baseUrl: string;
  username: string;
  token: string;
}

export interface RepoSummary {
  fullName: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  url: string;
  updatedAt: string;
}

export interface GitAccount {
  login: string;
  avatarUrl: string;
  expiresAt: string | null;
  scopes: string[] | null;
}

export interface WebhookRef {
  id: string;
  url: string;
}

export interface ParsedPush {
  event: GitPushEvent;
  repoFullName: string;
  commitMessage: string;
  author: string;
}

export type VerifyResult = "ok" | "bad" | "unsigned";

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
  listTree(c: GitCredential, fullName: string, ref: string): Promise<string[]>;
  readFileBytes(
    c: GitCredential,
    fullName: string,
    ref: string,
    path: string,
  ): Promise<Buffer | null>;
  verify(secret: string, headers: Headers, rawBody: string): VerifyResult;
  parsePush(headers: Headers, payload: unknown): ParsedPush[];
}

export interface GitProviderAdapter {
  label: string;
  defaultBaseUrl: string | null;
  apiBaseUrl?: string;
  defaultUsername: string;
  tokenHelpPath: string;
  api: GitProviderApi | null;
}
