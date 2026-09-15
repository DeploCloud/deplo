import "server-only";

import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { backupDestination as backupDestinationTable } from "../db/schema/control-plane/backups";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { appPreviews as appPreviewsTable } from "../db/schema/control-plane/deployments";
import {
  sharedEnvVars,
  sharedEnvVarTeams,
} from "../db/schema/control-plane/env-vars";
import { teams as teamsTable } from "../db/schema/control-plane/identity";
import { installedPlugins as installedPluginsTable } from "../db/schema/control-plane/integrations";
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
} from "./destinations/credentials";
import { deleteFromDestination } from "./backup-transport";
import {
  enqueueTeardowns,
  teardownOrQueue,
  type TeardownEntry,
} from "./teardown-queue";
import { removeUploads } from "../deploy/upload";

interface DeleteTeamContext {
  userId: string;
  teamId: string;
  allowed: boolean;
  onlyTeam: boolean;
}

async function deleteTeamContext(): Promise<DeleteTeamContext> {
  const { userId, teamId, membership } = await requireMembership();
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
  const allowed =
    (await isInstanceAdmin()) ||
    ((founderId ? userId === founderId : membership.role === "owner") &&
      membership.capabilities.includes("delete_team"));
  const onlyTeam = (await teamsForUser(userId)).length <= 1;
  return { userId, teamId, allowed, onlyTeam };
}

export async function canDeleteTeam(): Promise<{
  allowed: boolean;
  onlyTeam: boolean;
  sharedVars: number;
  sharedVarsOtherTeamsUse: number;
}> {
  try {
    const { allowed, onlyTeam, teamId } = await deleteTeamContext();
    const owned = await getDb()
      .select({ id: sharedEnvVars.id })
      .from(sharedEnvVars)
      .where(eq(sharedEnvVars.teamId, teamId));
    const foreign = owned.length
      ? await getDb()
          .selectDistinct({ varId: sharedEnvVarTeams.varId })
          .from(sharedEnvVarTeams)
          .where(
            and(
              inArray(
                sharedEnvVarTeams.varId,
                owned.map((v) => v.id),
              ),
              ne(sharedEnvVarTeams.teamId, teamId),
            ),
          )
      : [];
    return {
      allowed,
      onlyTeam,
      sharedVars: owned.length,
      sharedVarsOtherTeamsUse: foreign.length,
    };
  } catch {
    return {
      allowed: false,
      onlyTeam: false,
      sharedVars: 0,
      sharedVarsOtherTeamsUse: 0,
    };
  }
}

export interface TeardownPlan {
  services: { id: string; slug: string; serverId: string }[];
  previewStacks?: { id: string; deployKey: string; serverId: string }[];
  databases: { id: string; host: string; serverId: string }[];
  appSlugs: string[];
  backupSweeps?: {
    creds: DestinationWithSecrets;
    prefix: string;
    viaServerId: string;
  }[];
}

export function teardownTeamResources(
  plan: TeardownPlan,
  tag = "team-delete",
): void {
  void (async () => {
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
    await enqueueTeardowns([...previews, ...stacks, ...dbs]);

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

export async function deleteTeam(teamId: string): Promise<void> {
  const ctx = await deleteTeamContext();
  if (teamId !== ctx.teamId)
    throw new Error(
      "The team to delete is no longer the active team - reload and try again",
    );
  if (!ctx.allowed)
    throw new Error(
      "You don't have permission to delete this team - only its primary owner, with permission to delete the team, or an instance admin can",
    );
  if (ctx.onlyTeam)
    throw new Error(
      "You can't delete your only team - create another team first",
    );

  const db = getDb();
  const plan = await withKeyedLock(
    `team-delete:${ctx.userId}`,
    async (): Promise<TeardownPlan | null> => {
      const mine = await teamsForUser(ctx.userId);
      if (!mine.some((t) => t.id === ctx.teamId)) return null;
      if (mine.length <= 1)
        throw new Error(
          "You can't delete your only team - create another team first",
        );

      const services = await loadAppsByTeam(ctx.teamId);
      const previewStacks = (
        await db
          .select({
            id: appPreviewsTable.id,
            deployKey: appPreviewsTable.deployKey,
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
              return null;
            }
          }),
        )
      ).filter((x): x is NonNullable<typeof x> => x !== null);
      await db.delete(teamsTable).where(eq(teamsTable.id, ctx.teamId));

      return {
        services,
        previewStacks,
        databases,
        backupSweeps,
        appSlugs: apps.map(
          (a) => a.slug || pluginSlug(a.catalogId, team?.slug ?? ""),
        ),
      };
    },
  );
  if (plan) teardownTeamResources(plan);

  const remaining = await teamsForUser(ctx.userId);
  if (remaining[0]) await setActiveTeam(remaining[0].id).catch(() => {});
}
