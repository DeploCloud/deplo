import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  clusterMembers as membersTable,
  imageArchitectures as archsTable,
} from "../../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { effectiveDatabaseImage } from "../../deploy/database-compose";
import { nowIso } from "../../ids";
import { imageArchitectures } from "../../registry/client";
import { archWords } from "../../types/cluster";
import type { DatabaseType } from "../../types/database";
import { isBuiltImage } from "./images";
import { getCluster } from "./roster";

// https://deplo.build/docs/operations/clusters/replicas-and-architectures#mix-arm-and-x86-servers

const DAY_MS = 24 * 60 * 60 * 1000;
/** How soon an image no registry described is asked about again. */
const RETRY_MS = 60 * 60 * 1000;
/** The row that says "asked, and nothing was listed". */
const NONE = "";

async function stored(ref: string) {
  return getDb()
    .select({ arch: archsTable.arch, checkedAt: archsTable.checkedAt })
    .from(archsTable)
    .where(eq(archsTable.imageRef, ref));
}

/** What a pulled image is known to run on, without asking anyone; empty when not known. */
async function knownImageArchs(imageRef: string): Promise<string[]> {
  const ref = imageRef.trim();
  if (!ref || isBuiltImage(ref)) return [];
  return (await stored(ref))
    .map((r) => r.arch)
    .filter((a) => a !== NONE)
    .sort();
}

// ponytail: public registries only, read without credentials. A private image stays "not known" and is kept
// on the architecture it runs on; have the server agent read its manifest when someone needs more.
async function pulledImageArchs(ref: string): Promise<string[]> {
  const rows = await stored(ref);
  const known = rows.map((r) => r.arch).filter((a) => a !== NONE);
  const age = Date.now() - Date.parse(rows[0]?.checkedAt ?? "");
  if (rows.length > 0 && age < (known.length > 0 ? DAY_MS : RETRY_MS))
    return known.sort();
  const listed = await imageArchitectures(ref).catch(() => []);
  // A registry that stopped answering does not take back what it said before.
  const keep = listed.length > 0 ? listed : known.length > 0 ? known : [NONE];
  const checkedAt = nowIso();
  await getDb().transaction(async (tx) => {
    await tx.delete(archsTable).where(eq(archsTable.imageRef, ref));
    await tx
      .insert(archsTable)
      .values(keep.map((arch) => ({ imageRef: ref, arch, checkedAt })))
      .onConflictDoNothing();
  });
  return keep.filter((a) => a !== NONE).sort();
}

async function archOf(serverId: string | null | undefined): Promise<string> {
  if (!serverId) return "";
  const [row] = await getDb()
    .select({ arch: serversTable.hostArch })
    .from(serversTable)
    .where(eq(serversTable.id, serverId))
    .limit(1);
  return row?.arch ?? "";
}

/**
 * The architectures an image runs on: a built one where it was built, a pulled one wherever its registry lists,
 * one nobody describes only on the server it runs on now. Empty means any. `lookup: false` never asks a registry.
 */
export async function imageArchs(
  imageRef: string,
  serverId?: string | null,
  opts: { lookup?: boolean } = {},
): Promise<string[]> {
  const ref = imageRef.trim();
  if (ref && !isBuiltImage(ref)) {
    const listed =
      opts.lookup === false
        ? await knownImageArchs(ref)
        : await pulledImageArchs(ref);
    if (listed.length > 0) return listed;
  }
  const here = await archOf(serverId);
  return here ? [here] : [];
}

