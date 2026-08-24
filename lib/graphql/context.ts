import "server-only";

import { getCurrentUser } from "@/lib/auth";
import { getActiveTeamId, reachableCapabilities } from "@/lib/membership";
import { authenticateToken } from "@/lib/data/tokens";
import {
  runWithIdentity,
  type RequestIdentity,
} from "@/lib/auth/request-context";
import type { Capability, PublicUser } from "@/lib/types";

/**
 * The GraphQL request context. Resolved once per operation and handed to every
 * resolver. The viewer/team/capabilities are pre-resolved here so resolvers and
 * the scope-auth layer can read them synchronously; the underlying data
 * functions still re-derive identity (they call getCurrentUser/getActiveTeamId
 * themselves), so this is a convenience snapshot, not the security boundary.
 *
 * `capabilities` is `reachableCapabilities()` — the role's set UNION everything a
 * node grant hands them somewhere in the team (ADR-0016). It has to be the union,
 * because a field's `authScopes` runs BEFORE the resolver and would otherwise
 * refuse someone who legitimately holds the capability on one app; and it is safe
 * to be that wide precisely because it was never the boundary. The boundary is
 * `requireAppCapability` inside the data function, which asks about one app.
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
export async function buildContext(request: Request): Promise<GraphQLContext> {
  const auth = request.headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : null;

  if (bearer) {
    // A token's scope can span teams, and everything below this line is scoped
    // to exactly one. `X-Deplo-Team` picks which (by id or slug) — the bearer
    // equivalent of the topbar switcher. Unset or unreachable falls back to the
    // first team in the token's scope, deterministically.
    const identity = await authenticateToken(
      bearer,
      request.headers.get("x-deplo-team"),
    );
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
      const capabilities = await reachableCapabilities();
      return { viewer, teamId, capabilities, via: "token" as const, identity };
    });
  }

  // Cookie path — same-origin browser. No override needed.
  const viewer = await getCurrentUser();
  const teamId = await getActiveTeamId();
  const capabilities = await reachableCapabilities();
  return {
    viewer,
    teamId,
    capabilities,
    via: viewer ? "cookie" : "anonymous",
    identity: null,
  };
}
