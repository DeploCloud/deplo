import type { GitProviderId } from "../../types/git";

import { bitbucket } from "./bitbucket";
import { gitea } from "./gitea";
import { gitlab } from "./gitlab";
import { HOSTS } from "./hosts";
import type { GitProviderAdapter } from "./types";

export const PROVIDERS: Record<GitProviderId, GitProviderAdapter> = {
  gitlab: { ...HOSTS.gitlab, api: gitlab },
  bitbucket: { ...HOSTS.bitbucket, api: bitbucket },
  gitea: { ...HOSTS.gitea, api: gitea },
  git: { ...HOSTS.git, api: null },
};

export const KNOWN_PROVIDERS = new Set<GitProviderId>(
  Object.keys(PROVIDERS) as GitProviderId[],
);

export function providerFor(id: string): GitProviderAdapter {
  return PROVIDERS[id as GitProviderId] ?? PROVIDERS.git;
}

export function tokenHelpUrl(provider: GitProviderId, baseUrl: string): string {
  const { tokenHelpPath } = providerFor(provider);
  if (!tokenHelpPath) return "";
  if (/^https?:\/\//.test(tokenHelpPath)) return tokenHelpPath;
  return `${baseUrl.replace(/\/+$/, "")}${tokenHelpPath}`;
}
