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

// startDeployment creates a queued deployment row and hands it to the per-server queue.
// Returns the deployment id immediately; the job updates status and logs as it progresses.
export async function startDeployment(
  appId: string,
  opts: {
    environment?: DeploymentEnvironment;
    creator: string;
    // The git host `creator` is a login on, when a webhook push triggered this build.
    // Set => nobody here is credited: it names an account on that host.
    creatorProvider?: string | null;
    commitMessage?: string;
    branch?: string;
    // Replace the running containers even when the rendered stack is unchanged. Stored on
    // the row because the deploy runs later, out of the queue.
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
    // This build re-runs a deployment's image instead of producing a new one: no clone, no
    // build, no pull - seconds instead of minutes.
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
  // Data a migration could not copy is a refusal, not a warning: its volumes are empty or
  // half-written. Not while a move is pending - that deploy IS the retry of the copy.
  if (!preview && !project.migrateFromServerId)
    assertDataCopyIntact(project.name, project.dataCopyError);
  // Here as well as in the capability gate: the git webhook reaches this function with no
  // gate at all, and a push landing mid-import would deploy half-filled volumes.
  assertNotMigrating("app", project.name, project.migrationRunId);
  // A deploy has no user of its own, so revoking the host grant used to stop nothing: the
  // stack kept reaching the server on every later push. Read against whoever authored it.
  await assertHostReachStillGranted(appId, project.name);
  const rollback = opts.rollback ?? null;
  const environment = opts.environment ?? (preview ? "preview" : "production");
  if (preview && environment !== "preview") {
    throw new Error("A preview deployment must use the preview environment");
  }
  // A preview is an ephemeral stack of ITS OWN commit; there is no "the previous one" to
  // return it to, and its key/host belong to a pull request.
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
  // The stack this build owns. Production keeps the bare app slug, which is why introducing
  // the key changed nothing that was already running.
  const deployKey = preview ? preview.deployKey : project.slug;

  const dep: Deployment = {
    id: depId,
    appId,
    status: "queued",
    environment,
    deployKey,
    previewId: preview?.id ?? null,
    prNumber: preview?.prNumber ?? null,
    // A rollback inherits the commit of the build it re-runs: the list has to keep saying
    // which code is live, and after a rollback that is the OLD commit.
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
    // WHO `creator` names, when it names somebody with an account here - never a git login,
    // which belongs to no account on this instance.
    creatorUserId: opts.creatorProvider
      ? null
      : await resolveActorUserId(opts.creator),
    creatorProvider: opts.creatorProvider ?? null,
    creatorUser: null,
    serverId: preview?.serverId || project.serverId,
    buildServerId: null,
  };

  const deployServerId = preview?.serverId || project.serverId;
  // Which host COMPILES this one, decided here and written down for the same reason
  // `serverId` is: from this point everything reads the row.
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
    // A preview NEVER touches the App's row.
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
        ? // Name the commit, not the deployment id: a `dpl_` id answers neither half of
          // "who put us back on what". An upload has no sha, so it falls back to the date.
          `Rolling ${project.name} back to ${
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

  // Supersede: a newer trigger for the SAME STACK wins, so cancel its still-QUEUED deploys
  // (nothing was built - safe to drop) EXCEPT the one just inserted.
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

  // The queue starts it once its OWNING server has a free slot and no other deploy of this
  // app is in flight.
  enqueueDeployment({ depId, serverId: deployServerId, appId, buildServerId });
  return depId;
}

// Refuse a deploy of a compose that reaches past its container when the person who saved it
// no longer holds the grant. NULL unless a save actually found host reach.
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
