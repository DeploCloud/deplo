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
  via: "cookie" | "token" | "anonymous";
  identity: RequestIdentity | null;
}

export async function buildContext(request: Request): Promise<GraphQLContext> {
  const auth = request.headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : null;

  if (bearer) {
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

  const viewer = await getCurrentUser();
  let teamId: string | null = null;
  let capabilities: Capability[] = [];
  try {
    teamId = await getActiveTeamId();
    capabilities = await reachableCapabilities();
  } catch (e) {
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
