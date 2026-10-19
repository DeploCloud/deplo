import "server-only";

import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { apps, appTraefikLabels } from "../../db/schema/control-plane/apps";
import {
  requireConfigureTraefik,
  userMayConfigureTraefik,
} from "../../membership";
import {
  composeTraefikLabels,
  validateTraefikLabels,
  type TraefikLabel,
} from "../../deploy/traefik-overrides";
import { nowIso } from "../../ids";
import { publishAppChanged } from "../../graphql/pubsub";
import { requireAppCapability } from "../node-access";
import { recordActivity } from "../activity";
import { getCurrentUser } from "../../auth/current-user";

export async function authorizeComposeTraefik(
  compose: string | null | undefined,
): Promise<string | null> {
  const services = composeTraefikLabels(compose);
  if (!services.size) return null;
  const { userId } = await requireConfigureTraefik();
  for (const labels of services.values()) validateTraefikLabels(labels);
  return userId;
}

export async function loadAppTraefikLabels(
  appId: string,
): Promise<TraefikLabel[]> {
  return getDb()
    .select({ key: appTraefikLabels.key, value: appTraefikLabels.value })
    .from(appTraefikLabels)
    .where(eq(appTraefikLabels.appId, appId));
}

export async function getAppTraefikLabels(
  appId: string,
): Promise<TraefikLabel[]> {
  const { membership } = await requireAppCapability(appId, "configure_apps");
  await requireConfigureTraefik();
  return getDb()
    .select({ key: appTraefikLabels.key, value: appTraefikLabels.value })
    .from(appTraefikLabels)
    .innerJoin(apps, eq(apps.id, appTraefikLabels.appId))
    .where(and(eq(apps.id, appId), eq(apps.teamId, membership.teamId)));
}

export async function appTraefikOverrides(
  appId: string,
  preview = false,
): Promise<{ allowTraefikLabels: boolean; traefikLabels: TraefikLabel[] }> {
  if (preview) return { allowTraefikLabels: false, traefikLabels: [] };
  const [app] = await getDb()
    .select({ by: apps.traefikLabelsBy })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1);
  if (!app?.by) return { allowTraefikLabels: false, traefikLabels: [] };
  if (!(await userMayConfigureTraefik(app.by)))
    throw new Error(
      "The account that saved these Traefik labels no longer has permission. An authorized user must save them again.",
    );
  return {
    allowTraefikLabels: true,
    traefikLabels: await loadAppTraefikLabels(appId),
  };
}

export async function setAppTraefikLabels(
  appId: string,
  labels: TraefikLabel[],
): Promise<void> {
  const { membership } = await requireAppCapability(appId, "configure_apps");
  const { userId } = await requireConfigureTraefik();
  const validated = validateTraefikLabels(labels);
  await getDb().transaction(async (tx) => {
    const [app] = await tx
      .select({ source: apps.source, compose: apps.compose })
      .from(apps)
      .where(and(eq(apps.id, appId), eq(apps.teamId, membership.teamId)))
      .for("update");
    if (!app) throw new Error("App not found");
    if (app.source === "compose")
      throw new Error("Edit Traefik labels in this app's Compose file");
    await tx.delete(appTraefikLabels).where(eq(appTraefikLabels.appId, appId));
    if (validated.length)
      await tx
        .insert(appTraefikLabels)
        .values(validated.map((label) => ({ ...label, appId })));
    await tx
      .update(apps)
      .set({
        traefikLabelsBy:
          validated.length || composeTraefikLabels(app.compose).size
            ? userId
            : null,
        pendingChangesAt: nowIso(),
        updatedAt: nowIso(),
      })
      .where(and(eq(apps.id, appId), eq(apps.teamId, membership.teamId)));
  });
  await recordActivity(
    "app",
    "Updated Traefik labels",
    (await getCurrentUser())!.name,
    appId,
  );
  publishAppChanged(appId);
}
