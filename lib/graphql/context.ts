import "server-only";

import { getCurrentUser } from "@/lib/auth";
import { getActiveTeamId, reachableCapabilities } from "@/lib/membership";
import { authenticateToken } from "@/lib/data/tokens";
import {
  runWithIdentity,
  type RequestIdentity,
} from "@/lib/auth/request-context";
import { TEAM_HEADER } from "@/lib/team-path";
import type { Capability, PublicUser } from "@/lib/types";

/**
 * The GraphQL request context.
 */
export interface GraphQLContext {
  viewer: PublicUser | null;
  teamId: string | null;
  capabilities: Capability[];
  /** How this request authenticated - useful for docs/debugging, not security. */
  via: "cookie" | "token" | "anonymous";
  /**
   * Set for a valid bearer-token request.
   */
  identity: RequestIdentity | null;
}

/**
 * Build the per-request context.
 */
export async function buildContext(request: Request): Promise<GraphQLContext> {
  const auth = request.headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : null;

  if (bearer) {
    // A token's scope can span teams, and everything below this line is scoped to
    // exactly one. Unset or unreachable falls back to the first team in the token's
    // scope, deterministically.
    const identity = await authenticateToken(
      bearer,
      request.headers.get(TEAM_HEADER),
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

  // Cookie path - same-origin browser. The team comes from the page's URL via
  // `x-deplo-team` (lib/graphql-client.ts), which getActiveTeamId reads: this
  // endpoint is flat, so the header is the only thing that carries it.
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
