import "server-only";

import { eq, ne } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { oauthResource } from "@/lib/db/schema/auth";
import { mcpResource } from "@/lib/auth/oauth-metadata";

/**
 * Keep exactly ONE OAuth resource requestable: the one matching this instance's
 * current address.
 *
 * Better Auth 1.7.0 turned the RFC 8707 audience list from config into rows.
 * That is the right shape - it is what lets a grant record the audience it was
 * issued for, which is the fix for GHSA-p2fr-6hmx-4528 - but it also means the
 * list now OUTLIVES the config that produced it. deplo's resource identifier is
 * derived from the panel's public address (`<base>/api/mcp`), and that address
 * is a setting somebody can change: seeding is `insertOnly` by default, so a
 * panel moved from one hostname to another ends up with two live audiences, and
 * an instance moved twice with three.
 *
 * Nobody chose that. The old identifiers name an address this instance no longer
 * answers on, and "which audience is valid" would be decided by whatever a
 * client happened to ask for.
 *
 * So: the current identifier is enabled, every other one is disabled. Disabled
 * rather than deleted, because "which audience was valid last March" is an audit
 * question and the rows are the only place that answers it - but a disabled
 * resource cannot be requested, which is the property that matters.
 *
 * Re-enabling the current one is not redundant: an instance that moves from A to
 * B and back to A finds row A already present, and `insertOnly` will not touch
 * it. Without this it would stay disabled forever and every token exchange would
 * fail with "requested resource invalid" on an address that looks perfectly
 * configured.
 *
 * Called at boot (instrumentation-node.ts) and again whenever the panel's
 * address changes (`rememberPanelUrl`), next to the {@link resetAuth} that
 * rebuilds the auth instance for the same reason.
 *
 * A no-op when the instance has no public address: OAuth cannot work at all
 * without one (the discovery documents answer 503), and disabling every resource
 * over a transient gap in configuration would turn a missing setting into a
 * cleanup nobody asked for.
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
