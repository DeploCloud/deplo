import { count, eq } from "drizzle-orm";

import type { Capability, DeploData } from "../../../types";
import {
  memberships,
  membershipCapabilities,
  registrationLinks,
  teams,
  users,
} from "../../schema/control-plane";
import type { CutSetCopy } from "../engine";
import type { BackfillTx } from "../types";
import { cleanCapabilities } from "../normalize";

/**
 * Cut-set (b) — identity / auth (relational-store PLAN §3 "Cut-set (b)", Step 3).
 * Copies `users` + `teams` + `memberships` (+ the `membership_capabilities`
 * junction) + `registrationLinks` from the fresh JSONB into the relational tables
 * at the cut-set's switch moment.
 *
 * This is the authoritative owner of the identity roots (`teams`/`users`), but it
 * runs AFTER the leaf cut-set (a) (PLAN §3 ordering), which already
 * `seedIdentityRoots`-seeded those same rows so its NOT-NULL FKs resolved. So the
 * teams/users inserts use `onConflictDoNothing()`: whichever cut-set ran first
 * inserts, the other no-ops over the identical app-minted ids (the keys are
 * stable). The element-granular reconcile below then asserts fidelity against the
 * source either way (the raw collection length IS the expected count — no prune
 * for identity).
 *
 * Backfill specifics (PLAN §7):
 *  - `membership.capabilities` → the `membership_capabilities` junction, run
 *    through `cleanCapabilities` first (coerce legacy values, always imply
 *    `view`) so the junction holds the same canonical set the live data layer
 *    reassembles (PLAN §2 `membership_capabilities`, "run cleanCapabilities at
 *    backfill").
 *  - No orphan prune: identity has no inbound dangling-id hazard (the
 *    deleteProject orphan bug is a project-graph concern, cut-set (c)).
 */

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

/** Canonical capability set for a membership, as the junction stores it. */
function membershipCaps(m: {
  capabilities?: Capability[];
  role: DeploData["memberships"][number]["role"];
}): Capability[] {
  return cleanCapabilities(m.capabilities, m.role);
}

async function copyIdentity(tx: BackfillTx, data: DeploData): Promise<void> {
  // FK-ordered: teams → users → memberships → membership_capabilities →
  // registration_links (PLAN §2 "FK ordering ... roots first").
  if (data.teams.length > 0) {
    await tx
      .insert(teams)
      .values(
        data.teams.map((t) => ({
          id: t.id,
          name: t.name,
          slug: t.slug,
          plan: t.plan,
          createdAt: t.createdAt,
        })),
      )
      .onConflictDoNothing();
  }

  if (data.users.length > 0) {
    await tx
      .insert(users)
      .values(
        data.users.map((u) => ({
          id: u.id,
          email: u.email,
          username: u.username,
          name: u.name,
          passwordHash: u.passwordHash,
          role: u.role,
          isInstanceAdmin: Boolean(u.isInstanceAdmin),
          suspended: Boolean(u.suspended),
          canExposePorts: Boolean(u.canExposePorts),
          canMountHostVolumes: Boolean(u.canMountHostVolumes),
          avatarColor: u.avatarColor,
          createdAt: u.createdAt,
        })),
      )
      .onConflictDoNothing();
  }

  if (data.memberships.length > 0) {
    await tx
      .insert(memberships)
      .values(
        data.memberships.map((m) => ({
          id: m.id,
          userId: m.userId,
          teamId: m.teamId,
          role: m.role,
          createdAt: m.createdAt,
        })),
      )
      .onConflictDoNothing();

    const caps = data.memberships.flatMap((m) =>
      membershipCaps(m).map((c) => ({ membershipId: m.id, capability: c })),
    );
    if (caps.length > 0)
      await tx.insert(membershipCapabilities).values(caps).onConflictDoNothing();
  }

  const links = data.registrationLinks ?? [];
  if (links.length > 0) {
    await tx.insert(registrationLinks).values(
      links.map((l) => ({
        id: l.id,
        tokenHash: l.tokenHash,
        status: l.status,
        createdBy: l.createdBy,
        usedByUsername: l.usedByUsername ?? null,
        expiresAt: l.expiresAt,
        createdAt: l.createdAt,
        usedAt: l.usedAt ?? null,
      })),
    );
  }

  await reconcileIdentity(tx, data);
}

