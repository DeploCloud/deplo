import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { getCurrentUser } from "../../auth/current-user";
import { nowIso } from "../../ids";
import { requireCapability } from "../../membership";
import { healthCheckProblem } from "../../apps/health-check-model";
import {
  parseComposeUpArgs,
  validateComposeUpArgs,
} from "../../deploy/compose-args";
import {
  frameworkById,
  isFrameworkId,
  supportsFrameworkDetection,
} from "../../apps/framework-catalog";
import {
  detectRepoFramework,
  type RepoBuildHints,
} from "../../apps/framework-source";
import { DEFAULT_ROLLBACK_KEEP, MAX_ROLLBACK_KEEP } from "../../types/app";
import { healthCheckToRow } from "../app-graph-rows/health-check";
import { requireAppCapability } from "../node-access";
import { listGithubInstallations } from "../github";
import { recordActivity } from "../activity";
import { publishAppChanged } from "../../graphql/pubsub";
import { cleanAppName } from "./create";
import type { UploadArchive } from "../../types/app";
import type { BuildMethod } from "../../types/build";
import type { HealthCheck } from "../../types/container";

export async function updateAppOwned(
  id: string,
  teamId: string,
  set: Partial<typeof appsTable.$inferInsert>,
): Promise<void> {
  const updated = await getDb()
    .update(appsTable)
    .set(set)
    .where(and(eq(appsTable.id, id), eq(appsTable.teamId, teamId)))
    .returning({ id: appsTable.id });
  if (updated.length === 0) throw new Error("App not found");
}

export async function updateAppHealthCheck(
  id: string,
  input: HealthCheck | null,
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;
  const [app] = await getDb()
    .select({ source: appsTable.source })
    .from(appsTable)
    .where(and(eq(appsTable.id, id), eq(appsTable.teamId, membership.teamId)));
  if (!app) throw new Error("App not found");
  if (app.source === "compose")
    throw new Error(
      "A compose stack's health check belongs in its own compose file.",
    );
  const problem = healthCheckProblem(input);
  if (problem) throw new Error(problem);
  await updateAppOwned(id, membership.teamId, {
    ...healthCheckToRow(input),
    pendingChangesAt: nowIso(),
    updatedAt: nowIso(),
  });
  await recordActivity(
    "app",
    input ? "Turned on the health check" : "Turned off the health check",
    user.name,
    id,
  );
}

export async function setAppUpload(
  id: string,
  upload: UploadArchive,
): Promise<void> {
  const { membership } = await requireAppCapability(id, "deploy_apps");
  const user = (await getCurrentUser())!;
  await updateAppOwned(id, membership.teamId, {
    source: "upload",
    uploadId: upload.id,
    uploadFilename: upload.filename,
    uploadPath: upload.path,
    uploadSize: upload.size,
    uploadUploadedAt: upload.uploadedAt,
    repoProvider: null,
    repoUrl: null,
    repoRepo: null,
    repoBranch: null,
    repoInstallationId: null,
    repoConnectionId: null,
    repoTriggerType: null,
    repoWatchPaths: null,
    repoSubmodules: false,
    dockerImage: null,
    updatedAt: nowIso(),
  });
  await recordActivity("app", `Uploaded ${upload.filename}`, user.name, id);
}

export async function setAutoDeploy(id: string, value: boolean): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  await updateAppOwned(id, membership.teamId, {
    autoDeploy: value,
    updatedAt: nowIso(),
  });
}

export async function renameApp(id: string, name: string): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;
  const clean = cleanAppName(name);
  await updateAppOwned(id, membership.teamId, {
    name: clean,
    updatedAt: nowIso(),
  });
  await recordActivity("app", `Renamed app to ${clean}`, user.name, id);
}

export async function previewRepoFramework(input: {
  repo: string;
  url?: string | null;
  branch?: string | null;
  installationId?: string | null;
  buildMethod: BuildMethod;
  rootDirectory?: string | null;
}): Promise<RepoBuildHints> {
  await requireCapability("create_apps");
  if (!supportsFrameworkDetection(input.buildMethod))
    return {
      framework: null,
      staticOutput: null,
      startCommand: null,
      buildCommand: null,
    };

  let installationId: string | null = null;
  if (input.installationId) {
    const installations = await listGithubInstallations();
    installationId =
      installations.find((i) => i.id === input.installationId)?.id ?? null;
  }

  return detectRepoFramework(
    {
      provider: "github",
      url: input.url?.trim() || `https://github.com/${input.repo.trim()}`,
      repo: input.repo.trim(),
      branch: input.branch?.trim() || "",
      installationId,
    },
    input.rootDirectory,
  );
}

export async function setAppFramework(
  id: string,
  framework: string | null,
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;
  const value = framework?.trim() || null;
  if (value !== null && !isFrameworkId(value))
    throw new Error(`Unknown framework "${value}"`);
  const updated = await getDb()
    .update(appsTable)
    .set({ frameworkOverride: value, updatedAt: nowIso() })
    .where(and(eq(appsTable.id, id), eq(appsTable.teamId, membership.teamId)))
    .returning({ id: appsTable.id });
  if (updated.length === 0) throw new Error("App not found");
  await recordActivity(
    "app",
    value
      ? `Set framework to ${frameworkById(value)?.name ?? value}`
      : `Reset framework to what Deplo detects`,
    user.name,
    id,
  );
  publishAppChanged(id);
}

export async function setAppComposeUpArgs(
  id: string,
  value: string | null,
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;
  const raw = value?.trim() || null;
  if (raw) {
    const problem = validateComposeUpArgs(raw);
    if (problem) throw new Error(problem);
  }
  const updated = await getDb()
    .update(appsTable)
    .set({
      composeUpArgs: raw ? parseComposeUpArgs(raw).join(" ") : null,
      updatedAt: nowIso(),
    })
    .where(and(eq(appsTable.id, id), eq(appsTable.teamId, membership.teamId)))
    .returning({ id: appsTable.id });
  if (updated.length === 0) throw new Error("App not found");
  await recordActivity(
    "app",
    raw
      ? `Set extra compose flags to ${parseComposeUpArgs(raw).join(" ")}`
      : "Cleared the extra compose flags",
    user.name,
    id,
  );
  publishAppChanged(id);
}

export async function setAppRollbackKeep(
  id: string,
  count: number,
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;

  const keep = Number.isFinite(count)
    ? Math.min(MAX_ROLLBACK_KEEP, Math.max(0, Math.trunc(count)))
    : DEFAULT_ROLLBACK_KEEP;
  const updated = await getDb()
    .update(appsTable)
    .set({ rollbackKeep: keep, updatedAt: nowIso() })
    .where(and(eq(appsTable.id, id), eq(appsTable.teamId, membership.teamId)))
    .returning({ id: appsTable.id });
  if (updated.length === 0) throw new Error("App not found");
  await recordActivity(
    "app",
    keep === 0 ? "Turned rollbacks off" : `Set rollbacks kept to ${keep}`,
    user.name,
    id,
  );
  publishAppChanged(id);
}
