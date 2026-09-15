import { PROVIDERS, tokenHelpUrl } from "./providers/registry";
import { tokenScopesLine } from "./provider-access";
import type { GitProviderChoice, GitProviderId } from "../types/git";

export function gitProviderChoices(): GitProviderChoice[] {
  return (Object.keys(PROVIDERS) as GitProviderId[]).map((id) => ({
    id,
    label: PROVIDERS[id].label,
    defaultBaseUrl: PROVIDERS[id].defaultBaseUrl,
    defaultUsername: PROVIDERS[id].defaultUsername,
    tokenScopes: tokenScopesLine(id),
    hasApi: PROVIDERS[id].api != null,
    tokenHelpUrl: tokenHelpUrl(id, PROVIDERS[id].defaultBaseUrl ?? ""),
  }));
}
