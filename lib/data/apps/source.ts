import { authorizeComposeTraefik } from "./traefik-labels";
import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  apps as appsTable,
  appTraefikLabels,
  appPorts as appPortsTable,
} from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { getCurrentUser } from "../../auth/current-user";
import { nowIso } from "../../ids";
import { dropFailoverBundle } from "../clusters/bundles";
import { assertServerNotInCluster } from "../clusters/members";
import { redeployArchs } from "../clusters/architectures";
import {
  askLeaderToPlace,
  clearPlacement,
  recordPlacement,
} from "../clusters/placement";
import { resolveTeamCluster } from "../clusters/roster";
import { joinAppTunnel, leaveAppTunnel } from "../clusters/app-tunnel";
import {
  canHostWorkloads,
  getServerById,
  listAllServers,
  listServersForTeam,
} from "../servers/roster";
import { hostPortClaimed } from "../host-ports";
import { assertNoNameClash, withNetworkLock } from "../name-clash";
import { composeNamesOnNetwork } from "../../deploy/compose-stack/compose-read";
import { stackName } from "../../deploy/deploy-key";
import { wildcardEmbeddedIp, rehostWildcard } from "../../deploy/domains";
import { serverWildcardIp } from "../servers/addresses";
import { stopPreviewsForServerChange } from "../../deploy/preview-lifecycle/close";
import { startDeployment } from "../../deploy/build/deploy-start";
import { appOwnVolumeNames } from "../project-backup-descriptor";
import { teardownOrQueue } from "../teardown-queue";
import { dropAppWebhook, syncAppWebhook } from "../git-connections";
import { loadAppGraph, loadDomainsForApp } from "../app-graph-load";
import { assertNotMigrating } from "../migration-guard";
import { requireAppCapability } from "../node-access";
import { recordActivity } from "../activity";
import {
  ON_IMPORT_SOURCE,
  assertComposeSavable,
  assertImageRef,
  scopeRepoCredentials,
} from "./source-guards";
import type { App, DeploySource } from "../../types/app";
import type { Cluster } from "../../types/cluster";
import type { Server } from "../../types/server";
import type { GitRepo } from "../../types/build";

export interface UpdateSourceInput {
  source: DeploySource;
  repo: GitRepo | null;
  dockerImage: string | null;
  serverId?: string;

  compose?: string | null;
}

export function updateAppSource(
  id: string,
  input: UpdateSourceInput,
): Promise<void> {
  return writeAppSource(id, input);
}

/** Moves an app to another server and redeploys it there, keeping its source. */
export async function moveAppToServer(
  id: string,
  serverId: string,
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const app = await loadAppGraph(id);
  if (!app || app.teamId !== membership.teamId)
    throw new Error("App not found");
  if (app.serverId === serverId) return;
  await writeAppSource(
    id,
    {
      source: app.source,
      repo: app.repo,
      dockerImage: app.dockerImage,
      serverId,
    },
    { deploy: app.source !== "upload" || app.upload != null },
  );
}

/** Places an App on a cluster: the leader picks the member, the App moves there like a server move. */
export async function moveAppToCluster(
  id: string,
  clusterId: string,
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const app = await loadAppGraph(id);
  if (!app || app.teamId !== membership.teamId)
    throw new Error("App not found");
  const cluster = await resolveTeamCluster(membership.teamId, clusterId);
  if (app.clusterId === cluster.id) return;
  // A refusal throws here, before anything stops.
  const member = await askLeaderToPlace(cluster, {
    kind: "app",
    id,
    name: app.name,
    environmentId: app.environmentId ?? null,
    limitMb: app.resources?.memoryMb ?? 0,
    archs: await redeployArchs("app", id),
  });
  await writeAppSource(
    id,
    {
      source: app.source,
      repo: app.repo,
      dockerImage: app.dockerImage,
      serverId: member,
    },
    { deploy: app.source !== "upload" || app.upload != null, cluster },
  );
  await recordPlacement({
    clusterId: cluster.id,
    kind: "app",
    workloadId: id,
    members: [member],
    epoch: cluster.leaderEpoch,
  });
}

