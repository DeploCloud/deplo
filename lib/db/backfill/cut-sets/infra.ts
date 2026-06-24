import { count, inArray } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import type { Activity, DevSshUser, DeploData } from "../../../types";
import {
  activityToRow,
  devSshUserToRow,
  githubAppToRow,
  githubInstallationToRow,
  serverToRow,
} from "../../../data/infra-rows";
import {
  activities,
  devSshUser,
  githubApps,
  githubInstallation,
  inviteCapabilities,
  invites,
  servers,
} from "../../schema/control-plane";
import { cleanCapabilities } from "../normalize";
import type { CutSetCopy } from "../engine";
import type { BackfillTx } from "../types";
import { seedIdentityRoots } from "../roots";

/**
 * Cut-set (e) — infra / integrations (relational-store PLAN Step 6). The
 * collections cut-sets (a)–(d) never migrated, now copied from the fresh JSONB at
 * the cut-set's switch moment: `servers`, `invites` (+`invite_capabilities`),
 * `github_apps` + `github_installation`, `dev_ssh_user`, `activities`. It runs
 * LAST (after identity (b) and the project graph (c)), because its FKs reference
 * `teams` (cut-set (b)) and `projects` (cut-set (c)), which are already relational.
 *
 * Backfill specifics (PLAN §7):
 *  - **FK roots.** Identity (teams/users) is seeded idempotently — `invites`,
 *    `github_apps`, `activities` all carry a NOT-NULL `team_id`. `servers` is
 *    instance-wide (no team FK); this cut-set is its AUTHORITATIVE copy (cut-sets
 *    (c)/(d) seeded it idempotently as a bridge, so `onConflictDoNothing` composes).
 *  - **FK-ordered copy** (PLAN §2): `servers` → `invites`(+caps) → `github_apps`
 *    → `github_installation` → `dev_ssh_user` → `activities`.
 *  - **Orphan prune.** `dev_ssh_user.project_id` is `ON DELETE CASCADE` (a dead
 *    project id would FK-violate), so a dev SSH user whose project is gone is
 *    PRUNED. `activities.project_id` is `ON DELETE SET NULL` (history outlives the
 *    project), so a dangling `projectId` is NULLED, not dropped.
 *  - **`seq` in source-array order** (PLAN §5). `activities.seq` is a
 *    `bigint identity` the DB assigns; the copy inserts in JSONB array order
 *    (which encodes `Array.push` order) so `seq` reproduces insertion order and
 *    list ordering `(created_at DESC, seq DESC)` matches the original history.
 *  - **`invites` capabilities.** `cleanCapabilities` is run before exploding the
 *    junction (drops unknown caps), mirroring the identity cut-set's membership
 *    handling.
 *  - **Reconcile is element-granular** (PLAN §7): row counts AFTER prune, and
 *    every FK resolves.
 *
 * `migrate()` (run by `normalizeForBackfill` before this copy) already stamped a
 * legacy row's `teamId`, so the rows reaching here are model-current; this cut-set
 * prunes dangling project FKs + explodes the nested server agent/bootstrap.
 */

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

async function copyInfra(tx: BackfillTx, data: DeploData): Promise<void> {
  // FK roots: identity (teams/users) for the NOT-NULL team FKs on invites /
  // github_apps / activities. `servers` has no team FK; this cut-set owns it.
  await seedIdentityRoots(tx, data);

  // Live project set (cut-set (c) already migrated projects; the still-live JSONB
  // carries the same set at switch time) — used to prune/NULL dangling project FKs.
  const liveProjectIds = new Set(data.projects.map((p) => p.id));

  /* --- servers (instance-wide; AUTHORITATIVE copy — composes over the c/d
        bridge seeds via ON CONFLICT DO NOTHING) --- */
  if (data.servers.length > 0) {
    await tx
      .insert(servers)
      .values(data.servers.map(serverToRow))
      .onConflictDoNothing();
  }

  /* --- invites (+ invite_capabilities) (FK: teams CASCADE) --- */
  if (data.invites.length > 0) {
    await tx.insert(invites).values(
      data.invites.map((i) => ({
        id: i.id,
        teamId: i.teamId,
        email: i.email,
        role: i.role,
        tokenHash: i.tokenHash,
        status: i.status,
        invitedBy: i.invitedBy,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
        acceptedAt: i.acceptedAt,
      })),
    );
    const inviteCaps = data.invites.flatMap((i) =>
      cleanCapabilities(i.capabilities, i.role).map((capability) => ({
        inviteId: i.id,
        capability,
      })),
    );
    if (inviteCaps.length > 0) {
      await tx.insert(inviteCapabilities).values(inviteCaps);
    }
  }

  /* --- github_apps → github_installation (installation FK: app CASCADE) --- */
  if (data.githubApps.length > 0) {
    await tx.insert(githubApps).values(data.githubApps.map(githubAppToRow));
  }
  // Only installations whose parent app is present (a dangling app_id would
  // FK-violate; the JSONB never orphans these, but guard for fidelity).
  const liveAppIds = new Set(data.githubApps.map((a) => a.id));
  const liveInstalls = (data.githubInstallations ?? []).filter((i) =>
    liveAppIds.has(i.appId),
  );
  if (liveInstalls.length > 0) {
    await tx
      .insert(githubInstallation)
      .values(liveInstalls.map(githubInstallationToRow));
  }

  /* --- dev_ssh_user (FK: projects CASCADE → PRUNE dead project) --- */
  const liveSshUsers = data.devSshUsers.filter((u) =>
    liveProjectIds.has(u.projectId),
  );
  if (liveSshUsers.length > 0) {
    await tx.insert(devSshUser).values(liveSshUsers.map(devSshUserToRow));
  }

  /* --- activities (FK: teams CASCADE + projects SET NULL → NULL dead project).
        Insert in source-array order so the identity `seq` reproduces insertion
        order (PLAN §5). --- */
  const activityRows = data.activities.map((a) =>
    nullDeadActivityProject(a, liveProjectIds),
  );
  if (activityRows.length > 0) {
    await tx.insert(activities).values(activityRows.map(activityToRow));
  }

  await reconcileInfra(tx, data);
}

