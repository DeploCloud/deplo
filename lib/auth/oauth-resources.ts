import "server-only";

import { eq, ne } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { oauthResource } from "@/lib/db/schema/auth";
import { mcpResource } from "@/lib/auth/oauth-metadata";

/**
 * Keep exactly ONE OAuth resource requestable: the one matching this instance's
 * current address.
 */
export async function reconcileOAuthResources(): Promise<void> {
  const current = mcpResource();
  if (!current) return;
  const now = new Date();
  const db = getDb();
  await db
    .update(oauthResource)
    .set({ disabled: true, updatedAt: now })
    .where(ne(oauthResource.identifier, current));
  await db
    .update(oauthResource)
    .set({ disabled: false, updatedAt: now })
    .where(eq(oauthResource.identifier, current));
}