// A tunnel that could not be set up never blocks the move: the domains keep their address, and Activity says so.
async function tunnelWarn(
  app: { id: string; teamId: string },
  did: string,
  e: unknown,
): Promise<void> {
  const why = e instanceof Error ? e.message : String(e);
  console.warn(`[app-tunnel] ${app.id}: ${why}`);
  await recordActivity(
    "domain",
    `Could not ${did} this App's Cloudflare Tunnel, so its domains keep their address: ${why}`,
    "Deplo",
    app.id,
    app.teamId,
  );
}

interface SourceMove {
  deploy: boolean;
  cluster?: Cluster;
  /** Why Deplo moved it, for Activity. */
  why?: string;
}

/** Who writes, with every gate already answered: built by the gated door, or by Deplo for its own moves. */
interface SourceWriter {
  teamId: string;
  user: { id: string; name: string };
  servers: Server[];
  repo: GitRepo | null;
  editReach: string[];
  traefikLabelsBy: string | null;
}

/** The gated door: every write a person asks for passes here, and nothing here can switch a gate off. */
async function writeAppSource(
  id: string,
  input: UpdateSourceInput,
  move?: { deploy: boolean; cluster?: Cluster },
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const teamId = membership.teamId;
  const [at] = await getDb()
    .select({ serverId: appsTable.serverId, clusterId: appsTable.clusterId })
    .from(appsTable)
    .where(and(eq(appsTable.id, id), eq(appsTable.teamId, teamId)))
    .limit(1);
  const moving = Boolean(
    at && input.serverId && input.serverId !== at.serverId,
  );
  // Leaving a cluster is moving the App, not only configuring it.
  if (moving && at.clusterId && at.clusterId !== move?.cluster?.id)
    await requireAppCapability(id, "move_apps");
  assertImageRef(input.source, input.dockerImage);
  const editReach = await assertComposeSavable(input.compose);
  const traefikLabelsBy = await authorizeComposeTraefik(input.compose);
  const servers = await listServersForTeam(teamId);
  // A member follows its cluster's sharing: the one the App is on, and the one the leader named.
  for (const sid of [
    at?.clusterId ? at.serverId : null,
    move?.cluster ? input.serverId : null,
  ]) {
    if (!sid || servers.some((s) => s.id === sid)) continue;
    const member = await getServerById(sid);
    if (member) servers.push(member);
  }
  await applyAppSource(
    id,
    input,
    {
      teamId,
      user: (await getCurrentUser())!,
      servers,
      // A move re-writes the stored repo, already scoped when it was saved.
      repo: move ? input.repo : await scopeRepoCredentials(input.repo, teamId),
      editReach,
      traefikLabelsBy,
    },
    move,
  );
}

