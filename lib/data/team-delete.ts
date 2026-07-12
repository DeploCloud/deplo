import "server-only";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  databases as databasesTable,
  devSshUser as devSshUserTable,
  installedPlugins as installedPluginsTable,
  teams as teamsTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { currentIdentity } from "../auth/request-context";
import {
  requireMembership,
  setActiveTeam,
  teamsForUser,
} from "../membership";
import { connectAgent } from "../infra/agent-client";
import { deprovisionUser } from "../infra/ssh-gateway";
import { pluginSlug, destroyPluginContainer } from "../plugins/runtime";
import { mapLimit } from "../utils";
import { withKeyedLock } from "./keyed-mutex";
import { loadAppsByTeam } from "./app-graph-load";
import { agentTeardownDev } from "../deploy/agent-dev";
import { removeUploads } from "../deploy/upload";
import type { App } from "../types";

/**
 * Deleting a team is the one action that outranks `manage_team`: it implicitly
 * removes every membership INCLUDING the founder's, so letting any assigned
 * owner fire it would sidestep the "founder is unremovable" invariant
 * (lib/data/members.ts). Hence the tighter gate: the founder ("crown"), an
 * instance admin (who must still be a MEMBER — the delete operates on the
 * active team, and a team can only be active for its members), or — on a
 * legacy team whose founder column was never backfilled / whose founder
 * account is gone — any owner.
 *
 * Lives in its own module (not teams.ts) because the teardown pulls in the
 * app-graph loader and the agent client; teams.ts stays a light identity
 * module that the layout imports on every request.
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
  // Fail CLOSED on a rescoped bearer token: when a token's team no longer
  // matches the resolved active team, getActiveTeamId has silently fallen back
  // to the principal's first team (a stale token kept by a team the user left
  // must never be able to destroy a DIFFERENT team the user founded).
  const override = currentIdentity();
  if (override && override.teamId !== teamId) {
    throw new Error(
      "This token is scoped to a team the user no longer belongs to",
    );
  }
  const user = (await getCurrentUser())!;
  const rows = await getDb()
    .select({ founderUserId: teamsTable.founderUserId })
    .from(teamsTable)
    .where(eq(teamsTable.id, teamId))
    .limit(1);
  if (!rows[0]) throw new Error("No team");
  const founderId = rows[0].founderUserId;
  const allowed =
    user.isInstanceAdmin ||
    (founderId ? userId === founderId : membership.role === "owner");
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

/** Everything the post-delete stack teardown needs, captured BEFORE the rows go. */
interface TeardownPlan {
  services: App[];
  /** Dev SSH gateway users to evict, resolved to their app's server. */
  sshUsers: { serverId: string; username: string }[];
  databases: { id: string; host: string; serverId: string }[];
  /** Frozen slugs of the team's installed plugins (containers on the Deplo host). */
  appSlugs: string[];
}

/**
 * Best-effort teardown of every stack the deleted team owned, DETACHED from the
 * request: the mutation already deleted the rows and responded (a team-wide
 * fan-out can run for minutes — one hung agent holds a 3-minute deadline — and
 * a synchronous teardown would blow past proxy timeouts, surfacing a false
 * failure for a delete that succeeded). Everything here works from the
 * pre-delete snapshot and never reads the cascaded tables; an unreachable host
 * leaves leftover containers to sweep by hand (warned, mirroring
 * deleteApp/deleteDatabase — there is no team activity feed left to record
 * on). Stacks are dialed directly by the snapshot's `serverId` because
 * `teardownApp()` re-resolves the owning server from rows that no longer
 * exist.
 */
