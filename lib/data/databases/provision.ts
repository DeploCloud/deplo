import "server-only";

import { and, eq } from "drizzle-orm";

import { assertServerAccessibleTx } from "../servers/team-access";
import { getDb } from "../../db/client";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { pendingTeardowns as pendingTeardownsTable } from "../../db/schema/control-plane/deployments";
import { databaseToRow } from "../backup-rows";
import { getCurrentUser } from "../../auth/current-user";
import { newId, nowIso } from "../../ids";
import { requireCapability, canExposePorts } from "../../membership";
import { recordActivity } from "../activity";
import { dispatchAlert } from "../../notify/dispatch";
import { encryptSecret, randomToken } from "../../crypto";
import { connectAgent } from "../../infra/agent-client/connect";
import { buildConnectionString } from "../../deploy/database-compose";
import { assertNoNameClash, withNetworkLock } from "../name-clash";
import { environmentInTeam } from "../environments";
import {
  MIN_USER_PORT,
  MAX_PORT,
  isValidExposePort,
} from "../../databases/ports";
import { withKeyedLock } from "../keyed-mutex";
import { assertPasswordNotPwned } from "../../pwned-password";
import { assertPasswordPolicy } from "../../password-policy";
import { publishDatabaseChanged } from "../../graphql/pubsub";
import {
  DEFAULT_PORTS,
  assertPasswordSafe,
  cleanDatabaseName,
  databaseSlug,
  defaultUserFor,
  isValidImageRef,
  sanitizeDbIdentifier,
} from "./validate";
import { databaseExists, toDTO, type DatabaseDTO } from "./rows";
import { renderDatabaseStackYaml, rerouteRequest } from "./stack";
import { assertHostPortAvailable, resolveTeamServer } from "./server-ports";
import type { Database, DatabaseType } from "../../types/database";

