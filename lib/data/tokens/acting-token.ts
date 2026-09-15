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
    const m = await membershipFor(userId, teamId).catch(() => null);
    if (m) for (const c of m.capabilities) held.add(c);
  }
  const acting = currentIdentity()?.token;
  const ceiling = acting
    ? boundedBy([...held], acting.capabilities)
    : [...held];
  return withinActor(caps, { capabilities: ceiling } as Membership, "token");
}

export function requireOwnOrSession(tokenId: string): void {
  const acting = currentIdentity()?.token;
  if (acting && acting.id !== tokenId) throw new Error("Token not found");
}

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
