import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  apps as appsTable,
  appPreviews as appPreviewsTable,
  databases as databasesTable,
  installedPlugins as installedPluginsTable,
  teams as teamsTable,
  backupDestination as backupDestinationTable,
} from "../db/schema/control-plane";
import { currentIdentity } from "../auth/request-context";
import {
  isInstanceAdmin,
  requireMembership,
  setActiveTeam,
  teamsForUser,
} from "../membership";
import { pluginSlug, destroyPluginContainer } from "../plugins/runtime";
import { mapLimit } from "../utils";
import { withKeyedLock } from "./keyed-mutex";
import { loadAppsByTeam } from "./app-graph-load";
import {
  getDestinationWithSecretsForTeam,
  type DestinationWithSecrets,
} from "./destinations";
import { deleteFromDestination } from "./backup-transport";
import {
  enqueueTeardowns,
  teardownOrQueue,
  type TeardownEntry,
} from "./teardown-queue";
import { removeUploads } from "../deploy/upload";

/**
 * Deleting a team is the one action that outranks `manage_team`: it implicitly
 * removes every membership INCLUDING the founder's, so letting any assigned owner
 * fire it would sidestep the "founder is unremovable" invariant
 * (lib/data/members.ts).
 */

interface DeleteTeamContext {
  userId: string;
  teamId: string;
  /** Whether the caller may delete the active team at all. */
  allowed: boolean;
  /** The caller's last team — deleting it would strand them teamless. */
  onlyTeam: boolean;
}

async function deleteTeamContext(): Promise<DeleteTeamContext> {
  const { userId, teamId, membership } = await requireMembership();
  // Fail CLOSED on a rescoped bearer token: when a token's team no longer matches the
  // resolved active team, getActiveTeamId has silently fallen back to the principal's
  // first team (a stale token kept by a team the user left must never be able to
  // destroy a DIFFERENT team the user founded).
  const override = currentIdentity();
  if (override && override.teamId !== teamId) {
    throw new Error(
      "This token is scoped to a team the user no longer belongs to",
    );
  }
  const rows = await getDb()
    .select({ founderUserId: teamsTable.founderUserId })
    .from(teamsTable)
    .where(eq(teamsTable.id, teamId))
    .limit(1);
  if (!rows[0]) throw new Error("No team");
  const founderId = rows[0].founderUserId;
  // Two independent gates, and both matter for a BEARER TOKEN: - `isInstanceAdmin()`
  // (not the stored flag) because instance-admin is opt-in per token — a plain token
  // minted by an admin is not an admin; - `delete_team` because being the founder
  // says WHO you are, not what the credential in hand may do.
  const allowed =
    (await isInstanceAdmin()) ||
    ((founderId ? userId === founderId : membership.role === "owner") &&
      membership.capabilities.includes("delete_team"));
  const onlyTeam = (await teamsForUser(userId)).length <= 1;
  return { userId, teamId, allowed, onlyTeam };
}

/**
 * Whether the current user may delete the active team, for gating the
 * Settings → General danger zone. Never throws (a viewer with no membership
 * simply sees no danger zone).
 */
export async function canDeleteTeam(): Promise<{
  allowed: boolean;
  onlyTeam: boolean;
}> {
  try {
    const { allowed, onlyTeam } = await deleteTeamContext();
    return { allowed, onlyTeam };
  } catch {
    return { allowed: false, onlyTeam: false };
  }
}

/**
 * Everything the post-delete stack teardown needs, captured BEFORE the rows go.
 * Shared with {@link ./user-delete}, which deletes teams (and individual apps)
 * on the same terms.
 */
export interface TeardownPlan {
  /** Structural: an assembled App (lib/types.ts) satisfies it, and so does a bare row. */
  services: { id: string; slug: string; serverId: string }[];
  /**
   * Live pull request preview stacks, snapshotted the same way: each is its own
   * container + volume set under `deplo-<slug>__pr-<n>`, invisible to the app's
   * own teardown.
   */
  previewStacks?: { id: string; deployKey: string; serverId: string }[];
  databases: { id: string; host: string; serverId: string }[];
  /** Frozen slugs of the team's installed plugins (containers on the Deplo host). */
  appSlugs: string[];
  /**
   * The team's backup destinations WITH their decrypted credentials, frozen before
   * the cascade takes the rows away - the same reason `services` and `databases`
   * are frozen.
   */
  backupSweeps?: {
    creds: DestinationWithSecrets;
    prefix: string;
    viaServerId: string;
  }[];
}

