import "server-only";

import { getCurrentUser } from "@/lib/auth/current-user";
import {
  getActiveTeamId,
  reachableCapabilities,
  PasswordChangeRequiredError,
  TwoFactorRequiredError,
} from "@/lib/membership";
import { authenticateToken } from "@/lib/data/tokens/authenticate";
import {
  runWithIdentity,
  type RequestIdentity,
} from "@/lib/auth/request-context";
import { GraphQLError } from "graphql";
import { TEAM_HEADER, TeamUnavailableError } from "@/lib/team-path";
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
    ).catch(forbidden);
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
    if (
      !(e instanceof TwoFactorRequiredError) &&
      !(e instanceof PasswordChangeRequiredError)
    )
      forbidden(e);
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

// A GraphQLError leaves yoga as it is: a raw error is masked and logged, and Next's patched inspect crashed that log (c42: a 500).
function forbidden(e: unknown): never {
  if (e instanceof TeamUnavailableError)
    throw new GraphQLError(e.message, {
      extensions: { code: "FORBIDDEN", http: { status: 403 } },
    });
  throw e;
}
