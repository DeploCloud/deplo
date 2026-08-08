import { builder } from "../builder";
import {
  connectGitProvider,
  listGitBranches,
  listGitConnections,
  listGitRepos,
  removeGitConnection,
  testGitConnection,
  updateGitConnection,
  type GitConnectionDTO,
} from "@/lib/data/git-connections";
import { assertUser } from "@/lib/auth";
import { PROVIDERS, tokenHelpUrl, type RepoSummary } from "@/lib/git/providers";
import type { GitProviderId } from "@/lib/types";

/**
 * Git providers other than GitHub (GitLab, Bitbucket, Gitea/Forgejo, plain git).
 * Resolvers stay thin: every one of them delegates straight to
 * `lib/data/git-connections.ts`, which is where the team scoping and the
 * `manage_git` gate actually live.
 */

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

const GitConnectionRef = builder
  .objectRef<GitConnectionDTO>("GitConnection")
  .implement({
    description:
      "A team's stored credentials for one git host that is not GitHub. The token is never exposed.",
    fields: (t) => ({
      id: t.exposeID("id"),
      provider: t.exposeString("provider", {
        description: "gitlab | bitbucket | gitea | git.",
      }),
      label: t.exposeString("label"),
      baseUrl: t.exposeString("baseUrl"),
      username: t.exposeString("username"),
      accountLogin: t.exposeString("accountLogin"),
      avatarUrl: t.exposeString("avatarUrl"),
      health: t.exposeString("health", {
        description:
          "ok | failing. Re-derived by the maintenance sweep and by testGitConnection, so a revoked token surfaces before a deploy fails on it.",
      }),
      healthError: t.exposeString("healthError", {
        description: "The provider's own refusal when health is failing.",
      }),
      tokenExpiresAt: t.exposeString("tokenExpiresAt", { nullable: true }),
      lastCheckedAt: t.exposeString("lastCheckedAt", { nullable: true }),
      createdAt: t.exposeString("createdAt"),
      appCount: t.exposeInt("appCount", {
        description: "Apps whose clone this connection authenticates.",
      }),
      hasApi: t.exposeBoolean("hasApi", {
        description:
          "False for a plain git server: it can carry credentials but cannot list repositories or register a webhook.",
      }),
    }),
  });

/** Static description of a supported provider, so the UI holds no catalogue. */
interface GitProviderInfo {
  id: GitProviderId;
  label: string;
  defaultBaseUrl: string | null;
  defaultUsername: string;
  tokenScopes: string;
  hasApi: boolean;
}

const GitProviderRef = builder
  .objectRef<GitProviderInfo>("GitProvider")
  .implement({
    description: "A git host Deplo can connect to, other than GitHub (beta).",
    fields: (t) => ({
      id: t.exposeString("id"),
      label: t.exposeString("label"),
      defaultBaseUrl: t.exposeString("defaultBaseUrl", { nullable: true }),
      defaultUsername: t.exposeString("defaultUsername"),
      tokenScopes: t.exposeString("tokenScopes", {
        description: "The scopes to tick when creating the token, as one line.",
      }),
      hasApi: t.exposeBoolean("hasApi"),
      tokenHelpUrl: t.field({
        type: "String",
        description:
          "Where to create the token. Pass the connection's own baseUrl for a self-hosted host.",
        args: { baseUrl: t.arg.string({ required: false }) },
        resolve: (p, { baseUrl }) =>
          tokenHelpUrl(p.id, baseUrl || p.defaultBaseUrl || ""),
      }),
    }),
  });