/** Null an activity's `projectId` when its project is gone (SET NULL FK). */
function nullDeadActivityProject(
  a: Activity,
  liveProjectIds: Set<string>,
): Activity {
  return {
    ...a,
    projectId:
      a.projectId && liveProjectIds.has(a.projectId) ? a.projectId : null,
  };
}

/* ------------------------------------------------------------------ */
/* Reconcile (element-granular)                                         */
/* ------------------------------------------------------------------ */

async function rowCount(tx: BackfillTx, table: PgTable): Promise<number> {
  const r = await tx.select({ n: count() }).from(table);
  return r[0]?.n ?? 0;
}

function fail(msg: string): never {
  // A reconcile mismatch throws so the engine's tx rolls back, the marker is not
  // written, and the next boot re-runs the copy from the still-live JSONB.
  throw new Error(`[backfill:infra] reconcile mismatch: ${msg}`);
}

/**
 * Element-granular reconciliation of the infra cut-set against the source `data`
 * (PLAN §7). Counts are AFTER the orphan prune (dev_ssh_user dead-project) so the
 * expected values are computed over the SAME live sets the copy inserted. Exported
 * so a test can drive a mismatch the DB constraints alone wouldn't catch.
 */
export async function reconcileInfra(
  tx: BackfillTx,
  data: DeploData,
): Promise<void> {
  const liveProjectIds = new Set(data.projects.map((p) => p.id));

  /* (1) servers — copied whole (instance-wide, no prune). */
  const serverCount = await rowCount(tx, servers);
  if (serverCount !== data.servers.length)
    fail(`servers ${serverCount} != ${data.servers.length}`);

  /* (2) invites — copied whole (team FK roots seeded, no prune). */
  const inviteCount = await rowCount(tx, invites);
  if (inviteCount !== data.invites.length)
    fail(`invites ${inviteCount} != ${data.invites.length}`);

  /* (3) github_apps — copied whole; installations after the dead-app guard. */
  const appCount = await rowCount(tx, githubApps);
  if (appCount !== data.githubApps.length)
    fail(`github_apps ${appCount} != ${data.githubApps.length}`);
  const liveAppIds = new Set(data.githubApps.map((a) => a.id));
  const expectedInstalls = (data.githubInstallations ?? []).filter((i) =>
    liveAppIds.has(i.appId),
  );
  const installCount = await rowCount(tx, githubInstallation);
  if (installCount !== expectedInstalls.length)
    fail(`github_installation ${installCount} != ${expectedInstalls.length}`);

  /* (4) dev_ssh_user — count AFTER the dead-project prune. */
  const expectedSsh = data.devSshUsers.filter((u) =>
    liveProjectIds.has(u.projectId),
  );
  const sshCount = await rowCount(tx, devSshUser);
  if (sshCount !== expectedSsh.length)
    fail(`dev_ssh_user ${sshCount} != ${expectedSsh.length}`);

  /* (5) activities — copied whole (dead project NULLED, not dropped). */
  const activityCount = await rowCount(tx, activities);
  if (activityCount !== data.activities.length)
    fail(`activities ${activityCount} != ${data.activities.length}`);

  /* (6) every kept dev_ssh_user's project resolves, and its CHECK (at least one
        credential) holds — assert here so a bad prune surfaces clearly. */
  for (const u of expectedSsh) {
    if (!liveProjectIds.has(u.projectId))
      fail(`dev_ssh_user ${u.id} references missing project ${u.projectId}`);
    if (u.publicKey === null && u.passwordEnc === null)
      fail(`dev_ssh_user ${u.id} has no credential (violates CHECK)`);
  }

  /* (7) every persisted activity's non-null projectId is live (the dead ones were
        NULLED). The team FK is guaranteed by the seeded roots. */
  if (data.activities.length > 0) {
    const persisted = await tx
      .select({ id: activities.id, projectId: activities.projectId })
      .from(activities);
    for (const a of persisted) {
      if (a.projectId && !liveProjectIds.has(a.projectId))
        fail(`activity ${a.id} kept a dead projectId ${a.projectId}`);
    }
  }

  /* (8) every github_installation's parent app resolves. */
  if (expectedInstalls.length > 0) {
    const appIds = [...new Set(expectedInstalls.map((i) => i.appId))];
    const present = new Set(
      (
        await tx
          .select({ id: githubApps.id })
          .from(githubApps)
          .where(inArray(githubApps.id, appIds))
      ).map((r) => r.id),
    );
    for (const i of expectedInstalls) {
      if (!present.has(i.appId))
        fail(`github_installation ${i.id} references missing app ${i.appId}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

/** The infra cut-set's copy, for {@link runBackfill}. */
export const infraCutSetCopy: CutSetCopy = copyInfra;

/** Re-exported for tests that construct the prune scenarios directly. */
export type { DevSshUser };
