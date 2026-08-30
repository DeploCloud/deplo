// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

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
