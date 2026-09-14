import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  apps as appsTable,
  appPorts as appPortsTable,
} from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { getCurrentUser } from "../../auth/current-user";
import { nowIso } from "../../ids";
import { canHostWorkloads, listServersForTeam } from "../servers/roster";
import { hostPortClaimed } from "../host-ports";
import { assertNoNameClash, withNetworkLock } from "../name-clash";
import { composeNamesOnNetwork } from "../../deploy/compose-stack/compose-read";
import { stackName } from "../../deploy/deploy-key";
import {
  nipEmbeddedIp,
  rehostNip,
  resolveServerIp,
} from "../../deploy/domains";
import { stopPreviewsForServerChange } from "../../deploy/preview-lifecycle/close";
import { startDeployment } from "../../deploy/build/deploy-start";
import { appOwnVolumeNames } from "../project-backup-descriptor";
import { teardownOrQueue } from "../teardown-queue";
import { dropAppWebhook, syncAppWebhook } from "../git-connections";
import { loadAppGraph, loadDomainsForApp } from "../app-graph-load";
import { requireAppCapability } from "../node-access";
import { recordActivity } from "../activity";
import {
  ON_IMPORT_SOURCE,
  assertComposeSavable,
  assertImageRef,
  scopeRepoCredentials,
} from "./source-guards";
import type { App, DeploySource } from "../../types/app";
import type { GitRepo } from "../../types/build";

export interface UpdateSourceInput {
  source: DeploySource;
  repo: GitRepo | null;
  dockerImage: string | null;
  serverId?: string;

  // Compose YAML to persist (source === "compose"). Kept when switching away.
  compose?: string | null;
}

export async function updateAppSource(
  id: string,
  input: UpdateSourceInput,
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  assertImageRef(input.source, input.dockerImage);
  const editReach = await assertComposeSavable(input.compose);
  const user = (await getCurrentUser())!;
  const repo = await scopeRepoCredentials(input.repo, membership.teamId);
  const serversById = new Map(
    (await listServersForTeam(membership.teamId)).map(
      (s) => [s.id, s] as const,
    ),
  );

  // The app's placement decides which network its names live on, so it is read BEFORE the transaction:
  // this query runs on its own connection.
  const [current] = await getDb()
    .select({
      name: appsTable.name,
      serverId: appsTable.serverId,
      previewServerId: appsTable.previewServerId,
      environmentId: appsTable.environmentId,
      compose: appsTable.compose,
      slug: appsTable.slug,
      migrateFromServerId: appsTable.migrateFromServerId,
      dataCopyError: appsTable.dataCopyError,
    })
    .from(appsTable)
    .where(and(eq(appsTable.id, id), eq(appsTable.teamId, membership.teamId)))
    .limit(1);
  const moving = Boolean(
    current && input.serverId && input.serverId !== current.serverId,
  );
  if (current && moving) {
    // Data an import could not copy is not there to move.
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

  // A preview's teardown resolves the host from the app row: once it names the new machine, the
  // stacks on the old one could never be reached again.
  if (current && moving && !current.previewServerId) {
    await stopPreviewsForServerChange(id, input.serverId!);
  }
  const after: {
    moved: boolean;
    stray: App | null;
    strayServerId: string | null;
  } = { moved: false, stray: null, strayServerId: null };
  const before: { repo: GitRepo | null } = { repo: null };

  // Check the names and write under ONE lock: the names live inside a compose file, with no unique constraint underneath.
  await withNetworkLock(
    {
      teamId: membership.teamId,
      environmentId: current?.environmentId ?? null,
    },
    async () => {
      // Asked when the compose changes OR when the SERVER does - a Docker network lives on one machine.
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
        const oldIp = resolveServerIp(serversById.get(p.serverId));
        const oldServerId = p.serverId;
        let serverId = p.serverId;
        if (input.serverId) {
          const picked = serversById.get(input.serverId);
          if (!picked) throw new Error("Server not found");

          // A move answers the same question a creation does: a specialised host runs nothing.
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

        // The marker names the host that still HOLDS the data; the deploy on the new host copies from it.
        // Moving back onto the source calls the move off; the host in between is a stray, torn down below.
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

        const newIp = resolveServerIp(serversById.get(serverId));

        // Auto nip.io domains encode the old IP, so a move re-hosts them or Traefik keeps pointing at the old host.
        if (newIp !== oldIp) {
          const appDomains = await loadDomainsForApp(p.id, tx);
          for (const dom of appDomains) {
            if (dom.source === "auto" && nipEmbeddedIp(dom.name) === oldIp) {
              await tx
                .update(domainsTable)
                .set({ name: rehostNip(dom.name, newIp) })
                .where(eq(domainsTable.id, dom.id));
            }
          }
        }

        // A MOVE carries "build on this app's own server", or the setting silently becomes the machine just left.
        const buildServerId =
          isMove && p.buildServerId === oldServerId
            ? serverId
            : (p.buildServerId ?? null);

        await tx
          .update(appsTable)
          .set({
            serverId,
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
            ...(input.compose != null
              ? {
                  compose: input.compose,
                  hostReachBy: editReach.length > 0 ? user.id : null,
                }
              : {}),
            updatedAt: nowIso(),
          })
          .where(eq(appsTable.id, id));
      });
    },
  );
  await recordActivity("app", `Updated deploy source`, user.name, id);

  // Webhooks AFTER the commit: both calls talk to a third party, and neither may fail the save.
  const movedOff =
    before.repo?.connectionId &&
    (before.repo.connectionId !== repo?.connectionId ||
      before.repo.repo !== repo?.repo);
  if (movedOff) await dropAppWebhook(before.repo).catch(() => {});
  await syncAppWebhook(repo).catch(() => {});

  // The half-built stack on the host a re-targeted move passed through; an unreachable host lands in the retry queue.
  if (after.stray && after.strayServerId)
    await teardownOrQueue({
      serverId: after.strayServerId,
      deployKey: after.stray.slug,
      projectLabel: after.stray.id,
      label: after.stray.name,
      teamId: membership.teamId,
      reclaimVolumes: appOwnVolumeNames(after.stray),
    }).catch(() => {});

  // A MOVE takes effect on a deploy. Upload is the exception: its own "Save & Deploy" consumes the same marker.
  if (after.moved && input.source !== "upload") {
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
