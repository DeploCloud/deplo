import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apiTokens } from "../../db/schema/control-plane/api-tokens";
import { membershipFor } from "../../membership";
import { withinActor } from "../roles/member-capabilities";
import { boundedBy } from "../../membership-shared";
import type { Capability, Membership } from "../../types/identity";
import { currentIdentity } from "../../auth/request-context";
import { type ResolvedScope } from "./scope";

// assertScopeWithinActingToken - a SCOPED API token must not mint (or widen a
// token to reach) a team OUTSIDE its own scope.
export function assertScopeWithinActingToken(
  scope: ResolvedScope,
  scoped: boolean,
): void {
  const actingScope = currentIdentity()?.token?.scope;
  if (!actingScope) return;
  if (!scoped)
    throw new Error(
      "This API token is scoped, so it can't mint an unscoped token.",
    );
  const outside = scope.teamsReached.filter(
    (t) => !actingScope.teamIds.includes(t),
  );
  if (outside.length > 0)
    throw new Error(
      "This API token can't create a token that reaches a team outside its own scope.",
    );
}

// ownerCeiling - the ceiling on what a token may be given: everything its owner
// holds in ANY team it will reach. `clampToToken` then narrows it per team on
// every request, so a permission held in one team never leaks into another.
export async function ownerCeiling(
  userId: string,
  caps: Capability[] | undefined,
  reach: string[],
): Promise<Capability[]> {
  if (reach.length === 0)
    throw new Error(
      "You can't use API tokens in any of your teams. Ask a team admin for the API tokens permission.",
    );
  const held = new Set<Capability>();
  for (const teamId of reach) {
    // A team whose two-factor policy this member has not met resolves NOTHING
    // for them there, and `membershipFor` says so by throwing.
    const m = await membershipFor(userId, teamId).catch(() => null);
    if (m) for (const c of m.capabilities) held.add(c);
  }
  // A TOKEN never mints or re-authors a successor above ITSELF: `membershipFor`
  // clamps to the acting token only in the team the request resolved to, so the
  // union above carries the owner's UNCLAMPED set from every other team.
  const acting = currentIdentity()?.token;
  const ceiling = acting
    ? boundedBy([...held], acting.capabilities)
    : [...held];
  return withinActor(caps, { capabilities: ceiling } as Membership, "token");
}

// requireOwnOrSession - a bearer token edits or revokes ITSELF and nothing else:
// `listTokens` already hides its owner's other credentials from it, and a write
// must not reach what a read may not name.
export function requireOwnOrSession(tokenId: string): void {
  const acting = currentIdentity()?.token;
  if (acting && acting.id !== tokenId) throw new Error("Token not found");
}

// assertExpiryWithinActingToken - a token never mints a successor that outlives
// it. `undefined` is "leave the stored expiry alone", bounded when it was written.
export async function assertExpiryWithinActingToken(
  expiresAt: string | null | undefined,
): Promise<void> {
  if (expiresAt === undefined) return;
  const own = await actingTokenExpiry();
  if (!own) return;
  if (expiresAt === null || Date.parse(expiresAt) > Date.parse(own))
    throw new Error(
      "This API token expires, so a token it creates has to expire no later than it does.",
    );
}

// actingTokenExpiry - when the token doing the asking expires, or null (a person,
// or a token that never does).
export async function actingTokenExpiry(): Promise<string | null> {
  const acting = currentIdentity()?.token;
  if (!acting) return null;
  return (
    (
      await getDb()
        .select({ expiresAt: apiTokens.expiresAt })
        .from(apiTokens)
        .where(eq(apiTokens.id, acting.id))
        .limit(1)
    )[0]?.expiresAt ?? null
  );
}
