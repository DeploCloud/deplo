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

// dbVolumeHostName - the host-side Docker volume name of a database's data volume.
export function dbVolumeHostName(slug: string): string {
  return `deplo-${slug}_${slug}-data`;
}

// mountFilesFor - the config files a Reroute has to carry, in the agent's shape.
export function mountFilesFor(
  db: Database,
): { path: string; content: string }[] {
  return db.mounts.map((m) => ({ path: m.filePath, content: m.content }));
}

// renderDatabaseStackYaml - the ONE render call for a database's compose stack.
export function renderDatabaseStackYaml(
  db: Database,
  password: string,
): string {
  return generateDatabaseCompose({
    name: db.host, // service slug, stable
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

// rerouteRequest - the agent Reroute payload every apply path sends.
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

// databasePassword - the engine password, refusing an undecryptable one rather
// than rendering an empty credential into the stack.
export function databasePassword(db: Database): string {
  return parseConnectionPassword(
    decryptSecretOrThrow(db.connectionStringEnc, "The database password"),
  );
}

// getDatabaseVolumeBytes - how much disk the data volume occupies, measured on
// the host. null when the agent is too old or unreachable - a dash, never a zero.
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
    // An unreachable host is not evidence about the size. Say nothing.
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

// rerouteDatabase - re-render the stack on its owning agent and bring it up on
// the network its placement owns. `unchanged` when the host file already matches.
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

// teardownDatabaseStack - tear the stack down on its owning server and PROVE
// nothing of it survived. Returns the reason it could not, or null.
export async function teardownDatabaseStack(
  db: Database,
): Promise<string | null> {
  const conn = await connectAgent(db.serverId);
  try {
    let res = await conn.destroyStack(db.host, true);
    if (!res.ok) {
      // The volume is about to be dropped, so the password is irrelevant here:
      // fall back to a throwaway rather than throw (which would block reclaiming
      // the volume).
      let password: string;
      try {
        password = databasePassword(db);
      } catch {
        password = randomToken(24);
      }
      const healed = await conn.reroute(
        rerouteRequest(db, renderDatabaseStackYaml(db, password)),
      );
      // A failed heal leaves `res`, the ORIGINAL destroy error, as the reason;
      // it is the actionable one (the heal error is a symptom of the same host).
      if (healed.ok) res = await conn.destroyStack(db.host, true);
    }
    // Trust, then verify. An agent too old for the label (or one that errors on
    // the probe) yields null: we can't verify, so the destroy's own verdict
    // stands rather than blocking a delete on a check we couldn't run.
    const left = await conn
      .listInstances(db.id, db.host, db.host)
      .catch(() => null);
    const leftover = left !== null && left.length > 0;
    if (leftover || !res.ok) {
      // Whatever we could not remove must at least not be SERVING - the user
      // asked for this database to go.
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