/**
 * Best-effort teardown of every stack the deleted team owned, DETACHED from the
 * request: the mutation already deleted the rows and responded (a team-wide
 * fan-out can run for minutes — one hung agent holds a 3-minute deadline — and a
 * synchronous teardown would blow past proxy timeouts, surfacing a false failure
 * for a delete that succeeded).
 */
export function teardownTeamResources(
  plan: TeardownPlan,
  tag = "team-delete",
): void {
  void (async () => {
    // Backup artifacts first, while nothing else has had a chance to fail: they
    // are the only leftovers that can outlive the host itself (an S3 bucket does
    // not care that the server is gone).
    await mapLimit(plan.backupSweeps ?? [], 2, async (sweep) => {
      try {
        const r = await deleteFromDestination(
          sweep.creds,
          sweep.viaServerId,
          sweep.prefix,
          true,
        );
        if (!r.ok)
          throw new Error(r.error || "the destination refused the delete");
      } catch (e) {
        console.warn(
          `[${tag}] could not remove the backups at ${sweep.creds.destination.name}: ` +
            (e instanceof Error ? e.message : String(e)) +
            " - those artifacts must be removed from that destination by hand",
        );
      }
    });

    // Volumes go with every one of these: deleting a team deletes the team, and leaving
    // its apps' data behind meant an unreclaimable pile on every host it ever deployed
    // to, with not a single row left that could name it.
    const previews: TeardownEntry[] = (plan.previewStacks ?? []).map((p) => ({
      serverId: p.serverId,
      deployKey: p.deployKey,
      projectLabel: p.id,
      label: `the preview stack ${p.deployKey}`,
      teamId: null,
    }));
    const stacks: TeardownEntry[] = plan.services.map((service) => ({
      serverId: service.serverId,
      deployKey: service.slug,
      projectLabel: service.id,
      label: service.slug,
      teamId: null,
    }));
    const dbs: TeardownEntry[] = plan.databases.map((d) => ({
      serverId: d.serverId,
      deployKey: d.host,
      projectLabel: d.id,
      label: d.host,
      teamId: null,
    }));
    // Write-ahead, in one statement, before the first dial. The team row is
    // gone: these entries are the only thing that can still name these stacks.
    await enqueueTeardowns([...previews, ...stacks, ...dbs]);

    // Previews first: they own volumes, and their rows are already gone.
    await mapLimit(previews, 4, async (e) => {
      await teardownOrQueue(e).catch(() => false);
    });
    await mapLimit(stacks, 4, async (e) => {
      await teardownOrQueue(e).catch(() => false);
    });
    await mapLimit(plan.services, 4, async (service) => {
      await removeUploads(service.id).catch(() => {});
    });
    await mapLimit(dbs, 4, async (e) => {
      // Same per-database lifecycle lock as deleteDatabase: a teardown must
      // wait out an in-flight provision, or its `down -v` could interleave
      // with the provision's `up -d` and leave an untracked container behind.
      await withKeyedLock(e.projectLabel, async () => {
        await teardownOrQueue(e).catch(() => false);
      });
    });
    for (const slug of plan.appSlugs) {
      await destroyPluginContainer(slug).catch(() => {});
    }
  })().catch((e) =>
    console.warn(
      `[${tag}] background teardown failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    ),
  );
}

/**
 * Permanently delete a team.
 */
export async function deleteTeam(teamId: string): Promise<void> {
  const ctx = await deleteTeamContext();
  if (teamId !== ctx.teamId)
    throw new Error(
      "The team to delete is no longer the active team — reload and try again",
    );
  if (!ctx.allowed)
    throw new Error(
      "You don't have permission to delete this team — only its primary owner, with permission to delete the team, or an instance admin can",
    );
  // Fast-path only — the enforcement re-check runs under the lock below.
  if (ctx.onlyTeam)
    throw new Error(
      "You can't delete your only team — create another team first",
    );

  const db = getDb();
  // Serialize the guard + delete per USER: two concurrent deletes of the caller's two
  // teams would each see the other team still alive and strand the caller with zero
  // teams — exactly what the only-team guard exists to prevent.
  const plan = await withKeyedLock(
    `team-delete:${ctx.userId}`,
    async (): Promise<TeardownPlan | null> => {
      const mine = await teamsForUser(ctx.userId);
      // A concurrent call already deleted it — idempotent, nothing to tear down.
      if (!mine.some((t) => t.id === ctx.teamId)) return null;
      if (mine.length <= 1)
        throw new Error(
          "You can't delete your only team — create another team first",
        );

      // Snapshot the teardown targets IMMEDIATELY before the delete, so apps/databases
      // created while this request was in flight are still caught (rows born after this
      // point are lost to the cascade, but the window is now milliseconds, not the length
      // of the agent fan-out).
      const services = await loadAppsByTeam(ctx.teamId);
      // Live pull request preview stacks: each is its own container + volume set
      // under `deplo-<slug>__pr-<n>`, and the cascade below drops the only rows
      // that name them.
      const previewStacks = (
        await db
          .select({
            id: appPreviewsTable.id,
            deployKey: appPreviewsTable.deployKey,
            // Previews may be pinned to their own machine: that is where the
            // stack is, so that is the host that has to be dialed.
            serverId: sql<string>`coalesce(${appsTable.previewServerId}, ${appsTable.serverId})`,
          })
          .from(appPreviewsTable)
          .innerJoin(appsTable, eq(appsTable.id, appPreviewsTable.appId))
          .where(
            and(
              eq(appsTable.teamId, ctx.teamId),
              isNull(appPreviewsTable.tornDownAt),
            ),
          )
      ).map((r) => ({
        id: r.id,
        deployKey: r.deployKey,
        serverId: r.serverId,
      }));
      const databases = await db
        .select({
          id: databasesTable.id,
          host: databasesTable.host,
          serverId: databasesTable.serverId,
        })
        .from(databasesTable)
        .where(eq(databasesTable.teamId, ctx.teamId));
      const team = (
        await db
          .select({ slug: teamsTable.slug })
          .from(teamsTable)
          .where(eq(teamsTable.id, ctx.teamId))
          .limit(1)
      )[0];
      const apps = await db
        .select({
          slug: installedPluginsTable.slug,
          catalogId: installedPluginsTable.catalogId,
        })
        .from(installedPluginsTable)
        .where(eq(installedPluginsTable.teamId, ctx.teamId));

      // One DELETE — the FK CASCADEs remove every team-scoped row.
      await db.delete(teamsTable).where(eq(teamsTable.id, ctx.teamId));

      // Any host will do for a BUCKET (the agent just needs network + creds); a
      // store destination routes to its own server regardless. With no server at
      // all there is nothing to dial and the sweep is skipped.
      const viaServerId = services[0]?.serverId ?? databases[0]?.serverId ?? "";
      const destinationIds = (
        await db
          .select({ id: backupDestinationTable.id })
          .from(backupDestinationTable)
          .where(eq(backupDestinationTable.teamId, ctx.teamId))
      ).map((d) => d.id);
      const backupSweeps = (
        await Promise.all(
          destinationIds.map(async (id) => {
            try {
              const creds = await getDestinationWithSecretsForTeam(
                ctx.teamId,
                id,
              );
              const via = creds.destination.serverId ?? viaServerId;
              if (!via) return null;
              return {
                creds,
                prefix: `deplo/${ctx.teamId}/`,
                viaServerId: via,
              };
            } catch {
              return null; // a destination we cannot open is one we cannot sweep
            }
          }),
        )
      ).filter((x): x is NonNullable<typeof x> => x !== null);

      return {
        services,
        previewStacks,
        databases,
        backupSweeps,
        // Prefer the slug frozen at install; legacy rows derive it (the team
        // row was just read, before the delete).
        appSlugs: apps.map(
          (a) => a.slug || pluginSlug(a.catalogId, team?.slug ?? ""),
        ),
      };
    },
  );
  if (plan) teardownTeamResources(plan);

  // Point the active-team cookie at one of the caller's remaining teams (the
  // only-team guard ensures there is one).
  const remaining = await teamsForUser(ctx.userId);
  if (remaining[0]) await setActiveTeam(remaining[0].id).catch(() => {});
}