const GitRepoSummaryRef = builder
  .objectRef<RepoSummary>("GitRepoSummary")
  .implement({
    description: "A repository a connection can list and clone.",
    fields: (t) => ({
      fullName: t.exposeString("fullName"),
      name: t.exposeString("name"),
      private: t.exposeBoolean("private"),
      defaultBranch: t.exposeString("defaultBranch"),
      url: t.exposeString("url"),
      updatedAt: t.exposeString("updatedAt"),
    }),
  });

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  gitProviders: t.field({
    type: [GitProviderRef],
    authScopes: { loggedIn: true },
    description:
      "Git hosts other than GitHub that Deplo can connect to. Static catalogue.",
    resolve: () =>
      (Object.keys(PROVIDERS) as GitProviderId[]).map((id) => ({
        id,
        label: PROVIDERS[id].label,
        defaultBaseUrl: PROVIDERS[id].defaultBaseUrl,
        defaultUsername: PROVIDERS[id].defaultUsername,
        tokenScopes: PROVIDERS[id].tokenScopes,
        hasApi: PROVIDERS[id].api != null,
      })),
  }),
  gitConnections: t.field({
    type: [GitConnectionRef],
    authScopes: { loggedIn: true },
    description: "The active team's git connections, newest first.",
    resolve: () => listGitConnections(),
  }),
  gitRepos: t.field({
    type: [GitRepoSummaryRef],
    authScopes: { loggedIn: true },
    description: "Repositories a git connection can reach. Empty for plain git.",
    args: { connectionId: t.arg.string({ required: true }) },
    resolve: async (_r, { connectionId }) => {
      await assertUser();
      return listGitRepos(connectionId);
    },
  }),
  gitBranches: t.field({
    type: ["String"],
    authScopes: { loggedIn: true },
    description: "Branch names of a repository a git connection can reach.",
    args: {
      connectionId: t.arg.string({ required: true }),
      fullName: t.arg.string({ required: true }),
    },
    resolve: async (_r, { connectionId, fullName }) => {
      await assertUser();
      return listGitBranches(connectionId, fullName);
    },
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

const ConnectGitProviderInputRef = builder.inputType("ConnectGitProviderInput", {
  fields: (t) => ({
    provider: t.string({ required: true, description: "gitlab | bitbucket | gitea | git." }),
    label: t.string({ required: true }),
    baseUrl: t.string({
      required: true,
      description:
        "Origin of the git host. A bare domain becomes https://; a path or embedded credentials are refused.",
    }),
    username: t.string({
      required: false,
      description: "Basic-auth username for the clone. Defaults per provider.",
    }),
    token: t.string({ required: true, description: "Access token. Write-only." }),
  }),
});

const UpdateGitConnectionInputRef = builder.inputType("UpdateGitConnectionInput", {
  fields: (t) => ({
    label: t.string({ required: false }),
    username: t.string({ required: false }),
    token: t.string({
      required: false,
      description: "A replacement token. Omit to keep the stored one.",
    }),
  }),
});

builder.mutationFields((t) => ({
  connectGitProvider: t.field({
    type: GitConnectionRef,
    authScopes: { capability: "manage_git" },
    description:
      "Store credentials for a git host, after proving the token works against it.",
    args: { input: t.arg({ type: ConnectGitProviderInputRef, required: true }) },
    resolve: (_r, { input }) =>
      connectGitProvider({
        provider: input.provider,
        label: input.label,
        baseUrl: input.baseUrl,
        username: input.username ?? "",
        token: input.token,
      }),
  }),
  updateGitConnection: t.field({
    type: GitConnectionRef,
    authScopes: { capability: "manage_git" },
    description: "Rename a git connection or rotate its token.",
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: UpdateGitConnectionInputRef, required: true }),
    },
    resolve: (_r, { id, input }) => updateGitConnection(id, input),
  }),
  testGitConnection: t.field({
    type: GitConnectionRef,
    authScopes: { capability: "manage_git" },
    description:
      "Ask the provider who the stored token belongs to and record the answer.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => testGitConnection(id),
  }),
  removeGitConnection: t.field({
    type: "Int",
    authScopes: { capability: "manage_git" },
    description:
      "Disconnect a git provider. Returns how many apps were unlinked (their auto-deploy is turned off).",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => removeGitConnection(id),
  }),
}));
