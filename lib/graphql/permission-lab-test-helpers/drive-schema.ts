import assert from "node:assert/strict";

import {
  runWithIdentity,
  type RequestIdentity,
  type TokenGrant,
} from "../../auth/request-context";
import { getCurrentUser } from "../../auth/current-user";
import { getActiveTeamId, reachableCapabilities } from "../../membership";
import { runGraphql } from "../../mcp/execute";
import { TEAM } from "./fixture-ids";
import { M, newApp } from "./mutations";

export interface Outcome {
  data: unknown;
  error?: string;
}

export async function gql(
  userId: string,
  query: string,
  variables: Record<string, unknown> = {},
  opts: { teamId?: string; token?: TokenGrant } = {},
): Promise<Outcome> {
  const identity: RequestIdentity = {
    userId,
    teamId: opts.teamId ?? TEAM,
    ...(opts.token ? { token: opts.token } : {}),
  };
  try {
    const ctx = await runWithIdentity(identity, async () => ({
      viewer: await getCurrentUser(),
      teamId: await getActiveTeamId(),
      capabilities: await reachableCapabilities(),
      via: opts.token ? ("token" as const) : ("cookie" as const),
      identity,
    }));
    return await runGraphql(query, variables, ctx);
  } catch (e) {
    return { data: null, error: (e as Error).message };
  }
}

const REFUSAL =
  /permission|not found|not authorized|unauthorized|can't|cannot|only |limited to|part of this team|not a member|no longer belongs|two-factor|hold yourself|isn't in this team|no active team/i;

export type Verdict = "allowed" | "refused" | "blocked";

export function verdict(r: Outcome): Verdict {
  if (!r.error) return "allowed";
  if (REFUSAL.test(r.error)) return "refused";
  assert.match(
    r.error,
    /lab: no host|unreachable|not provisioned/i,
    `an unexpected non-permission error: ${r.error}`,
  );
  return "blocked";
}

export function refused(r: Outcome, why: string): void {
  assert.equal(verdict(r), "refused", `${why} - got: ${r.error ?? "ok"}`);
}
export function passed(r: Outcome, why: string): void {
  assert.notEqual(verdict(r), "refused", `${why} - refused: ${r.error}`);
}

export function appLookup(r: Outcome): string | null {
  assert.equal(r.error, undefined, r.error ?? "");
  return (r.data as { app: { id: string } | null }).app?.id ?? null;
}

export function ids(r: Outcome, field: string): string[] {
  assert.equal(r.error, undefined, r.error ?? "");
  const rows = (r.data as Record<string, { id: string }[] | null>)[field];
  return (rows ?? []).map((x) => x.id).sort();
}

export function field<T>(r: Outcome, name: string): T {
  assert.equal(r.error, undefined, r.error ?? "");
  return (r.data as Record<string, T>)[name];
}

export async function throwawayApp(
  userId: string,
  name: string,
): Promise<string> {
  return field<{ id: string }>(
    await gql(userId, M.createApp, newApp(name)),
    "createApp",
  ).id;
}

export async function mintToken(
  userId: string,
  input: Record<string, unknown>,
  opts: { teamId?: string } = {},
): Promise<{ raw: string; token: TokenGrant }> {
  const { authenticateToken } = await import("../../data/tokens/authenticate");
  const raw = field<{ raw: string }>(
    await gql(userId, M.createToken, { input }, opts),
    "createToken",
  ).raw;
  const identity = await authenticateToken(raw, null);
  assert.ok(identity?.token, "the freshly minted token must authenticate");
  return { raw, token: identity.token };
}
