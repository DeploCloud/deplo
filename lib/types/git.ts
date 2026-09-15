import type { ID } from "./identity";

export interface GithubApp {
  id: ID;
  teamId: ID;
  appId: number;
  slug: string;
  name: string;
  clientId: string;
  clientSecretEnc: string;
  webhookSecretEnc: string;
  privateKeyEnc: string;
  htmlUrl: string;
  createdAt: string;
}

export interface GithubInstallation {
  id: ID;
  appId: ID;
  installationId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  avatarUrl: string;
  createdAt: string;
}

export type GitProviderId = "gitlab" | "bitbucket" | "gitea" | "git";

export interface GitProviderChoice {
  id: GitProviderId;
  label: string;
  defaultBaseUrl: string | null;
  defaultUsername: string;
  tokenScopes: string;
  hasApi: boolean;
  tokenHelpUrl: string;
}

export interface GitConnection {
  id: ID;
  teamId: ID;
  provider: GitProviderId;
  label: string;
  baseUrl: string;
  allowPrivateEndpoint: boolean;
  username: string;
  accountLogin: string;
  avatarUrl: string;
  health: "ok" | "failing";
  healthError: string;
  tokenExpiresAt: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
}
