import { builder } from "../builder";
import { getUpdateInfo, type UpdateInfo } from "@/lib/data/updates";

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  updateInfo: t.field({
    type: UpdateInfoRef,
    authScopes: { loggedIn: true },
    description:
      "Check the upstream repository for a newer Deplo release; cached for an hour.",
    resolve: () => getUpdateInfo(),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  checkForUpdates: t.field({
    type: UpdateInfoRef,
    authScopes: { loggedIn: true },
    description:
      "Re-run the upstream release check and return the latest update info.",
    resolve: () => getUpdateInfo(),
  }),
}));
