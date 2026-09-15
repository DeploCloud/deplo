import * as z from "zod";
import { tool, type McpToolDef } from "./tool-def";

export const GIT: McpToolDef[] = [
  tool({
    name: "list_git_sources",
    title: "List git connections",
    description:
      "The GitHub installations and other git connections this team can build from. Start here when you need a repo and do not know its URL.",
    group: "Git",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpGitSources {
        githubInstallations {
          id
          installationId
          accountLogin
          accountType
        }
        gitConnections {
          id
          label
          provider
          accountLogin
          baseUrl
          hasApi
          health
        }
      }
    `,
  }),
  tool({
    name: "list_repos",
    title: "List repositories or branches",
    description:
      "Repositories a git source can reach, or a repository's branches when you name one. Ids come from list_git_sources.",
    group: "Git",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({
      installationId: z
        .string()
        .optional()
        .describe("A GitHub installation, from list_git_sources."),
      connectionId: z
        .string()
        .optional()
        .describe("A non-GitHub git connection, from list_git_sources."),
      repo: z
        .string()
        .optional()
        .describe("owner/name. Given, this lists branches instead of repos."),
    }),
    variables: (a) => {
      if (Boolean(a.installationId) === Boolean(a.connectionId))
        throw new Error(
          "Pass exactly one of installationId or connectionId; see list_git_sources.",
        );
      const github = Boolean(a.installationId);
      const branches = Boolean(a.repo);
      return {
        installationId: a.installationId ?? "",
        connectionId: a.connectionId ?? "",
        repo: a.repo ?? "",
        isGithubRepos: github && !branches,
        isGithubBranches: github && branches,
        isGitRepos: !github && !branches,
        isGitBranches: !github && branches,
      };
    },
    query: /* GraphQL */ `
      query McpRepos(
        $installationId: String!
        $connectionId: String!
        $repo: String!
        $isGithubRepos: Boolean!
        $isGithubBranches: Boolean!
        $isGitRepos: Boolean!
        $isGitBranches: Boolean!
      ) {
        githubRepos(installationId: $installationId)
          @include(if: $isGithubRepos) {
          fullName
          defaultBranch
          private
          updatedAt
        }
        githubBranches(installationId: $installationId, fullName: $repo)
          @include(if: $isGithubBranches)
        gitRepos(connectionId: $connectionId) @include(if: $isGitRepos) {
          fullName
          defaultBranch
          private
          updatedAt
        }
        gitBranches(connectionId: $connectionId, fullName: $repo)
          @include(if: $isGitBranches)
      }
    `,
  }),
];

export const GIT_CONNECTIONS: McpToolDef[] = [
  tool({
    name: "list_git_providers",
    title: "List the git providers Deplo can connect",
    description:
      "GitHub, GitLab, Bitbucket, Gitea: what each needs (token scopes, base URL) to be connected.",
    group: "Git",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpGitProviders {
        gitProviders {
          id
          label
          defaultBaseUrl
          defaultUsername
          hasApi
          tokenScopes
          tokenHelpUrl
        }
      }
    `,
  }),
  tool({
    name: "connect_git_provider",
    title: "Connect a git provider with a token",
    description:
      "Connect GitLab, Bitbucket or Gitea (GitHub uses its own app flow in the dashboard) with a personal access token.",
    group: "Git",
    requires: "manage_git",
    input: z.object({
      provider: z.string().describe("From list_git_providers."),
      label: z.string(),
      baseUrl: z.string(),
      token: z.string(),
      username: z.string().optional(),
    }),
    variables: (a) => ({ input: a }),
    query: /* GraphQL */ `
      mutation McpConnectGit($input: ConnectGitProviderInput!) {
        connectGitProvider(input: $input) {
          id
          provider
          label
          baseUrl
          health
        }
      }
    `,
  }),
  tool({
    name: "update_git_connection",
    title: "Rotate a git connection's token or rename it",
    description: "Change the label, the token or the username of a connection.",
    group: "Git",
    requires: "manage_git",
    idempotent: true,
    input: z.object({
      id: z.string().describe("From list_git_sources."),
      label: z.string().optional(),
      token: z.string().optional(),
      username: z.string().optional(),
    }),
    variables: ({ id, ...input }) => ({ id, input }),
    query: /* GraphQL */ `
      mutation McpUpdateGit($id: String!, $input: UpdateGitConnectionInput!) {
        updateGitConnection(id: $id, input: $input) {
          id
          label
          health
        }
      }
    `,
  }),
  tool({
    name: "test_git_connection",
    title: "Test a git connection",
    description: "Check that a connection's token still works.",
    group: "Git",
    requires: "manage_git",
    idempotent: true,
    input: z.object({ id: z.string().describe("From list_git_sources.") }),
    query: /* GraphQL */ `
      mutation McpTestGit($id: String!) {
        testGitConnection(id: $id) {
          id
          health
          healthError
          lastCheckedAt
        }
      }
    `,
  }),
  tool({
    name: "remove_git_connection",
    title: "Disconnect a git provider",
    description:
      "Remove a connection. Apps deploying through it keep their code but lose automatic deploys.",
    group: "Git",
    requires: "manage_git",
    destructive: true,
    input: z.object({ id: z.string().describe("From list_git_sources.") }),
    query: /* GraphQL */ `
      mutation McpRemoveGit($id: String!) {
        removeGitConnection(id: $id)
      }
    `,
  }),
];
