import { builder } from "../builder";
import {
  getUpdateInfo,
  listDeploReleases,
  refreshUpdateInfo,
  type DeploRelease,
  type UpdateInfo,
} from "@/lib/data/updates";

const UpdateInfoRef = builder.objectRef<UpdateInfo>("UpdateInfo").implement({
  description:
    "Result of checking the upstream GitHub repository for a newer Deplo release.",
  fields: (t) => ({
    current: t.exposeString("current"),
    latest: t.exposeString("latest", { nullable: true }),
    updateAvailable: t.exposeBoolean("updateAvailable"),
    url: t.exposeString("url", { nullable: true }),
    name: t.exposeString("name", { nullable: true }),
    publishedAt: t.exposeString("publishedAt", { nullable: true }),
    checkedAt: t.exposeString("checkedAt"),
    error: t.exposeString("error", { nullable: true }),
  }),
});

const DeploReleaseRef = builder
  .objectRef<DeploRelease>("DeploRelease")
  .implement({
    description: "One published release of Deplo, as the changelog renders it.",
    fields: (t) => ({
      tag: t.exposeString("tag"),
      name: t.exposeString("name"),
      url: t.exposeString("url"),
      publishedAt: t.exposeString("publishedAt", { nullable: true }),
      body: t.exposeString("body"),
      prerelease: t.exposeBoolean("prerelease"),
      current: t.exposeBoolean("current"),
    }),
  });

const ChangelogRef = builder
  .objectRef<{ releases: DeploRelease[]; error?: string }>("DeploChangelog")
  .implement({
    description: "Deplo's published releases, newest first.",
    fields: (t) => ({
      releases: t.field({
        type: [DeploReleaseRef],
        resolve: (c) => c.releases,
      }),
      error: t.exposeString("error", { nullable: true }),
    }),
  });

builder.queryFields((t) => ({
  updateInfo: t.field({
    type: UpdateInfoRef,
    authScopes: { loggedIn: true },
    description:
      "Check the upstream repository for a newer Deplo release; cached for an hour.",
    resolve: () => getUpdateInfo(),
  }),
  deploChangelog: t.field({
    type: ChangelogRef,
    authScopes: { instanceAdmin: true },
    description:
      "Deplo's published releases with their notes, newest first; cached for an hour and refreshed by checkForUpdates.",
    resolve: () => listDeploReleases(),
  }),
}));

builder.mutationFields((t) => ({
  checkForUpdates: t.field({
    type: UpdateInfoRef,
    authScopes: { instanceAdmin: true },
    description:
      "Re-run the upstream release check ignoring the cache, and expire the changelog beside it.",
    resolve: () => refreshUpdateInfo(),
  }),
}));
