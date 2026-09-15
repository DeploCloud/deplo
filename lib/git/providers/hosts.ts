import type { GitProviderId } from "../../types/git";

import type { GitProviderAdapter } from "./types";

export const HOSTS: Record<GitProviderId, Omit<GitProviderAdapter, "api">> = {
  gitlab: {
    label: "GitLab",
    defaultBaseUrl: "https://gitlab.com",
    defaultUsername: "oauth2",
    tokenHelpPath: "/-/user_settings/personal_access_tokens",
  },
  bitbucket: {
    label: "Bitbucket",
    defaultBaseUrl: "https://bitbucket.org",
    apiBaseUrl: "https://api.bitbucket.org",
    defaultUsername: "x-token-auth",
    tokenHelpPath: "/account/settings/app-passwords/",
  },
  gitea: {
    label: "Gitea / Forgejo",
    defaultBaseUrl: null,
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
