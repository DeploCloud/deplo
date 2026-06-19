import "server-only";

import { getCurrentUser } from "@/lib/auth";
import { currentCapabilities, getActiveTeamId } from "@/lib/membership";
import { authenticateToken } from "@/lib/data/tokens";
import { runWithIdentity, type RequestIdentity } from "@/lib/auth/request-context";
import { ensureStoreReady } from "@/lib/store";
import type { Capability, PublicUser } from "@/lib/types";

/**
 * The GraphQL request context. Resolved once per operation and handed to every
 * resolver. The viewer/team/capabilities are pre-resolved here so resolvers and
 * the scope-auth layer can read them synchronously; the underlying data
 * functions still re-derive identity (they call getCurrentUser/getActiveTeamId
 * themselves), so this is a convenience snapshot, not the security boundary.
 */
export interface GraphQLContext {
  viewer: PublicUser | null;
  teamId: string | null;
  capabilities: Capability[];
  /** How this request authenticated — useful for docs/debugging, not security. */
  via: "cookie" | "token" | "anonymous";
  /**
   * Set for a valid bearer-token request. The Yoga `onExecute` hook wraps the
   * whole operation in `runWithIdentity(identity, …)` so every data-layer call
   * inside the resolvers resolves the token's principal (not cookies). Null for
   * the cookie/browser path, where no override is needed.
   */
  identity: RequestIdentity | null;
}

/**
 * Build the per-request context. If an `Authorization: Bearer deplo_…` header
 * is present and valid, the whole resolution runs inside `runWithIdentity` so
 * the data layer (getCurrentUser / getActiveTeamId / requireCapability) sees
 * the token's principal instead of cookies. Otherwise we fall through to the
 * cookie-based session (the browser path), which needs no override.
 */
export async function buildContext(
  request: Request,
): Promise<GraphQLContext> {
  // In Postgres mode the in-memory store is hydrated lazily; `authenticateToken`
  // reads it synchronously, so the cache must be ready before the first bearer
  // request or the token lookup runs against an empty seed. (The cookie path
  // already awaits this inside getCurrentUser.)
  await ensureStoreReady();

  const auth = request.headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : null;

  if (bearer) {
    const identity = authenticateToken(bearer);
    if (!identity) {
      return {
        viewer: null,
        teamId: null,
        capabilities: [],
        via: "token",
        identity: null,
      };
    }
    return runWithIdentity(identity, async () => {
      const viewer = await getCurrentUser();
      const teamId = await getActiveTeamId();
      const capabilities = await currentCapabilities();
      return { viewer, teamId, capabilities, via: "token" as const, identity };
    });
  }

  // Cookie path — same-origin browser. No override needed.
  const viewer = await getCurrentUser();
  const teamId = await getActiveTeamId();
  const capabilities = await currentCapabilities();
  return {
    viewer,
    teamId,
    capabilities,
    via: viewer ? "cookie" : "anonymous",
    identity: null,
  };
}
