import "server-only";

import { eq } from "drizzle-orm";

import { getServerById } from "../servers/roster";
import { getDb } from "../../db/client";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { getCurrentUser } from "../../auth/current-user";
import { requireCapability } from "../../membership";
import { recordActivity } from "../activity";
import { connectAgent } from "../../infra/agent-client/connect";
import { withKeyedLock } from "../keyed-mutex";
import { enqueueTeardowns } from "../teardown-queue";
import { assertDataCopyIntact, clearDataCopyError } from "../data-copy";
import { publishDatabaseChanged } from "../../graphql/pubsub";
import { assertNotProvisioning, databaseExists, requireDatabase } from "./rows";
import {
  databasePassword,
  renderDatabaseStackYaml,
  rerouteDatabase,
  rerouteRequest,
  teardownDatabaseStack,
} from "./stack";

export async function setDatabaseRunning(
  id: string,
  running: boolean,
): Promise<void> {
  const teamId = (await requireCapability("control_databases")).teamId;
  const db = await requireDatabase(id, teamId);
  const host = db.host;
  const serverId = db.serverId;
  // Serialize on the DB's lifecycle lock: a start/stop issued during
  // provisioning WAITS rather than racing its status write.
  await withKeyedLock(id, async () => {
    // Re-read under the lock - the DB may have been deleted, or just finished
    // provisioning, while we waited our turn.
    const cur = await requireDatabase(id, teamId);
    assertNotProvisioning(cur, "starting or stopping it");
    // Reroute BEFORE starting: `compose start` returns the container to the
    // network it was CREATED on, and fails once that network is reclaimed.
    if (running && (await rerouteDatabase(id)) === "rerouted") {
      await getDb()
        .update(databasesTable)
        .set({ status: "running" })
        .where(eq(databasesTable.id, id));
      publishDatabaseChanged(id);
      return;
    }
    const conn = await connectAgent(serverId);
    try {
      const res = running
        ? await conn.startStack(host)
        : await conn.stopStack(host);
      if (!res.ok)
        throw new Error(
          res.error ||
            `agent failed to ${running ? "start" : "stop"} the database`,
        );
    } finally {
      conn.close();
    }
    await getDb()
      .update(databasesTable)
      .set({ status: running ? "running" : "stopped" })
      .where(eq(databasesTable.id, id));
    publishDatabaseChanged(id);
  });
}

// restartDatabase - stop + start on the owning agent. Same lock/gate discipline
// as setDatabaseRunning.
export async function restartDatabase(id: string): Promise<void> {
  const teamId = (await requireCapability("control_databases")).teamId;
  const user = (await getCurrentUser())!;
  let name = "";
  await withKeyedLock(id, async () => {
    const cur = await requireDatabase(id, teamId);
    name = cur.name;
    assertNotProvisioning(cur, "restarting it");
    // An engine started on the volume a failed copy emptied does not fail: it
    // initialises a new database over the old one's place. Refuse until the data
    // is here or the loss is accepted.
    assertDataCopyIntact(cur.name, cur.dataCopyError);
    const conn = await connectAgent(cur.serverId);
    try {
      const stop = await conn.stopStack(cur.host);
      if (!stop.ok)
        throw new Error(stop.error || "agent failed to stop the database");
      const start = await conn.startStack(cur.host);
      if (!start.ok)
        throw new Error(start.error || "agent failed to start the database");
    } finally {
      conn.close();
    }
    await getDb()
      .update(databasesTable)
      .set({ status: "running" })
      .where(eq(databasesTable.id, id));
    publishDatabaseChanged(id);
  });
  await recordActivity(
    "database",
    `Restarted database ${name}`,
    user.name,
    null,
    teamId,
    null,
    id,
  );
}

// redeployDatabase - re-render the compose from the CURRENT row and reroute it,
// the "apply my pending settings" verb.
export async function redeployDatabase(id: string): Promise<void> {
  const teamId = (await requireCapability("control_databases")).teamId;
  const user = (await getCurrentUser())!;
  let name = "";
  await withKeyedLock(id, async () => {
    const cur = await requireDatabase(id, teamId);
    name = cur.name;
    assertNotProvisioning(cur, "redeploying it");
    assertDataCopyIntact(cur.name, cur.dataCopyError);
    // Redis auth rides a compose `--requirepass` flag applied on every boot, so
    // an empty password here would silently disable auth even on a preserved
    // volume. Refuse rather than emit an empty credential.
    const password = databasePassword(cur);
    const yaml = renderDatabaseStackYaml(cur, password);
    const conn = await connectAgent(cur.serverId);
    try {
      const res = await conn.reroute(rerouteRequest(cur, yaml));
      if (!res.ok)
        throw new Error(res.error || "agent failed to redeploy the database");
    } finally {
      conn.close();
    }
    await getDb()
      .update(databasesTable)
      .set({ status: "running" })
      .where(eq(databasesTable.id, id));
    publishDatabaseChanged(id);
  });
  await recordActivity(
    "database",
    `Redeployed database ${name}`,
    user.name,
    null,
    teamId,
    null,
    id,
  );
}

