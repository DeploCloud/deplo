import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  apps as appsTable,
  appPorts as appPortsTable,
} from "../../db/schema/control-plane/apps";
import { getCurrentUser } from "../../auth/current-user";
import { newId, nowIso } from "../../ids";
import { requireExposePorts } from "../../membership";
import {
  MAX_PORT,
  MIN_USER_PORT,
  isValidExposePort,
} from "../../databases/ports";
import { MAX_PUBLISHED_PORTS } from "../../types/container";
import { hostPortClaimed } from "../host-ports";
import { portsToRows } from "../app-graph-rows/app";
import { requireAppCapability } from "../node-access";
import { recordActivity } from "../activity";
import type { PublishedPort } from "../../types/container";

// validatePorts applies the published-port rules. Pure, so the settings form and the importer share the refusals.
export function validatePorts(raw: PublishedPort[]): PublishedPort[] {
  const seen = new Set<string>();
  const out: PublishedPort[] = [];
  for (const p of raw) {
    const published = Number(p.published);
    const target = Number(p.target);
    if (!isValidExposePort(published))
      throw new Error(
        `A published port must be between ${MIN_USER_PORT} and ${MAX_PORT}: ${p.published}`,
      );
    if (!Number.isInteger(target) || target < 1 || target > MAX_PORT)
      throw new Error(`That is not a port inside the container: ${p.target}`);
    const protocol = p.protocol === "udp" ? "udp" : "tcp";
    const key = `${published}/${protocol}`;
    if (seen.has(key))
      throw new Error(`This app publishes ${published} twice.`);
    seen.add(key);
    out.push({
      id: p.id?.trim() || newId("prt"),
      published,
      target,
      protocol,
    });
  }
  if (out.length > MAX_PUBLISHED_PORTS)
    throw new Error(`An app can publish at most ${MAX_PUBLISHED_PORTS} ports.`);
  return out;
}

// setAppPorts replaces the published host ports (full set); they take effect on the next deploy.
export async function setAppPorts(
  id: string,
  ports: PublishedPort[],
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");

  // A published port is reachable PAST the proxy and every gate it applies, so it needs its own grant.
  if (ports.length > 0) await requireExposePorts();
  const user = (await getCurrentUser())!;
  const validated = validatePorts(ports);

  const [app] = await getDb()
    .select({ source: appsTable.source, serverId: appsTable.serverId })
    .from(appsTable)
    .where(and(eq(appsTable.id, id), eq(appsTable.teamId, membership.teamId)));
  if (!app) throw new Error("App not found");
  if (app.source === "compose")
    throw new Error(
      "A compose stack publishes its ports in its own compose file.",
    );

  // A host port is a singleton on a shared machine: the row that would collide can belong to another team.
  // ponytail: rows only, no agent probe - a port something OUTSIDE Deplo holds
  // surfaces as docker's own refusal on the deploy, like a compose stack's does.
  for (const p of validated)
    if (await hostPortClaimed(app.serverId, p.published, { appId: id }))
      throw new Error(
        `Port ${p.published} is already published on this server. Pick a different one.`,
      );

  await getDb().transaction(async (tx) => {
    await tx.delete(appPortsTable).where(eq(appPortsTable.appId, id));
    const rows = portsToRows(id, validated);
    if (rows.length > 0) await tx.insert(appPortsTable).values(rows);
    await tx
      .update(appsTable)
      .set({ pendingChangesAt: nowIso(), updatedAt: nowIso() })
      .where(eq(appsTable.id, id));
  });
  await recordActivity("app", "Updated published ports", user.name, id);
}