/* ------------------------------------------------------------------ */
/* Reconcile (element-granular)                                         */
/* ------------------------------------------------------------------ */

async function rowCount(
  tx: BackfillTx,
  table:
    | typeof users
    | typeof teams
    | typeof memberships
    | typeof membershipCapabilities
    | typeof registrationLinks,
): Promise<number> {
  const r = await tx.select({ n: count() }).from(table);
  return r[0]?.n ?? 0;
}

function fail(msg: string): never {
  // A reconcile mismatch throws so the engine's tx rolls back, the marker is not
  // written, and the next boot re-runs the copy from the still-live JSONB.
  throw new Error(`[backfill:identity] reconcile mismatch: ${msg}`);
}

/**
 * Element-granular reconciliation of the identity cut-set against the source
 * `data`. Throws on the first mismatch (so the engine's tx rolls back, the marker
 * is not written, and the next boot re-runs from the still-live JSONB). Exported
 * so a test can drive a mismatch the DB constraints alone wouldn't catch (a count
 * or a capability-set drift).
 */
export async function reconcileIdentity(
  tx: BackfillTx,
  data: DeploData,
): Promise<void> {
  // (1) Exact row counts — no prune for identity, so the raw collection size IS
  // the expected count.
  const userCount = await rowCount(tx, users);
  if (userCount !== data.users.length)
    fail(`users ${userCount} != ${data.users.length}`);

  const teamCount = await rowCount(tx, teams);
  if (teamCount !== data.teams.length)
    fail(`teams ${teamCount} != ${data.teams.length}`);

  const membershipCount = await rowCount(tx, memberships);
  if (membershipCount !== data.memberships.length)
    fail(`memberships ${membershipCount} != ${data.memberships.length}`);

  const links = data.registrationLinks ?? [];
  const linkCount = await rowCount(tx, registrationLinks);
  if (linkCount !== links.length)
    fail(`registration_links ${linkCount} != ${links.length}`);

  // (2) membership_capabilities: total == Σ cleanCapabilities(...).length, and
  // per-membership the persisted set EQUALS the canonical clean set.
  const expectedCapTotal = data.memberships.reduce(
    (sum, m) => sum + membershipCaps(m).length,
    0,
  );
  const capTotal = await rowCount(tx, membershipCapabilities);
  if (capTotal !== expectedCapTotal)
    fail(`membership_capabilities ${capTotal} != ${expectedCapTotal}`);

  for (const m of data.memberships) {
    // FK resolution: every membership's user + team must exist.
    const u = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, m.userId))
      .limit(1);
    if (u.length === 0)
      fail(`membership ${m.id} references missing user ${m.userId}`);
    const t = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.id, m.teamId))
      .limit(1);
    if (t.length === 0)
      fail(`membership ${m.id} references missing team ${m.teamId}`);

    // Capability set equality (order-independent).
    const persisted = await tx
      .select({ capability: membershipCapabilities.capability })
      .from(membershipCapabilities)
      .where(eq(membershipCapabilities.membershipId, m.id));
    const got = new Set(persisted.map((r) => r.capability));
    const want = new Set(membershipCaps(m));
    if (got.size !== want.size || [...want].some((c) => !got.has(c)))
      fail(
        `membership ${m.id} capabilities ${[...got].sort().join(",")} != ${[
          ...want,
        ]
          .sort()
          .join(",")}`,
      );
  }
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

/** The identity cut-set's copy, for {@link runBackfill}. */
export const identityCutSetCopy: CutSetCopy = copyIdentity;