/** The image a placed App or database runs, and whether Deplo pulls it rather than builds it. */
async function imageOf(
  kind: "app" | "database",
  id: string,
): Promise<{ image: string; pulled: boolean; serverId: string } | null> {
  if (kind === "database") {
    const [db] = await getDb()
      .select({
        type: databasesTable.type,
        version: databasesTable.version,
        customImage: databasesTable.customImage,
        serverId: databasesTable.serverId,
      })
      .from(databasesTable)
      .where(eq(databasesTable.id, id))
      .limit(1);
    if (!db) return null;
    const image = effectiveDatabaseImage({
      ...db,
      type: db.type as DatabaseType,
    });
    return { image, pulled: true, serverId: db.serverId };
  }
  const [app] = await getDb()
    .select({
      source: appsTable.source,
      dockerImage: appsTable.dockerImage,
      serverId: appsTable.serverId,
    })
    .from(appsTable)
    .where(eq(appsTable.id, id))
    .limit(1);
  if (!app) return null;
  const pulled = app.source === "docker-image" && Boolean(app.dockerImage);
  return {
    image: pulled ? (app.dockerImage ?? "") : "",
    pulled,
    serverId: app.serverId,
  };
}

/**
 * What a move that deploys again can land on. A built App is built again where it lands, so only a pulled
 * image restricts it; a database always runs a pulled image.
 */
export async function redeployArchs(
  kind: "app" | "database",
  id: string,
): Promise<string[]> {
  const w = await imageOf(kind, id);
  return w?.pulled ? imageArchs(w.image, w.serverId) : [];
}

/** "x86" when a workload that runs on `archs` cannot use every one of these servers; null when it can. */
export function onlyArch(
  archs: string[] | undefined,
  members: { arch: string }[],
): string | null {
  return archs?.length && members.some((m) => !archs.includes(m.arch))
    ? archWords(archs)
    : null;
}

function memberArchs(clusterId: string) {
  return getDb()
    .select({ name: serversTable.name, arch: serversTable.hostArch })
    .from(membersTable)
    .innerJoin(serversTable, eq(serversTable.id, membersTable.serverId))
    .where(eq(membersTable.clusterId, clusterId));
}

/** "x86" when a failover of this workload cannot use every server of its cluster; null when it can. */
export async function failoverOnly(
  kind: "app" | "database",
  id: string,
  clusterId: string,
): Promise<string | null> {
  const w = await imageOf(kind, id);
  if (!w) return null;
  return onlyArch(
    await imageArchs(w.image, w.serverId, { lookup: false }),
    await memberArchs(clusterId),
  );
}

export interface FailoverReach {
  /** "Fails over to x86 servers only (2 of 3)". */
  line: string | null;
  /** "If server-a stops, web has nowhere to go ..." when a single server can run it. */
  warning: string | null;
}

/**
 * What a mixed cluster means for one App the caller already read under its own gates: which servers it can
 * fail over to. Both null on a cluster of one architecture, or for an image that runs on all of them.
 */
export async function appFailoverReach(app: {
  name: string;
  clusterId?: string | null;
  serverId: string;
  source: string;
  dockerImage?: string | null;
}): Promise<FailoverReach> {
  return reachOf({
    name: app.name,
    clusterId: app.clusterId,
    serverId: app.serverId,
    image: app.source === "docker-image" ? (app.dockerImage ?? "") : "",
  });
}

/** The same for a database the caller already read under its own gates. */
export async function databaseFailoverReach(d: {
  id: string;
  name: string;
  clusterId?: string | null;
}): Promise<FailoverReach> {
  const w = d.clusterId ? await imageOf("database", d.id) : null;
  return reachOf({ name: d.name, clusterId: w ? d.clusterId : null, ...w });
}

async function reachOf(w: {
  name: string;
  clusterId?: string | null;
  serverId?: string;
  image?: string;
}): Promise<FailoverReach> {
  const none = { line: null, warning: null };
  if (!w.clusterId || !w.serverId) return none;
  // A cluster the team can no longer see is not described to it.
  const cluster = await getCluster(w.clusterId);
  if (!cluster) return none;
  const members = await memberArchs(cluster.id);
  const archs = await imageArchs(w.image ?? "", w.serverId, { lookup: false });
  const word = onlyArch(archs, members);
  if (!word) return none;
  const can = members.filter((m) => archs.includes(m.arch));
  if (can.length === 1)
    return {
      line: null,
      warning: `If ${can[0]!.name} stops, ${w.name} has nowhere to go. It is the only ${word} server in ${cluster.name}.`,
    };
  return {
    line: `Fails over to ${word} servers only (${can.length} of ${members.length})`,
    warning: null,
  };
}
