import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { getCurrentUser } from "../../auth/current-user";
import { requireCapability, canExposePorts } from "../../membership";
import { recordActivity } from "../activity";
import { encryptSecret } from "../../crypto";
import { connectAgent } from "../../infra/agent-client/connect";
import { buildConnectionString } from "../../deploy/database-compose";
import {
  migrateWorkloadData,
  stopStackOn,
  startStackOn,
  destroyStackOn,
} from "../volume-migration";
import { withKeyedLock } from "../keyed-mutex";
import { publishDatabaseChanged } from "../../graphql/pubsub";
import {
  MIN_USER_PORT,
  MAX_PORT,
  isValidExposePort,
} from "../../databases/ports";
import { assertNotProvisioning, requireDatabase } from "./rows";
import {
  databasePassword,
  dbVolumeHostName,
  renderDatabaseStackYaml,
  rerouteRequest,
} from "./stack";
import { assertHostPortAvailable, resolveTeamServer } from "./server-ports";

export async function updateDatabase(
  id: string,
  input: {
    exposedPublicly: boolean;
    exposedPort?: number;
    serverId?: string;
  },
): Promise<void> {
  const { membership } = await requireCapability("configure_databases");
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  const db = await requireDatabase(id, teamId);

  const exposed = input.exposedPublicly;
  if (exposed && !(await canExposePorts()))
    throw new Error("You don't have permission to publish ports");

  const targetServer = await resolveTeamServer(
    teamId,
    input.serverId ?? db.serverId,
  );
  const movingFrom = targetServer.id !== db.serverId ? db.serverId : null;

  let newExposedPort: number | null = null;
  if (exposed) {
    if (input.exposedPort == null)
      throw new Error(
        "A host port is required to expose the database publicly",
      );
    if (!isValidExposePort(input.exposedPort))
      throw new Error(
        `Port ${input.exposedPort} is invalid - choose an unprivileged port (${MIN_USER_PORT}-${MAX_PORT})`,
      );
    const reusingOwnPort =
      !movingFrom && db.exposedPublicly && db.exposedPort === input.exposedPort;
    if (!reusingOwnPort)
      await assertHostPortAvailable(targetServer, input.exposedPort, db.id);
    newExposedPort = input.exposedPort;
  }

  if (
    !movingFrom &&
    db.exposedPublicly === exposed &&
    db.exposedPort === newExposedPort
  )
    return;

  let moveWarning: string | null = null;
  await withKeyedLock(id, async () => {
    const cur = await requireDatabase(id, teamId);
    assertNotProvisioning(cur, "editing it");
    const password = databasePassword(cur);
    const connEnc = encryptSecret(
      buildConnectionString({
        type: cur.type,
        username: cur.username,
        password,
        host: newExposedPort != null ? targetServer.host : cur.host,
        port: newExposedPort != null ? newExposedPort : cur.port,
        dbName: cur.dbName,
      }),
    );
    const yaml = renderDatabaseStackYaml(
      { ...cur, exposedPublicly: exposed, exposedPort: newExposedPort },
      password,
    );
    const agent = await connectAgent(targetServer.id);
    try {
      const res = await agent.reroute(rerouteRequest(cur, yaml));
      if (!res.ok)
        throw new Error(res.error || "agent failed to update the database");
    } finally {
      agent.close();
    }

    if (movingFrom) {
      await stopStackOn(targetServer.id, cur.host);
      await stopStackOn(movingFrom, cur.host);
      try {
        const moved = await migrateWorkloadData(movingFrom, targetServer.id, {
          volumeNames: [dbVolumeHostName(cur.host)],
        });
        if (moved.missing.length > 0)
          throw new Error(
            `${moved.missing.join(", ")} is not on that server, so there was nothing to move`,
          );
      } catch (copyErr) {
        await destroyStackOn(targetServer.id, cur.host).catch(() => {});
        await startStackOn(movingFrom, cur.host).catch(() => {});
        throw new Error(
          `Failed to copy ${cur.name}'s data to ${targetServer.name}: ` +
            `${copyErr instanceof Error ? copyErr.message : String(copyErr)}. ` +
            `The move was rolled back - the database is still on its original server.`,
        );
      }
      try {
        await startStackOn(targetServer.id, cur.host);
      } catch (e) {
        moveWarning =
          `Moved ${cur.name}'s data to ${targetServer.name}, but its stack did not ` +
          `start there (${e instanceof Error ? e.message : String(e)}). ` +
          `Redeploy the database to bring it up.`;
      }

      try {
        const old = await connectAgent(movingFrom);
        try {
          const r = await old.destroyStack(cur.host, true);
          if (!r.ok)
            moveWarning =
              `Moved ${cur.name} to ${targetServer.name}, but the old server did ` +
              `not cleanly tear down ${cur.host} (${r.error || "unknown error"}). ` +
              `Its old container/volume may need a manual sweep on that host.`;
        } finally {
          old.close();
        }
      } catch (e) {
        moveWarning =
          `Moved ${cur.name} to ${targetServer.name}, but the old server was ` +
          `unreachable to tear down ${cur.host} ` +
          `(${e instanceof Error ? e.message : String(e)}). Its old container/` +
          `volume may need a manual sweep on that host.`;
      }
    }

    await getDb()
      .update(databasesTable)
      .set({
        serverId: targetServer.id,
        exposedPublicly: exposed,
        exposedPort: newExposedPort,
        connectionStringEnc: connEnc,
      })
      .where(eq(databasesTable.id, id));
    publishDatabaseChanged(id);
  });
  if (moveWarning) console.warn(`[databases] ${moveWarning}`);
  await recordActivity(
    "database",
    movingFrom
      ? moveWarning
        ? `Moved database ${db.name} to ${targetServer.name} (warning: ${moveWarning})`
        : `Moved database ${db.name} to ${targetServer.name}`
      : exposed
        ? `Exposed database ${db.name} on port ${newExposedPort}`
        : `Unexposed database ${db.name}`,
    user.name,
    null,
    teamId,
    null,
    db.id,
  );
}
