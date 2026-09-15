import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { getCurrentUser } from "../../auth/current-user";
import { requireCapability } from "../../membership";
import { recordActivity } from "../activity";
import { encryptSecret, decryptSecret, randomToken } from "../../crypto";
import { connectAgent } from "../../infra/agent-client/connect";
import {
  buildConnectionString,
  parseConnectionPassword,
  effectiveDatabaseImage,
} from "../../deploy/database-compose";
import { isDockerLevelStderr } from "../../infra/docker";
import { withKeyedLock } from "../keyed-mutex";
import { assertPasswordPolicy } from "../../password-policy";
import { publishDatabaseChanged } from "../../graphql/pubsub";
import { assertPasswordSafe } from "./validate";
import { requireDatabase } from "./rows";
import { renderDatabaseStackYaml, rerouteRequest } from "./stack";
import { resolveTeamServer } from "./server-ports";
import type { Database } from "../../types/database";

// postgres/mysql/mariadb/mongodb keep users INSIDE the data volume; redis/clickhouse rotate on re-render.
export function rotationExecCommand(
  db: Database,
  oldPassword: string,
  newPassword: string,
): string | null {
  const old = shellQuote(oldPassword);
  switch (db.type) {
    case "postgres":
      return `psql -U ${db.username} -d ${db.dbName} -c ${shellQuote(
        `ALTER USER "${db.username}" WITH PASSWORD ${sqlQuote(newPassword)}`,
      )}`;
    case "mysql":
    case "mariadb": {
      const stmts = [
        `ALTER USER IF EXISTS 'root'@'%' IDENTIFIED BY ${sqlQuote(newPassword)};`,
        `ALTER USER IF EXISTS 'root'@'localhost' IDENTIFIED BY ${sqlQuote(newPassword)};`,
        ...(db.username !== "root"
          ? [
              `ALTER USER IF EXISTS '${db.username}'@'%' IDENTIFIED BY ${sqlQuote(newPassword)};`,
            ]
          : []),
        "FLUSH PRIVILEGES;",
      ].join(" ");
      // MariaDB 11 dropped the mysql* compatibility symlinks its images used to ship.
      const client = db.type === "mariadb" ? "mariadb" : "mysql";
      return `${client} -uroot -p${old} -e ${shellQuote(stmts)}`;
    }
    case "mongodb":
      return (
        `mongosh -u ${db.username} -p ${old} --authenticationDatabase admin --quiet ` +
        `--eval ${shellQuote(
          `db.getSiblingDB('admin').changeUserPassword(${jsQuote(db.username)}, ${jsQuote(newPassword)})`,
        )}`
      );
    case "redis":
    case "clickhouse":
      return null;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function jsQuote(value: string): string {
  return JSON.stringify(value);
}

export async function rotateDatabasePassword(
  id: string,
  input: { password?: string } = {},
): Promise<string> {
  const teamId = (await requireCapability("configure_databases")).teamId;
  const user = (await getCurrentUser())!;

  const newPassword = input.password?.trim() || randomToken(24);
  assertPasswordSafe(newPassword);
  // The policy only bounds a password a person typed: a generated token is base64url and often fails it.
  if (input.password?.trim()) assertPasswordPolicy(newPassword);

  let newConn = "";
  let name = "";
  await withKeyedLock(id, async () => {
    const cur = await requireDatabase(id, teamId);
    name = cur.name;
    if (cur.status !== "running")
      throw new Error("Start the database before rotating its password.");

    const oldPassword = parseConnectionPassword(
      decryptSecret(cur.connectionStringEnc),
    );
    const execCmd = rotationExecCommand(cur, oldPassword, newPassword);

    if (execCmd) {
      const conn = await connectAgent(cur.serverId);
      try {
        const res = await conn.exec(
          cur.id,
          cur.host,
          execCmd,
          effectiveDatabaseImage(cur),
        );
        if (isDockerLevelStderr(res.stderr))
          throw new Error(
            `Could not run the rotation inside the container: ${res.stderr.trim()}`,
          );
        if (res.code !== 0)
          throw new Error(
            `The engine rejected the password change${res.stderr.trim() ? `: ${res.stderr.trim()}` : ` (exit ${res.code})`}`,
          );
      } finally {
        conn.close();
      }
    }

    const exposedHostPort =
      cur.exposedPublicly && cur.exposedPort != null ? cur.exposedPort : null;
    const server =
      exposedHostPort != null
        ? await resolveTeamServer(teamId, cur.serverId)
        : null;
    newConn = buildConnectionString({
      type: cur.type,
      username: cur.username,
      password: newPassword,
      host: server ? server.host : cur.host,
      port: exposedHostPort ?? cur.port,
      dbName: cur.dbName,
    });
    await getDb()
      .update(databasesTable)
      .set({ connectionStringEnc: encryptSecret(newConn) })
      .where(eq(databasesTable.id, id));

    const updated: Database = {
      ...cur,
      connectionStringEnc: encryptSecret(newConn),
    };
    const yaml = renderDatabaseStackYaml(updated, newPassword);
    const conn = await connectAgent(cur.serverId);
    try {
      const res = await conn.reroute(rerouteRequest(cur, yaml));
      if (!res.ok)
        throw new Error(
          `The password was rotated but the container config could not be updated ` +
            `(${res.error || "agent error"}). Run Redeploy to bring it in sync.`,
        );
    } finally {
      conn.close();
    }
    publishDatabaseChanged(id);
  });
  await recordActivity(
    "database",
    `Rotated the password of ${name}`,
    user.name,
    null,
    teamId,
    null,
    id,
  );
  return newConn;
}
