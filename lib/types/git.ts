import type { ID } from "./identity";

// GithubApp - a GitHub App connected to this instance through the App Manifest
// flow: one click, no hand-copied ids and keys.
export interface GithubApp {
  id: ID;
  teamId: ID;
  // Numeric GitHub App id (used as the JWT issuer).
  appId: number;
  // URL slug, e.g. used to build the install URL github.com/apps/<slug>.
  slug: string;
  name: string;
  clientId: string;
  // encrypted at rest
  clientSecretEnc: string;
  // encrypted at rest - verifies inbound webhook signatures
  webhookSecretEnc: string;
  // encrypted at rest - PEM used to sign installation-token JWTs (RS256)
  privateKeyEnc: string;
  htmlUrl: string;
  createdAt: string;
}

// GithubInstallation - an installation of a connected GitHub App on a user/org
// account; its id is what mints short-lived tokens to list and clone repos.
export interface GithubInstallation {
  id: ID;
  // FK to the GithubApp this installation belongs to.
  appId: ID;
  // Numeric GitHub installation id.
  installationId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  avatarUrl: string;
  createdAt: string;
}

// GitProviderId - which non-GitHub git host a {@link GitConnection} talks to.
export type GitProviderId = "gitlab" | "bitbucket" | "gitea" | "git";

// GitProviderChoice - one connectable host as the Connect dialog needs it, built
// server-side by `gitProviderChoices`.
export interface GitProviderChoice {
  id: GitProviderId;
  label: string;
  defaultBaseUrl: string | null;
  defaultUsername: string;
  tokenScopes: string;
  hasApi: boolean;
  tokenHelpUrl: string;
}

// GitConnection - a team's credentials for one git host, reused by every App
// deploying from it: the counterpart of a {@link GithubInstallation}.
export interface GitConnection {
  id: ID;
  teamId: ID;
  provider: GitProviderId;
  // User-chosen name, e.g. "Company GitLab".
  label: string;
  // Origin with no trailing slash, e.g. https://gitlab.com.
  baseUrl: string;
  // The address points inside the deployment, and an instance admin said so.
  allowPrivateEndpoint: boolean;
  // Basic-auth username for the clone URL ("oauth2", "x-token-auth", …).
  username: string;
  // Account the token belongs to, resolved from the provider.
  accountLogin: string;
  avatarUrl: string;
  health: "ok" | "failing";
  // The provider's own error when `health` is "failing"; "" otherwise.
  healthError: string;
  // Only when the provider reports it (GitLab does, Gitea does not).
  tokenExpiresAt: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
}