export async function createDatabase(input: {
  name: string;
  type: DatabaseType;
  version: string;
  serverId?: string;
  environmentId?: string | null;
  username?: string;
  dbName?: string;
  password?: string;
  passwordIsGenerated?: boolean;
  exposedPublicly?: boolean;
  exposedPort?: number;
  customImage?: string | null;
}): Promise<DatabaseDTO> {
  const { membership } = await requireCapability("create_databases");
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  const name = cleanDatabaseName(input.name);
  const slug = databaseSlug(name);
  if (!/^[A-Za-z0-9._-]+$/.test(input.version))
    throw new Error("Version must be a valid image tag.");
  const customImage = input.customImage?.trim() || null;
  if (customImage && !isValidImageRef(customImage))
    throw new Error(
      "Custom image must be a plain image reference (repo[:tag] or repo@digest) with no spaces or quotes.",
    );
  if (input.password) {
    assertPasswordSafe(input.password);
    if (!input.passwordIsGenerated) {
      assertPasswordPolicy(input.password);
      await assertPasswordNotPwned(input.password);
    }
  }

  const exposed = input.exposedPublicly ?? false;
  if (exposed && !(await canExposePorts()))
    throw new Error("You don't have permission to publish ports");

  const server = await resolveTeamServer(teamId, input.serverId);

  const nameTaken = await getDb()
    .select({ id: databasesTable.id })
    .from(databasesTable)
    .where(
      and(eq(databasesTable.teamId, teamId), eq(databasesTable.name, name)),
    )
    .limit(1);
  if (nameTaken.length > 0)
    throw new Error(`A database named "${name}" already exists in this team.`);

  const slugCollision = await getDb()
    .select({ id: databasesTable.id })
    .from(databasesTable)
    .where(
      and(
        eq(databasesTable.serverId, server.id),
        eq(databasesTable.host, `db-${slug}`),
      ),
    )
    .limit(1);
  if (slugCollision.length > 0)
    throw new Error(
      `A database stack named "db-${slug}" already exists on ${server.name}. Database stacks share a per-host namespace - pick a different name.`,
    );
  const pending = await getDb()
    .select({ id: pendingTeardownsTable.id })
    .from(pendingTeardownsTable)
    .where(
      and(
        eq(pendingTeardownsTable.serverId, server.id),
        eq(pendingTeardownsTable.deployKey, `db-${slug}`),
      ),
    )
    .limit(1);
  if (pending.length > 0)
    throw new Error(
      `A database stack named "db-${slug}" is still being removed from ${server.name}. Pick a different name, or wait for that removal to finish.`,
    );

  let exposedPort: number | null = null;
  if (exposed) {
    if (input.exposedPort == null)
      throw new Error(
        "A host port is required to expose the database publicly",
      );
    if (!isValidExposePort(input.exposedPort))
      throw new Error(
        `Port ${input.exposedPort} is invalid - choose an unprivileged port (${MIN_USER_PORT}-${MAX_PORT})`,
      );
    await assertHostPortAvailable(server, input.exposedPort);
    exposedPort = input.exposedPort;
  }

  const port = DEFAULT_PORTS[input.type];
  const service = `db-${slug}`;

  const username =
    input.type === "redis"
      ? "default"
      : ((input.username ? sanitizeDbIdentifier(input.username) : null) ??
        defaultUserFor(input.type));
  const dbName =
    (input.dbName ? sanitizeDbIdentifier(input.dbName) : null) ?? service;
  const password =
    input.password && input.password.length > 0
      ? input.password
      : randomToken(12);

  const environmentId = input.environmentId
    ? ((await environmentInTeam(input.environmentId, teamId))?.id ??
      (() => {
        throw new Error("Environment not found");
      })())
    : null;

  const conn = buildConnectionString({
    type: input.type,
    username,
    password,
    host: exposedPort != null ? server.host : service,
    port: exposedPort != null ? exposedPort : port,
    dbName,
  });

  const db: Database = {
    id: newId("db"),
    teamId,
    environmentId,
    name,
    dataCopyError: "",
    migrationRunId: null,
    logo: null,
    type: input.type,
    version: input.version,
    username,
    dbName,
    status: "provisioning",
    serverId: server.id,
    host: service,
    port,
    connectionStringEnc: encryptSecret(conn),
    exposedPublicly: exposed,
    exposedPort,
    resources: null,
    customImage,
    customCommand: null,
    cronEnabled: false,
    mounts: [],
    sizeMb: 0,
    createdAt: nowIso(),
  };
  await withNetworkLock({ teamId, environmentId }, async () => {
    await assertNoNameClash({
      to: { teamId, environmentId, serverId: server.id },
      claims: [service],
      exceptId: "",
      subject: "the database",
    });
    await getDb().transaction(async (tx) => {
      await assertServerAccessibleTx(tx, server.id, teamId);
      await tx.insert(databasesTable).values(databaseToRow(db));
    });
  });
  await recordActivity(
    "database",
    `Created database ${name} (${input.type})`,
    user.name,
    null,
    teamId,
    null,
    db.id,
  );

  void provisionDatabase(db, password).catch(async (e: unknown) => {
    const why = e instanceof Error ? e.message : String(e);
    console.error(
      `[deplo] database ${name} (${db.id}) failed to provision: ${why}`,
    );
    await getDb()
      .update(databasesTable)
      .set({ status: "error" })
      .where(eq(databasesTable.id, db.id));
    publishDatabaseChanged(db.id);
    dispatchAlert({
      teamId,
      key: "database_failed",
      title: `Database ${name} could not be set up`,
      body: `It was created but never finished provisioning on its server: ${why}`,
      path: "/storage",
    });
  });

  return toDTO(db);
}

async function provisionDatabase(
  db: Database,
  password: string,
): Promise<void> {
  const yaml = renderDatabaseStackYaml(db, password);
  await withKeyedLock(db.id, async () => {
    if (!(await databaseExists(db.id))) return;
    const conn = await connectAgent(db.serverId);
    try {
      const res = await conn.reroute(rerouteRequest(db, yaml));
      if (!res.ok)
        throw new Error(res.error || "agent failed to provision the database");
    } finally {
      conn.close();
    }
    await getDb()
      .update(databasesTable)
      .set({ status: "running" })
      .where(eq(databasesTable.id, db.id));
    publishDatabaseChanged(db.id);
    dispatchAlert({
      teamId: db.teamId,
      key: "database_ready",
      title: `Database ${db.name} is ready`,
      body: "It finished setting up and is accepting connections.",
      path: "/storage",
    });
  });
}
