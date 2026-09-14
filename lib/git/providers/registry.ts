import type { GitProviderId } from "../../types/git";

import { bitbucket } from "./bitbucket";
import { gitea } from "./gitea";
import { gitlab } from "./gitlab";
import { HOSTS } from "./hosts";
import type { GitProviderAdapter } from "./types";

// PROVIDERS - every git host Deplo speaks to that is not GitHub.
export const PROVIDERS: Record<GitProviderId, GitProviderAdapter> = {
  gitlab: { ...HOSTS.gitlab, api: gitlab },
  bitbucket: { ...HOSTS.bitbucket, api: bitbucket },
  gitea: { ...HOSTS.gitea, api: gitea },
  // No API: a plain git server offers nothing to list, browse or register a
  // webhook on. The connection carries credentials and nothing else.
  git: { ...HOSTS.git, api: null },
};

// KNOWN_PROVIDERS - every provider id Deplo recognises. Anything else is a plain git remote.
export const KNOWN_PROVIDERS = new Set<GitProviderId>(
  Object.keys(PROVIDERS) as GitProviderId[],
);

// providerFor - the adapter for a provider id, or the plain-git one for anything unknown.
export function providerFor(id: string): GitProviderAdapter {
  return PROVIDERS[id as GitProviderId] ?? PROVIDERS.git;
}

// tokenHelpUrl - the page where this connection's token is minted, ready to link to.
export function tokenHelpUrl(provider: GitProviderId, baseUrl: string): string {
  const { tokenHelpPath } = providerFor(provider);
  if (!tokenHelpPath) return "";
  if (/^https?:\/\//.test(tokenHelpPath)) return tokenHelpPath;
  return `${baseUrl.replace(/\/+$/, "")}${tokenHelpPath}`;
}
