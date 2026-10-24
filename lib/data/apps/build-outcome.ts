import "server-only";

import { and, eq, isNull, or } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  apps as appsTable,
  appBuild as appBuildTable,
} from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { publishAppChanged } from "../../graphql/pubsub";
import { nowIso } from "../../ids";
import type { BuildMethod } from "../../types/build";
import { recordActivity } from "../activity";

// What a deploy found out about the app. The deploy was already authorized, so these write as Deplo.

// Detect automatically: the settings show what the last deploy built with.
export async function recordResolvedMethod(
  appId: string,
  method: BuildMethod,
): Promise<void> {
  const updated = await getDb()
    .update(appBuildTable)
    .set({ buildMethod: method })
    .where(
      and(
        eq(appBuildTable.appId, appId),
        eq(appBuildTable.buildMethodAuto, true),
      ),
    )
    .returning({ appId: appBuildTable.appId });
  if (updated.length > 0) publishAppChanged(appId);
}

// The compose file read from the source is the app's stack until the next deploy reads it again.
export async function recordSourceCompose(
  appId: string,
  compose: string | null,
): Promise<void> {
  await getDb()
    .update(appsTable)
    .set({ compose, updatedAt: nowIso() })
    .where(eq(appsTable.id, appId));
  publishAppChanged(appId);
}

// A domain made before the app became a stack names no service, and a stack routes only by service.
export async function routeDomainsToService(
  appId: string,
  service: string,
  port: number,
): Promise<void> {
  await getDb()
    .update(domainsTable)
    .set({ service, port })
    .where(and(eq(domainsTable.appId, appId), isNull(domainsTable.service)));
}

export async function adoptObservedPort(
  appId: string,
  change: { from: number; to: number; service?: string | null },
): Promise<void> {
  const { from, to, service } = change;
  await getDb().transaction(async (tx) => {
    if (!service)
      await tx
        .update(appBuildTable)
        .set({ port: to })
        .where(
          and(eq(appBuildTable.appId, appId), eq(appBuildTable.port, from)),
        );
    await tx
      .update(domainsTable)
      .set({ port: to })
      .where(
        and(
          eq(domainsTable.appId, appId),
          service ? eq(domainsTable.service, service) : undefined,
          or(eq(domainsTable.port, from), isNull(domainsTable.port)),
        ),
      );
  });
  publishAppChanged(appId);
  await recordActivity(
    "app",
    `Routed traffic to port ${to}, the port the app listens on (it was ${from})`,
    "Deplo",
    appId,
  );
}
