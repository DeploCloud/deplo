import "server-only";

import { and, desc, eq } from "drizzle-orm";
import {
  defaultFieldResolver,
  type GraphQLFieldResolver,
  type GraphQLSchema,
} from "graphql";

import { getDb } from "../../db/client";
import { deploMoves } from "../../db/schema/control-plane/deplo-move";

// ADR-0035: only the NEW Deplo ever freezes, and only while the old one's database copy lands in it.
export interface FrozenState {
  state: "copying";
  // The old Deplo it is copied from.
  peerUrl: string | null;
  message: string;
}

// Mutations that keep working while frozen: signing in and out, read-only probes, and the move itself.
export const FREEZE_ALLOWED_MUTATIONS: ReadonlySet<string> = new Set([
  "login",
  "verifyTwoFactorLogin",
  "passkeyChallenge",
  "verifyPasskeyLogin",
  "logout",
  "switchTeam",
  "checkServerHealth",
  "checkAllServerHealth",
  "verifyDomain",
  "createMoveCode",
  "cancelMoveCode",
  "connectDeploMove",
  "startDeploMove",
  "retryDeploMove",
  "cancelDeploMove",
  "finishDeploMoveWithoutSource",
]);

export class InstanceFrozenError extends Error {
  readonly status = 503;
  constructor(readonly frozen: FrozenState) {
    super(frozen.message);
    this.name = "InstanceFrozenError";
  }
}

export function frozenMessage(f: Pick<FrozenState, "peerUrl">): string {
  return `A Deplo is being copied here from ${f.peerUrl ?? "another machine"}. Changes are paused until its data is in.`;
}

export const FROZEN_CACHE_MS = 2_000;

// On globalThis: route handlers and instrumentation are separate bundles that must share one answer.
const CACHE_KEY = Symbol.for("deplo.move.frozen");
type Cached = { at: number; db: unknown; value: Promise<FrozenState | null> };
const slot = globalThis as unknown as { [CACHE_KEY]?: Cached };

export function invalidateFrozen(): void {
  delete slot[CACHE_KEY];
}

export function instanceFrozen(): Promise<FrozenState | null> {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return Promise.resolve(null);
  }
  const hit = slot[CACHE_KEY];
  if (hit && hit.db === db && Date.now() - hit.at < FROZEN_CACHE_MS)
    return hit.value;
  const value = readFrozen(db).catch((e) => {
    // Fails open like the rate limiter: with the database gone nothing can be written anyway.
    if (slot[CACHE_KEY]?.value === value) invalidateFrozen();
    console.warn("[deplo-move] could not read the freeze:", e);
    return null;
  });
  slot[CACHE_KEY] = { at: Date.now(), db, value };
  return value;
}

async function readFrozen(
  db: ReturnType<typeof getDb>,
): Promise<FrozenState | null> {
  const [row] = await db
    .select({ peerUrl: deploMoves.peerUrl })
    .from(deploMoves)
    .where(and(eq(deploMoves.side, "target"), eq(deploMoves.state, "copying")))
    .orderBy(desc(deploMoves.updatedAt))
    .limit(1);
  if (!row) return null;
  return {
    state: "copying",
    peerUrl: row.peerUrl,
    message: frozenMessage(row),
  };
}

export async function assertNotFrozen(): Promise<void> {
  const frozen = await instanceFrozen();
  if (frozen) throw new InstanceFrozenError(frozen);
}

// The REST gate: `const paused = await refuseWhileFrozen(); if (paused) return paused;`
export async function refuseWhileFrozen(): Promise<Response | null> {
  const frozen = await instanceFrozen();
  return frozen
    ? Response.json({ error: frozen.message }, { status: 503 })
    : null;
}

// Applied once to the built schema, so /api/graphql and MCP (which bypasses yoga) share one gate.
export function gateMutationsWhileFrozen(schema: GraphQLSchema): GraphQLSchema {
  const fields = schema.getMutationType()?.getFields() ?? {};
  for (const [name, field] of Object.entries(fields)) {
    if (FREEZE_ALLOWED_MUTATIONS.has(name)) continue;
    const resolve: GraphQLFieldResolver<unknown, unknown> =
      field.resolve ?? defaultFieldResolver;
    field.resolve = async function (this: unknown, ...args) {
      await assertNotFrozen();
      return resolve.apply(this, args);
    };
  }
  return schema;
}
