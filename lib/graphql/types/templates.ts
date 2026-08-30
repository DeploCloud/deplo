// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { revalidateTag } from "next/cache";
import { builder } from "../builder";

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  refreshTemplates: t.boolean({
    // `loggedIn`, not a capability: this only drops the hour-long cache in front of
    // a PUBLIC catalog, and every member sees the same store.
    authScopes: { loggedIn: true },
    description:
      "Drop the cached template catalog so the next read hits the catalog service.",
    resolve: () => {
      // The tag `templates/catalog.ts` stamps on every catalog fetch. `expire: 0`
      // because a Refresh button that answers with stale content is a lie.
      revalidateTag("templates", { expire: 0 });
      return true;
    },
  }),
}));
