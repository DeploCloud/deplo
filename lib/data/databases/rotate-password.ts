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

// rotationExecCommand - the per-engine in-engine rotation step.
// postgres/mysql/mariadb/mongodb persist their users INSIDE the data volume, so
// the compose env alone is a silent no-op; redis and clickhouse rotate on re-render.
export function rotationExecCommand(
  db: Database,
  oldPassword: string,
  newPassword: string,
): string | null {
  const old = shellQuote(oldPassword);
  switch (db.type) {
    case "postgres":
      // Unix-socket auth inside the official image is `trust`, no old password
      // needed; the POSTGRES_USER login is a superuser.
      return `psql -U ${db.username} -d ${db.dbName} -c ${shellQuote(
        `ALTER USER "${db.username}" WITH PASSWORD ${sqlQuote(newPassword)}`,
      )}`;
    case "mysql":
    case "mariadb": {
      // root too: backups dump as root with that password.
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
      // MariaDB 11 dropped the `mysql*` compatibility symlinks its images used
      // to ship, so the client is only reachable under its own name there.
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
      return null; // compose re-render alone rotates
  }
}

// shellQuote - wrap a value so a POSIX shell reads it as one literal argument.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// sqlQuote - a SQL string literal: the standard doubles its own quote.
function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// jsQuote - a JavaScript string literal, for the one engine whose client speaks JS.
function jsQuote(value: string): string {
  return JSON.stringify(value);
}

// rotateDatabasePassword - requires the database to be RUNNING (the exec needs a
// live engine, and rotating a stopped redis would silently start it).
export async function rotateDatabasePassword(
  id: string,
  input: { password?: string } = {},
): Promise<string> {
  const teamId = (await requireCapability("configure_databases")).teamId;
  const user = (await getCurrentUser())!;

  const newPassword = input.password?.trim() || randomToken(24);
  assertPasswordSafe(newPassword);
  // The POLICY only bounds a password a person CHOSE.
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

    // Phase 1 - tell the engine (postgres/mysql/mariadb/mongodb).
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

    // Phase 2 - re-derive the connection string around the UNCHANGED host/port
    // and persist it, then reroute so the compose (env / redis command /
    // healthcheck) agrees with the engine again.
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
