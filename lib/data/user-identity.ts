import "server-only";

import { inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import { users as usersTable } from "../db/schema/control-plane";
import { avatarResolver } from "../avatar";
import type { VarAuthor } from "../types";

/**
 * Batch-resolve the display identity behind the authorship columns
 * (`created_by_user_id` / `updated_by_user_id`, and the activity log's
 * `actor_user_id`).
 *
 * ONE query for a whole page — deliberately NOT the per-id round-trip of
 * folder-access.ts's `userIdentity`, which is fine for a handful of grants but
 * would fan out to a query per variable here.
 *
 * No auth gate of its own: every caller is already gated (`manage_env` /
 * instance-admin), and a name/username/avatar is identity metadata, never a
 * value. Ids that no longer resolve — a deleted account (the FK is ON DELETE SET
 * NULL) or a row predating authorship tracking — are simply ABSENT from the map,
 * so the caller maps them to `null` and the UI renders "—".
 *
 * `email` is SELECTED but never projected: it is consumed here to build the
 * Gravatar URL and dropped. That is the whole reason `avatarUrl` is computed in
 * the data layer instead of shipping the raw column — this DTO's contract is
 * "identity fields only, never an email", and it still holds.
 */
export async function loadUserIdentities(
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, VarAuthor>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const rows = await getDb()
    .select({
      id: usersTable.id,
      name: usersTable.name,
      username: usersTable.username,
      avatarColor: usersTable.avatarColor,
      image: usersTable.image,
      email: usersTable.email,
    })
    .from(usersTable)
    .where(inArray(usersTable.id, unique));
  const avatarUrl = await avatarResolver();
  return new Map(
    rows.map(
      (r) =>
        [
          r.id,
          {
            id: r.id,
            name: r.name,
            username: r.username,
            avatarColor: r.avatarColor,
            avatarUrl: avatarUrl(r),
          },
        ] as const,
    ),
  );
}

/** Resolve one author column against a batch loaded by {@link loadUserIdentities}. */
export function authorOf(
  id: string | null,
  authors: Map<string, VarAuthor>,
): VarAuthor | null {
  return (id && authors.get(id)) || null;
}
