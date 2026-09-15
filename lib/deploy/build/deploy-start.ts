import "server-only";

import { and, eq, ne } from "drizzle-orm";
import { recordActivity, resolveActorUserId } from "../../data/activity";
import { loadAppGraph } from "../../data/app-graph-load";
import { deploymentToRow } from "../../data/app-graph-rows/deployment";
import { assertDataCopyIntact } from "../../data/data-copy";
import { clearDeploymentLogs } from "../../data/deployment-logs";
import { primaryDomainRow } from "../../data/domains/primary-domain";
import { assertNotMigrating } from "../../data/migration-guard";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  deployments as deploymentsTable,
  appPreviews as appPreviewsTable,
} from "../../db/schema/control-plane/deployments";
import { publishAppChanged } from "../../graphql/pubsub";
import { newId, nowIso } from "../../ids";
import { userMayReachHost } from "../../membership";
import type { Deployment, DeploymentEnvironment } from "../../types/deployment";
import type { CertProvider } from "../../types/domain";
import { enqueueDeployment } from "../deploy-queue";
import { domainScheme } from "../domains";
import { resolveBuildServerFor } from "./build-attempt";

export async function startDeployment(
  appId: string,
  opts: {
    environment?: DeploymentEnvironment;
    creator: string;
    creatorProvider?: string | null;
    commitMessage?: string;
    branch?: string;
    forceRecreate?: boolean;
    preview?: {
      id: string;
      deployKey: string;
      host: string;
      certProvider: CertProvider;
      prNumber: number;
      headSha?: string;
      serverId?: string | null;
    } | null;
    rollback?: {
      deploymentId: string;
      imageRef: string;
      commitSha: string;
      commitMessage: string;
      commitAuthor: string;
      builtAt: string;
    } | null;
  },
): Promise<string> {
  const project = await loadAppGraph(appId);
  if (!project) throw new Error("App not found");
  const preview = opts.preview ?? null;
  if (!preview && !project.migrateFromServerId)
    assertDataCopyIntact(project.name, project.dataCopyError);
  assertNotMigrating("app", project.name, project.migrationRunId);
  await assertHostReachStillGranted(appId, project.name);
  const rollback = opts.rollback ?? null;
  const environment = opts.environment ?? (preview ? "preview" : "production");
  if (preview && environment !== "preview") {
    throw new Error("A preview deployment must use the preview environment");
  }
  if (rollback && preview) {
    throw new Error("A pull request preview cannot be rolled back");
  }
  const branch = opts.branch ?? project.repo?.branch ?? "main";
  const primaryRow = preview ? null : await primaryDomainRow(appId);
  const domain = preview ? preview.host : (primaryRow?.name ?? "");
  const scheme = preview
    ? domainScheme({ certProvider: preview.certProvider })
    : primaryRow
      ? domainScheme(primaryRow)
      : "https";
  const url = domain ? `${scheme}://${domain}` : "";
  const depId = newId("dpl");
  const deployKey = preview ? preview.deployKey : project.slug;

  const dep: Deployment = {
    id: depId,
    appId,
    status: "queued",
    environment,
    deployKey,
    previewId: preview?.id ?? null,
    prNumber: preview?.prNumber ?? null,
    commitSha: rollback?.commitSha ?? "",
    commitMessage: rollback?.commitMessage || opts.commitMessage || "Deploy",
    commitAuthor: rollback?.commitAuthor || opts.creator,
    branch,
    url,
    createdAt: nowIso(),
    startedAt: null,
    readyAt: null,
    buildDurationMs: null,
    forceRecreate: opts.forceRecreate ?? false,
    imageRef: rollback?.imageRef ?? null,
    rollbackOf: rollback?.deploymentId ?? null,
    creator: opts.creator,
    creatorUserId: opts.creatorProvider
      ? null
      : await resolveActorUserId(opts.creator),
    creatorProvider: opts.creatorProvider ?? null,
    creatorUser: null,
    serverId: preview?.serverId || project.serverId,
    buildServerId: null,
  };

  const deployServerId = preview?.serverId || project.serverId;
  const buildServerId = rollback
    ? null
    : await resolveBuildServerFor(project, deployServerId, depId);
  await getDb()
    .insert(deploymentsTable)
    .values({
      ...deploymentToRow(dep),
      serverId: deployServerId,
      buildServerId,
    });
  await clearDeploymentLogs(depId);
  if (preview) {
    await getDb()
      .update(appPreviewsTable)
      .set({
        latestDeploymentId: depId,
        status: "queued",
        url,
        ...(opts.preview?.headSha ? { headSha: opts.preview.headSha } : {}),
        lastActivityAt: nowIso(),
        updatedAt: nowIso(),
      })
      .where(eq(appPreviewsTable.id, preview.id));
  } else {
    await getDb()
      .update(appsTable)
      .set({
        latestDeploymentId: depId,
        status: "queued",
        updatedAt: nowIso(),
        productionUrl: domain ? url : null,
      })
      .where(eq(appsTable.id, appId));
  }
  await recordActivity(
    "deployment",
    preview
      ? `Deploying ${project.name} preview for pull request #${preview.prNumber}`
      : rollback
        ? `Rolling ${project.name} back to ${
            rollback.commitSha
              ? rollback.commitSha.slice(0, 7)
              : `the build from ${rollback.builtAt.slice(0, 10)}`
          }`
        : `Deploying ${project.name}`,
    opts.creatorProvider
      ? { name: opts.creator, provider: opts.creatorProvider }
      : opts.creator,
    appId,
  );

  await getDb()
    .update(deploymentsTable)
    .set({ status: "canceled" })
    .where(
      and(
        eq(deploymentsTable.appId, appId),
        eq(deploymentsTable.deployKey, deployKey),
        eq(deploymentsTable.status, "queued"),
        ne(deploymentsTable.id, depId),
      ),
    );

  publishAppChanged(appId);

  enqueueDeployment({ depId, serverId: deployServerId, appId, buildServerId });
  return depId;
}

async function assertHostReachStillGranted(
  appId: string,
  appName: string,
): Promise<void> {
  const [row] = await getDb()
    .select({ by: appsTable.hostReachBy })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  if (!row?.by) return;
  if (await userMayReachHost(row.by)) return;
  throw new Error(
    `${appName}'s compose reaches past its container, and whoever saved it no ` +
      `longer has permission to let an app reach the server. An admin restores it ` +
      `with "Bind server folders" in Settings -> Users, or someone who has it saves ` +
      `the compose again.`,
  );
}
