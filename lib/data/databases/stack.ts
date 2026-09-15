import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { assembleDatabase } from "../backup-rows";
import { requireActiveTeamId } from "../../membership";
import { decryptSecretOrThrow, randomToken } from "../../crypto";
import { connectAgent } from "../../infra/agent-client/connect";
import { VOLUME_USAGE_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import { serverSupports } from "../../infra/agent-client/preflight";
import {
  generateDatabaseCompose,
  parseConnectionPassword,
} from "../../deploy/database-compose";
import { stackFilesDir } from "../../deploy/deploy-key";
import { appNetwork, explainNetworkError } from "../../deploy/network";
import { loadDatabase, mountsFor } from "./rows";
import type { Database } from "../../types/database";

export function dbVolumeHostName(slug: string): string {
  return `deplo-${slug}_${slug}-data`;
}

export function mountFilesFor(
  db: Database,
): { path: string; content: string }[] {
  return db.mounts.map((m) => ({ path: m.filePath, content: m.content }));
}

export function renderDatabaseStackYaml(
  db: Database,
  password: string,
): string {
  return generateDatabaseCompose({
    name: db.host,
    databaseId: db.id,
    type: db.type,
    version: db.version,
    username: db.username,
    password,
    dbName: db.dbName,
    hostPort:
      db.exposedPublicly && db.exposedPort != null ? db.exposedPort : undefined,
    resources: db.resources,
    customImage: db.customImage,
    customCommand: db.customCommand,
    mounts: db.mounts,
    filesDir: stackFilesDir(db.host),
    network: appNetwork(db),
  });
}

export function rerouteRequest(
  db: Database,
  composeYaml: string,
): {
  slug: string;
  composeYaml: string;
  env: Record<string, string>;
  mounts: { path: string; content: string }[];
  network: string;
} {
  return {
    slug: db.host,
    composeYaml,
    env: {},
    mounts: mountFilesFor(db),
    network: appNetwork(db),
  };
}

export function databasePassword(db: Database): string {
  return parseConnectionPassword(
    decryptSecretOrThrow(db.connectionStringEnc, "The database password"),
  );
}

export async function getDatabaseVolumeBytes(
  id: string,
): Promise<number | null> {
  const teamId = await requireActiveTeamId();
  const db = await loadDatabase(id, teamId, { forRead: true });
  if (!db) return null;
  if (!(await serverSupports(db.serverId, VOLUME_USAGE_CAPABILITY)))
    return null;

  const volume = dbVolumeHostName(db.host);
  let bytes: number | undefined;
  try {
    const conn = await connectAgent(db.serverId);
    try {
      bytes = (await conn.volumeUsage([volume])).get(volume);
    } finally {
      conn.close();
    }
  } catch {
    return null;
  }
  if (bytes === undefined) return null;

  const sizeMb = Math.round(bytes / (1024 * 1024));
  if (sizeMb !== db.sizeMb) {
    await getDb()
      .update(databasesTable)
      .set({ sizeMb })
      .where(
        and(eq(databasesTable.id, db.id), eq(databasesTable.teamId, teamId)),
      );
  }
  return bytes;
}

export async function rerouteDatabase(
  id: string,
): Promise<"rerouted" | "unchanged" | "deferred"> {
  const rows = await getDb()
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return "deferred";
  const cur = assembleDatabase(row, await mountsFor(row.id));
  if (!cur || cur.status === "provisioning") return "deferred";
  const password = databasePassword(cur);
  const rendered = renderDatabaseStackYaml(cur, password);
  const conn = await connectAgent(cur.serverId);
  try {
    const current = await conn.readStack(cur.host);
    if (current.exists && current.yaml === rendered) return "unchanged";
    const r = await conn.reroute(rerouteRequest(cur, rendered));
    if (!r.ok)
      throw new Error(
        explainNetworkError(r.error || "agent failed to reroute the database"),
      );
    return "rerouted";
  } finally {
    conn.close();
  }
}

export async function teardownDatabaseStack(
  db: Database,
): Promise<string | null> {
  const conn = await connectAgent(db.serverId);
  try {
    let res = await conn.destroyStack(db.host, true);
    if (!res.ok) {
      let password: string;
      try {
        password = databasePassword(db);
      } catch {
        password = randomToken(24);
      }
      const healed = await conn.reroute(
        rerouteRequest(db, renderDatabaseStackYaml(db, password)),
      );
      if (healed.ok) res = await conn.destroyStack(db.host, true);
    }
    const left = await conn
      .listInstances(db.id, db.host, db.host)
      .catch(() => null);
    const leftover = left !== null && left.length > 0;
    if (leftover || !res.ok) {
      await conn.stopStack(db.host).catch(() => {});
      return leftover
        ? `its container survived the teardown` +
            (res.error ? ` (${res.error})` : "")
        : res.error || "the teardown failed";
    }
    return null;
  } finally {
    conn.close();
  }
}