// Ungated: the caller holds the gate, or is Deplo itself. No resolver reaches this but through writeAppSource.
async function applyAppSource(
  id: string,
  input: UpdateSourceInput,
  who: SourceWriter,
  move?: SourceMove,
): Promise<void> {
  const membership = { teamId: who.teamId };
  const { user, repo, editReach, traefikLabelsBy, servers } = who;
  const serversById = new Map(servers.map((s) => [s.id, s] as const));

  const [current] = await getDb()
    .select({
      name: appsTable.name,
      serverId: appsTable.serverId,
      previewServerId: appsTable.previewServerId,
      environmentId: appsTable.environmentId,
      compose: appsTable.compose,
      slug: appsTable.slug,
      migrateFromServerId: appsTable.migrateFromServerId,
      clusterId: appsTable.clusterId,
      dataCopyError: appsTable.dataCopyError,
    })
    .from(appsTable)
    .where(and(eq(appsTable.id, id), eq(appsTable.teamId, membership.teamId)))
    .limit(1);
  const moving = Boolean(
    current && input.serverId && input.serverId !== current.serverId,
  );
  if (current && moving) {
    if (!move?.cluster) await assertServerNotInCluster(input.serverId!);
    if (current.dataCopyError && !current.migrateFromServerId)
      throw new Error(
        `${current.name}'s data did not come across from its migration - copy it again, or choose "Deploy anyway" on its page, before moving it.`,
      );
    if (input.source !== "compose") {
      const claimed = await getDb()
        .select({ published: appPortsTable.published })
        .from(appPortsTable)
        .where(eq(appPortsTable.appId, id));
      for (const { published } of claimed)
        if (await hostPortClaimed(input.serverId!, published, { appId: id }))
          throw new Error(
            `Port ${published} is already published on ${serversById.get(input.serverId!)?.name ?? "that server"}. Change it under Ports first, or pick another server.`,
          );
    }
  }

  // A preview's teardown resolves the host from the app row: once it names the new machine, the old stacks are unreachable.
  // Inside one cluster a preview runs on a member of its own and records it, so it stays where it is.
  const sameCluster = Boolean(
    move?.cluster && move.cluster.id === current?.clusterId,
  );
  if (current && moving && !current.previewServerId && !sameCluster) {
    await stopPreviewsForServerChange(id, input.serverId!);
  }
  const after: {
    moved: boolean;
    stray: App | null;
    strayServerId: string | null;
  } = { moved: false, stray: null, strayServerId: null };
  const before: { repo: GitRepo | null } = { repo: null };

  // Read before the transaction: the lookup may ask DNS or the agent, and must not hold a connection open.
  const ipOf = new Map<string, string | null>();
  for (const sid of new Set([current?.serverId, input.serverId]))
    if (sid) ipOf.set(sid, await serverWildcardIp(serversById.get(sid)));

  // Service names live inside a compose file with no unique constraint under them, so check and write share one lock.
  await withNetworkLock(
    {
      teamId: membership.teamId,
      environmentId: current?.environmentId ?? null,
    },
    async () => {
      if (current && (input.compose != null || input.serverId != null)) {
        const compose = input.compose ?? current.compose ?? "";
        await assertNoNameClash({
          to: {
            teamId: membership.teamId,
            environmentId: current.environmentId,
            serverId: input.serverId ?? current.serverId,
          },
          claims: compose.trim()
            ? composeNamesOnNetwork(compose)
            : [stackName(current.slug)],
          exceptId: id,
          subject: "this app",
        });
      }
      await getDb().transaction(async (tx) => {
        const p = await loadAppGraph(id, tx);
        if (!p || p.teamId !== membership.teamId)
          throw new Error("App not found");
        before.repo = p.repo;
        const oldIp = ipOf.get(p.serverId) ?? null;
        const oldServerId = p.serverId;
        let serverId = p.serverId;
        if (input.serverId) {
          const picked = serversById.get(input.serverId);
          if (!picked) throw new Error("Server not found");

          if (!canHostWorkloads(picked))
            throw new Error(
              picked.importOnly
                ? ON_IMPORT_SOURCE
                : picked.storageOnly
                  ? "That server holds backups only - nothing is deployed there."
                  : "That server only builds images - nothing is deployed there.",
            );
          serverId = input.serverId;
        }
        const isMove = serverId !== oldServerId;

        const pending = p.migrateFromServerId ?? null;
        let migrateFromServerId = pending;
        if (isMove) {
          migrateFromServerId =
            serverId === pending ? null : (pending ?? oldServerId);
          if (pending) {
            after.stray = p;
            after.strayServerId = oldServerId;
          }
        }
        after.moved = isMove;

        const newIp = ipOf.get(serverId) ?? null;

        // Auto generated hosts encode the old IP, so a move re-hosts them or Traefik keeps pointing at the old machine.
        if (newIp && newIp !== oldIp) {
          const appDomains = await loadDomainsForApp(p.id, tx);
          for (const dom of appDomains) {
            if (
              dom.source === "auto" &&
              wildcardEmbeddedIp(dom.name) === oldIp
            ) {
              await tx
                .update(domainsTable)
                .set({ name: rehostWildcard(dom.name, newIp) })
                .where(eq(domainsTable.id, dom.id));
            }
          }
        }

        const buildServerId =
          isMove && p.buildServerId === oldServerId
            ? serverId
            : (p.buildServerId ?? null);

        await tx
          .update(appsTable)
          .set({
            serverId,
            // Moving to a server of its own leaves the cluster.
            ...(isMove ? { clusterId: move?.cluster?.id ?? null } : {}),
            buildServerId,
            migrateFromServerId,
            ...(isMove && pending ? { dataCopyError: "" } : {}),
            source: input.source,
            repoProvider: repo?.provider ?? null,
            repoUrl: repo?.url ?? null,
            repoRepo: repo?.repo ?? null,
            repoBranch: repo?.branch ?? null,
            repoInstallationId: repo?.installationId ?? null,
            repoConnectionId: repo?.connectionId ?? null,
            repoTriggerType: repo?.triggerType ?? null,
            repoWatchPaths: repo?.watchPaths?.length
              ? repo.watchPaths.join("\n")
              : null,
            repoSubmodules: repo?.submodules ?? false,
            dockerImage: input.dockerImage,
            // Leaving a pasted stack for a repository or an upload: that YAML must not pass for the source's own.
            ...(input.compose == null &&
            input.source !== "compose" &&
            p.source === "compose"
              ? { compose: null }
              : {}),
            ...(input.compose != null
              ? {
                  compose: input.compose,
                  hostReachBy: editReach.length > 0 ? user.id : null,
                  traefikLabelsBy:
                    traefikLabelsBy ??
                    sql`case when exists (
                    select 1 from ${appTraefikLabels}
                    where ${appTraefikLabels.appId} = ${appsTable.id}
                  ) then ${appsTable.traefikLabelsBy} else null end`,
                }
              : {}),
            pendingChangesAt: nowIso(),
            updatedAt: nowIso(),
          })
          .where(eq(appsTable.id, id));
      });
    },
  );
  await recordActivity(
    "app",
    move
      ? `Moved ${current?.name ?? "app"} to ${serversById.get(input.serverId!)?.name ?? "another server"}` +
          (move.why ? `: ${move.why}` : "")
      : `Updated deploy source`,
    user.name,
    id,
  );

  const movedOff =
    before.repo?.connectionId &&
    (before.repo.connectionId !== repo?.connectionId ||
      before.repo.repo !== repo?.repo);
  if (movedOff) await dropAppWebhook(before.repo).catch(() => {});
  await syncAppWebhook(repo).catch(() => {});

  if (after.stray && after.strayServerId)
    await teardownOrQueue({
      serverId: after.strayServerId,
      deployKey: after.stray.slug,
      projectLabel: after.stray.id,
      label: after.stray.name,
      teamId: membership.teamId,
      reclaimVolumes: appOwnVolumeNames(after.stray),
    }).catch(() => {});

  if (after.moved && !move?.cluster) await clearPlacement("app", id);
  if (
    after.moved &&
    current?.clusterId &&
    current.clusterId !== move?.cluster?.id
  )
    await dropFailoverBundle(id, current.clusterId).catch(() => {});
  // Joining gives the App its own tunnel before the deploy that starts its connector; leaving points DNS back.
  const moved = { id, teamId: membership.teamId };
  if (after.moved && move?.cluster && !current?.clusterId)
    await joinAppTunnel(id, user).catch((e) => tunnelWarn(moved, "set up", e));
  if (after.moved && current?.clusterId && !move?.cluster)
    await leaveAppTunnel(id, user).catch((e) =>
      tunnelWarn(moved, "switch back from", e),
    );

  if (after.moved && (move ? move.deploy : input.source !== "upload")) {
    try {
      await startDeployment(id, {
        creator: user.name,
        commitMessage: "Move to a different server",
      });
    } catch (e) {
      throw new Error(
        `The move was saved, but starting the initial deploy on the new server ` +
          `failed (${e instanceof Error ? e.message : String(e)}). Trigger a ` +
          `production deploy to complete the move and migrate the data.`,
      );
    }
  }
}

/**
 * Deplo itself moving a cluster App to another member of its cluster, as emptying a server does. No Capability
 * is read: the caller holds the gate. Answers whether a deploy was started on the new member.
 */
export async function relocateClusterApp(
  id: string,
  cluster: Cluster,
  serverId: string,
  why: string,
): Promise<boolean> {
  const app = await loadAppGraph(id);
  if (!app || app.clusterId !== cluster.id) throw new Error("App not found");
  assertNotMigrating("app", app.name, app.migrationRunId);
  const deploy = app.source !== "upload" || app.upload != null;
  await applyAppSource(
    id,
    {
      source: app.source,
      repo: app.repo,
      dockerImage: app.dockerImage,
      serverId,
    },
    {
      teamId: app.teamId,
      user: { id: "", name: "Deplo" },
      servers: await listAllServers(),
      repo: app.repo,
      editReach: [],
      traefikLabelsBy: null,
    },
    { deploy, cluster, why },
  );
  return deploy;
}
