import { builder } from "../builder";
import {
  listGithubApps,
  listGithubInstallations,
  removeGithubApp,
  type GithubAppDTO,
  type GithubInstallationDTO,
} from "@/lib/data/github";
import { assertUser } from "@/lib/auth";
import { signState } from "@/lib/crypto";
import {
  resolveManifestBaseUrl,
  PUBLIC_URL_PLACEHOLDER,
} from "@/lib/public-url";
import { buildManifest, manifestCreateUrl } from "@/lib/github/manifest";
import {
  listInstallationRepos,
  listRepoBranches,
  type GithubRepoSummary,
} from "@/lib/github/app";

/**
 * The start of the GitHub App manifest flow: the GitHub URL to POST to plus the
 * manifest the browser submits and the signed CSRF state echoed to our callback.
 */
interface GithubConnectStart {
  actionUrl: string;
  manifest: string;
  state: string;
}

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

const GithubInstallationRef = builder
  .objectRef<GithubInstallationDTO>("GithubInstallation")
  .implement({
    description: "An installation of a connected GitHub App on a user or org.",
    fields: (t) => ({
      id: t.exposeID("id"),
      installationId: t.exposeInt("installationId"),
      accountLogin: t.exposeString("accountLogin"),
      accountType: t.exposeString("accountType"),
      avatarUrl: t.exposeString("avatarUrl"),
    }),
  });

export const GithubAppRef = builder
  .objectRef<GithubAppDTO>("GithubApp")
  .implement({
    description: "A GitHub App connected to a team (no secrets exposed).",
    fields: (t) => ({
      id: t.exposeID("id"),
      appId: t.exposeInt("appId"),
      slug: t.exposeString("slug"),
      name: t.exposeString("name"),
      htmlUrl: t.exposeString("htmlUrl"),
      createdAt: t.exposeString("createdAt"),
      installations: t.field({
        type: [GithubInstallationRef],
        description: "Installations of this App.",
        resolve: (a) => a.installations,
      }),
    }),
  });

/** Repositories accessible to an installation (for source pickers). */
const GithubRepoRef = builder
  .objectRef<GithubRepoSummary>("GithubRepo")
  .implement({
    description: "A repository the installation can list and clone.",
    fields: (t) => ({
      fullName: t.exposeString("fullName"),
      name: t.exposeString("name"),
      private: t.exposeBoolean("private"),
      defaultBranch: t.exposeString("defaultBranch"),
      url: t.exposeString("url"),
      updatedAt: t.exposeString("updatedAt"),
    }),
  });

const GithubConnectStartRef = builder
  .objectRef<GithubConnectStart>("GithubConnectStart")
  .implement({
    description:
      "Inputs for the browser's self-submitting form that creates a GitHub App.",
    fields: (t) => ({
      actionUrl: t.exposeString("actionUrl"),
      manifest: t.exposeString("manifest"),
      state: t.exposeString("state"),
    }),
  });

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  githubApps: t.field({
    type: [GithubAppRef],
    authScopes: { loggedIn: true },
    description: "Connected GitHub Apps in the active team.",
    resolve: () => listGithubApps(),
  }),
  githubInstallations: t.field({
    type: [GithubInstallationRef],
    authScopes: { loggedIn: true },
    description: "Installations of the active team's connected Apps.",
    resolve: () => listGithubInstallations(),
  }),
  githubRepos: t.field({
    type: [GithubRepoRef],
    authScopes: { loggedIn: true },
    description: "Repositories accessible to a GitHub App installation.",
    args: { installationId: t.arg.string({ required: true }) },
    resolve: async (_r, { installationId }) => {
      await assertUser();
      return listInstallationRepos(installationId);
    },
  }),
  githubBranches: t.field({
    type: ["String"],
    authScopes: { loggedIn: true },
    description: "Branch names for a repo accessible to an installation.",
    args: {
      installationId: t.arg.string({ required: true }),
      fullName: t.arg.string({ required: true }),
    },
    resolve: async (_r, { installationId, fullName }) => {
      await assertUser();
      return listRepoBranches(installationId, fullName);
    },
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations (every GitHub server action)                              */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  startGithubConnect: t.field({
    type: GithubConnectStartRef,
    authScopes: { capability: "manage_infra" },
    description:
      "Begin the GitHub App manifest flow; returns the form's POST target, manifest and signed state.",
    args: { org: t.arg.string({ required: false }) },
    resolve: async (_r, { org }): Promise<GithubConnectStart> => {
      const user = await assertUser();
      // The manifest base is baked permanently into the App on GitHub, so it
      // must be an explicit, externally-reachable URL — never a host guess.
      const base = resolveManifestBaseUrl();
      if (base === PUBLIC_URL_PLACEHOLDER) {
        throw new Error(
          "Set DEPLO_PUBLIC_URL to a public, externally-reachable URL (not localhost) so GitHub can reach this instance before connecting.",
        );
      }
      return {
        actionUrl: manifestCreateUrl(org ?? undefined),
        manifest: JSON.stringify(buildManifest(base)),
        state: signState(`github:${user.id}`),
      };
    },
  }),
  removeGithubApp: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description: "Disconnect a GitHub App and its installations. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await removeGithubApp(id);
      return true;
    },
  }),
}));
