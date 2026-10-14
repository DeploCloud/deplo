import "server-only";

import { eq, isNull } from "drizzle-orm";

import { getDb, type DbTx, type DrizzleClient } from "../db/client";
import {
  apps as appsTable,
  appVolumes as appVolumesTable,
} from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { pendingTeardowns as pendingTeardownsTable } from "../db/schema/control-plane/deployments";
import { appSlugFromDeployKey } from "../deploy/deploy-key";
import { hostVolumeName } from "../utils";

// The server agent checks no ownership, so every name Deplo puts on a host must lead back to ONE
// workload. Workload key K owns `deplo-K` and everything under `deplo-K-` / `deplo-K_`.
export interface HostNameClaims {
  apps: Set<string>;
  pending: { serverId: string; key: string }[];
  databases: { serverId: string; host: string }[];
  volumes: { appId: string; slug: string; host: string }[];
}

export async function hostNameClaims(
  db: DrizzleClient | DbTx = getDb(),
): Promise<HostNameClaims> {
  const [apps, pending, databases, volumes] = await Promise.all([
    db.select({ slug: appsTable.slug }).from(appsTable),
    db
      .select({
        serverId: pendingTeardownsTable.serverId,
        key: pendingTeardownsTable.deployKey,
      })
      .from(pendingTeardownsTable),
    db
      .select({
        serverId: databasesTable.serverId,
        host: databasesTable.host,
      })
      .from(databasesTable),
    db
      .select({
        appId: appVolumesTable.appId,
        slug: appsTable.slug,
        name: appVolumesTable.name,
      })
      .from(appVolumesTable)
      .innerJoin(appsTable, eq(appsTable.id, appVolumesTable.appId))
      .where(isNull(appVolumesTable.type)),
  ]);
  return {
    apps: new Set(apps.map((a) => a.slug)),
    pending,
    databases,
    volumes: volumes.map((v) => ({
      appId: v.appId,
      slug: v.slug,
      host: hostVolumeName(v.slug, v.name),
    })),
  };
}

function underKey(name: string, key: string): boolean {
  const own = `deplo-${key}`;
  return (
    name === own || name.startsWith(`${own}-`) || name.startsWith(`${own}_`)
  );
}

// A shorter app's volume already named inside `key`, e.g. app "my" with volume "app-data" under "my-app".
function volumeUnder(key: string, c: HostNameClaims): boolean {
  return c.volumes.some(
    (v) => v.slug.length < key.length && underKey(v.host, key),
  );
}

export function appSlugTaken(slug: string, c: HostNameClaims): boolean {
  return (
    c.apps.has(slug) ||
    c.pending.some((p) => appSlugFromDeployKey(p.key) === slug) ||
    c.databases.some((d) => d.host === slug) ||
    volumeUnder(slug, c)
  );
}

// Why `db-<slug>` cannot land on that server, or null when it can.
export function databaseHostClash(
  host: string,
  server: { id: string; name: string },
  c: HostNameClaims,
): string | null {
  if (c.databases.some((d) => d.serverId === server.id && d.host === host))
    return `a database stack named "${host}" already exists on ${server.name}`;
  if (c.pending.some((p) => p.serverId === server.id && p.key === host))
    return `a database stack named "${host}" is still being removed from ${server.name}`;
  if (c.apps.has(host) || volumeUnder(host, c))
    return `an app already uses the name "${host}"`;
  return null;
}

// A new volume of app `slug` must not reach into a longer key's names or equal another app's volume.
export function volumeNameClash(
  app: { id: string; slug: string },
  name: string,
  c: HostNameClaims,
): boolean {
  const host = hostVolumeName(app.slug, name);
  const keys = [
    ...c.apps,
    ...c.pending.map((p) => appSlugFromDeployKey(p.key)),
    ...c.databases.map((d) => d.host),
  ];
  return (
    keys.some((k) => k.length > app.slug.length && underKey(host, k)) ||
    c.volumes.some((v) => v.appId !== app.id && v.host === host)
  );
}