// rebuildDatabase - the DESTRUCTIVE Danger Zone "factory reset": never preserves
// the volume, unlike redeployDatabase.
export async function rebuildDatabase(id: string): Promise<void> {
  const teamId = (await requireCapability("delete_databases")).teamId;
  const user = (await getCurrentUser())!;
  let name = "";
  await withKeyedLock(id, async () => {
    const cur = await requireDatabase(id, teamId);
    name = cur.name;
    assertNotProvisioning(cur, "rebuilding it");
    // A rebuild re-inits the engine from these credentials, so an undecryptable
    // password (post `DEPLO_SECRET` rotation) would boot it with NO auth - a
    // publicly-exposed redis with an empty password. Refuse instead.
    const password = databasePassword(cur);
    const yaml = renderDatabaseStackYaml(cur, password);
    const conn = await connectAgent(cur.serverId);
    try {
      const down = await conn.destroyStack(cur.host, true);
      if (!down.ok)
        throw new Error(down.error || "agent failed to tear down the database");
      const up = await conn.reroute(rerouteRequest(cur, yaml));
      if (!up.ok) {
        await getDb()
          .update(databasesTable)
          .set({ status: "error" })
          .where(eq(databasesTable.id, id));
        publishDatabaseChanged(id);
        throw new Error(
          up.error || "agent failed to re-provision the database",
        );
      }
    } finally {
      conn.close();
    }
    await getDb()
      .update(databasesTable)
      .set({ status: "running" })
      .where(eq(databasesTable.id, id));
    // A factory reset is the one action that makes an empty volume the INTENDED
    // state, so it also settles a failed migration copy.
    await clearDataCopyError({ kind: "database", id });
    publishDatabaseChanged(id);
  });
  await recordActivity(
    "database",
    `Rebuilt database ${name} from scratch (data volume wiped)`,
    user.name,
    null,
    teamId,
    "database_rebuilt",
    id,
  );
}

// deleteDatabase - destroy the real container and its data volume on the owning
// server, then drop the row. It refuses unless the host proves both are gone.
export async function deleteDatabase(
  id: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const { membership } = await requireCapability("delete_databases");
  const user = (await getCurrentUser())!;
  const db = await requireDatabase(id, membership.teamId);
  const server = await getServerById(db.serverId);
  const where = server ? server.name : "its server";
  await withKeyedLock(id, async () => {
    // Re-check under the lock: a concurrent delete (or never-finished provision
    // that bailed) may have already removed the row. Idempotent → just return.
    if (!(await databaseExists(id))) return;
    let failure: { why: string; retry: string } | null = null;
    try {
      const reason = await teardownDatabaseStack(db);
      if (reason)
        failure = {
          why: `${where} could not remove it: ${reason}`,
          retry: "Try again",
        };
    } catch (e) {
      failure = {
        why: `${where} could not be reached (${e instanceof Error ? e.message : String(e)})`,
        retry: `Try again once ${where} is back online`,
      };
    }
    if (failure) {
      console.warn(`[databases] teardown of ${db.host} failed: ${failure.why}`);
      if (!opts.force)
        throw new Error(
          `${db.name} was NOT deleted: ${failure.why}. Nothing has been removed ` +
            `from Deplo. ${failure.retry}, or delete it anyway and Deplo will ` +
            `keep retrying the teardown on that host.`,
        );
      // Forced: the row goes now, but the queue keeps retrying the teardown
      // until the host confirms both the container and the volume are gone.
      await enqueueTeardowns([
        {
          serverId: db.serverId,
          deployKey: db.host,
          projectLabel: db.id,
          label: db.name,
          teamId: db.teamId,
        },
      ]);
    }
    // One DELETE - the agent teardown above ran OUTSIDE any transaction.
    await getDb().delete(databasesTable).where(eq(databasesTable.id, id));
    // Tell subscribers: the reload comes back null, ending their streams.
    publishDatabaseChanged(id);
    await recordActivity(
      "database",
      failure
        ? `Deleted database ${db.name} from Deplo, but ${failure.why}. Deplo ` +
            `will retry the teardown of its container and volume on ${where}.`
        : `Deleted database ${db.name}`,
      user.name,
      null,
      db.teamId,
      "database_deleted",
      // NOT linked: the row is already gone, so the FK would refuse it - and
      // `ON DELETE SET NULL` would have unlinked it a moment later anyway.
      null,
    );
  });
}