function teardownTeamResources(plan: TeardownPlan): void {
  void (async () => {
    await mapLimit(plan.services, 4, async (service) => {
      try {
        const conn = await connectAgent(service.serverId);
        try {
          const r = await conn.destroyStack(service.slug);
          if (!r.ok) throw new Error(r.error || "agent failed to destroy the stack");
        } finally {
          conn.close();
        }
      } catch (e) {
        console.warn(
          `[team-delete] could not tear down ${service.slug} ` +
            `(${e instanceof Error ? e.message : String(e)}) — leftover ` +
            `containers on its host must be removed manually`,
        );
      }
      await agentTeardownDev(service).catch(() => {});
      await removeUploads(service.id).catch(() => {});
    });
    for (const u of plan.sshUsers) {
      await deprovisionUser(u.serverId, u.username).catch(() => {});
    }
    await mapLimit(plan.databases, 4, async (d) => {
      // Same per-database lifecycle lock as deleteDatabase: a teardown must
      // wait out an in-flight provision, or its `down -v` could interleave
      // with the provision's `up -d` and leave an untracked container behind.
      await withKeyedLock(d.id, async () => {
        try {
          const conn = await connectAgent(d.serverId);
          try {
            const r = await conn.destroyStack(d.host, true);
            if (!r.ok)
              console.warn(
                `[team-delete] agent did not cleanly tear down ${d.host} ` +
                  `(${r.error || "unknown error"}) — its data volume may be orphaned`,
              );
          } finally {
            conn.close();
          }
        } catch (e) {
          console.warn(
            `[team-delete] could not reach the agent for database ${d.host} ` +
              `(${e instanceof Error ? e.message : String(e)}) — its ` +
              `container/volume may need a manual cleanup`,
          );
        }
      });
    });
    for (const slug of plan.appSlugs) {
      await destroyPluginContainer(slug).catch(() => {});
    }
  })().catch((e) =>
    console.warn(
      `[team-delete] background teardown failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    ),
  );
}

/**
 * Permanently delete a team. `teamId` must equal the ACTIVE team — the client
 * echoes back the id of the team the user actually confirmed, so a mid-flight
 * active-team change in another tab fails closed instead of deleting whatever
 * team the cookie resolves to at execution time.
 *
 * Removes the team row in ONE delete — the FK CASCADEs drop everything
 * team-scoped: memberships, invites, folders, projects (+ environments),
 * apps (+ deployments, env vars, domains…), databases, backup schedules
 * AND run history, S3 destinations, installed plugins, tokens, activities. The
 * stack teardown (apps, databases including data volumes, dev containers,
 * SSH users, installed plugins) continues in the background from a pre-delete
 * snapshot. Backup ARCHIVES already uploaded to S3 buckets are kept — only the
 * records go.
 */
export async function deleteTeam(teamId: string): Promise<void> {
  const ctx = await deleteTeamContext();
  if (teamId !== ctx.teamId)
    throw new Error(
      "The team to delete is no longer the active team — reload and try again",
    );
  if (!ctx.allowed)
    throw new Error(
      "Only the team's primary owner or an instance admin can delete the team",
    );
  // Fast-path only — the enforcement re-check runs under the lock below.
  if (ctx.onlyTeam)
    throw new Error(
      "You can't delete your only team — create another team first",
    );

  const db = getDb();
  // Serialize the guard + delete per USER: two concurrent deletes of the
  // caller's two teams would each see the other team still alive and strand
  // the caller with zero teams — exactly what the only-team guard exists to
  // prevent. The lock scope stays tight (no agent I/O inside).
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

      // Snapshot the teardown targets IMMEDIATELY before the delete, so
      // apps/databases created while this request was in flight are still
      // caught (rows born after this point are lost to the cascade, but the
      // window is now milliseconds, not the length of the agent fan-out).
      const services = await loadAppsByTeam(ctx.teamId);
      const byAppId = new Map(services.map((s) => [s.id, s]));
      const sshRows =
        services.length === 0
          ? []
          : await db
              .select({
                appId: devSshUserTable.appId,
                username: devSshUserTable.username,
              })
              .from(devSshUserTable)
              .where(inArray(devSshUserTable.appId, [...byAppId.keys()]));
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

      return {
        services,
        sshUsers: sshRows.flatMap((r) => {
          const s = byAppId.get(r.appId);
          return s ? [{ serverId: s.serverId, username: r.username }] : [];
        }),
        databases,
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
  // only-team guard ensures there is one). Best-effort: outside a request's
  // cookie scope (bearer-token API calls, tests) this throws, and the stale
  // cookie self-heals anyway — getActiveTeamId validates it against the
  // caller's memberships and falls back to their first team.
  const remaining = await teamsForUser(ctx.userId);
  if (remaining[0]) await setActiveTeam(remaining[0].id).catch(() => {});
}
