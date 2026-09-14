import "server-only";

import { getCurrentUser } from "@/lib/auth/current-user";
import {
  getActiveTeamId,
  reachableCapabilities,
  TwoFactorRequiredError,
} from "@/lib/membership";
import { authenticateToken } from "@/lib/data/tokens/authenticate";
import {
  runWithIdentity,
  type RequestIdentity,
} from "@/lib/auth/request-context";
import { TEAM_HEADER } from "@/lib/team-path";
import type { Capability, PublicUser } from "@/lib/types/identity";

export interface GraphQLContext {
  viewer: PublicUser | null;
  teamId: string | null;
  capabilities: Capability[];
  // How this request authenticated - for docs/debugging, not security.
  via: "cookie" | "token" | "anonymous";
  // Set for a valid bearer-token request.
  identity: RequestIdentity | null;
}

export async function buildContext(request: Request): Promise<GraphQLContext> {
  const auth = request.headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : null;

  if (bearer) {
    // A token's scope can span teams; unset or unreachable falls back to its first, deterministically.
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

  // This endpoint is flat, so `x-deplo-team` is the only thing carrying the page's team.
  const viewer = await getCurrentUser();
  let teamId: string | null = null;
  let capabilities: Capability[] = [];
  try {
    teamId = await getActiveTeamId();
    capabilities = await reachableCapabilities();
  } catch (e) {
    // A 2FA-locked member must still sign out and enrol; team-scoped reads refuse in lib/data.
    if (!(e instanceof TwoFactorRequiredError)) throw e;
    teamId = null;
    capabilities = [];
  }
  return {
    viewer,
    teamId,
    capabilities,
    via: viewer ? "cookie" : "anonymous",
    identity: null,
  };
}
