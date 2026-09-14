import type { GitProviderId } from "../../types/git";

import type { GitProviderAdapter } from "./types";

// HOSTS - the static facts about each git host; ./registry pairs them with an api.
export const HOSTS: Record<GitProviderId, Omit<GitProviderAdapter, "api">> = {
  gitlab: {
    label: "GitLab",
    defaultBaseUrl: "https://gitlab.com",
    // Any username works with a GitLab token; "oauth2" is the documented one.
    defaultUsername: "oauth2",
    tokenHelpPath: "/-/user_settings/personal_access_tokens",
  },
  bitbucket: {
    label: "Bitbucket",
    defaultBaseUrl: "https://bitbucket.org",
    // Bitbucket Cloud serves its API from a different host than its repositories,
    // and cannot be self-hosted, so the API origin is fixed rather than derived.
    apiBaseUrl: "https://api.bitbucket.org",
    // Right for an API token. With an app password it is your own username, which
    // is why the field stays editable.
    defaultUsername: "x-token-auth",
    tokenHelpPath: "/account/settings/app-passwords/",
  },
  gitea: {
    label: "Gitea / Forgejo",
    defaultBaseUrl: null,
    // Gitea wants the real account name alongside the token.
    defaultUsername: "",
    tokenHelpPath: "/user/settings/applications",
  },
  git: {
    label: "Git",
    defaultBaseUrl: null,
    defaultUsername: "",
    tokenHelpPath: "",
  },
};
