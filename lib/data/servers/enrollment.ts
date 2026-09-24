import "server-only";

import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { migrationRuns as runsTable } from "../../db/schema/control-plane/migration";
import {
  serverTeams as serverTeamsTable,
  servers as serversTable,
} from "../../db/schema/control-plane/servers";
import { serverToRow } from "../infra-rows";
import { sourceAgentReachable } from "../agent-reach";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
} from "../../deploy/domains";
import { getCurrentUser } from "../../auth/current-user";
import { requireActiveTeamId, requireInstanceAdmin } from "../../membership";
import { newId, nowIso } from "../../ids";
import { instancePublicBaseUrl } from "../instance-settings/settings-store";
import { recordActivity } from "../activity";
import {
  mintBootstrap,
  storedBootstrapFor,
  installCommand,
  controlPlaneCert,
} from "../../agent/bootstrap";
import { listAllServers, getServerById, requireAdminServer } from "./roster";
import { cleanServerName, SERVER_NAME_MAX } from "./settings";
import type { Server } from "../../types/server";

export interface AddServerInput {
  name: string;
  host: string;
  allTeams?: boolean;
  storageOnly?: boolean;
  buildOnly?: boolean;
  importOnly?: boolean;
  teamIds?: string[];
}

export interface AddServerResult {
  server: Server;
  installCommand: string;
}

async function bootstrapBaseUrl(server: {
  ip?: string;
  host?: string;
}): Promise<string> {
  if (!isDeploHostServer(server)) return instancePublicBaseUrl();
  const port = Number(process.env.DEPLO_PANEL_PORT?.trim());
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : 3000}`;
}

export async function addServer(
  input: AddServerInput,
): Promise<AddServerResult> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const host = input.host.trim();

  const { rawToken, stored } = mintBootstrap();
  const baseUrl = await bootstrapBaseUrl({ ip: host, host });
  const { fingerprint, insecure } = await controlPlaneCert(baseUrl);

  const importOnly = input.importOnly ?? false;
  if (importOnly) {
    const reached = await existingImportSource(host);
    if (reached && !reached.importOnly)
      return { server: reached, installCommand: "" };
    if (reached) {
      await claimImportSource(reached, teamId);
      return reached.agent && (await sourceAgentReachable(reached.id))
        ? { server: reached, installCommand: "" }
        : reissueBootstrap(reached.id);
    }
  }

  const allTeams = importOnly ? false : (input.allTeams ?? true);
  const teamIds = importOnly
    ? [teamId]
    : allTeams
      ? []
      : [...new Set(input.teamIds ?? [])];

  const server: Server = {
    id: newId("srv"),
    name: cleanServerName(
      (input.name.trim() || host).slice(0, SERVER_NAME_MAX),
    ),
    host,
    type: "remote",
    status: "provisioning",
    ip: host,
    dockerVersion: "",
    traefikEnabled: false,
    cpuCores: 0,
    memoryMb: 0,
    diskGb: 0,
    allTeams,
    storageOnly: !importOnly && (input.storageOnly ?? false),
    buildOnly: !importOnly && !input.storageOnly && (input.buildOnly ?? false),
    buildFallback: null,
    importOnly,
    uninstallPending: false,
    uninstallError: "",
    hostArch: "",
    deployConcurrency: 1,
    agentCanary: false,
    createdAt: nowIso(),
    bootstrap: stored,
  };
  await getDb().transaction(async (tx) => {
    await tx.insert(serversTable).values(serverToRow(server));
    if (teamIds.length > 0)
      await tx
        .insert(serverTeamsTable)
        .values(teamIds.map((teamId) => ({ serverId: server.id, teamId })));
  });
  await recordActivity(
    "server",
    `Connected server ${server.name}`,
    user.name,
    null,
    teamId,
  );

  return {
    server,
    installCommand: installCommand({
      baseUrl,
      rawToken,
      fingerprint,
      insecure,
      storageOnly: server.storageOnly,
      buildOnly: server.buildOnly,
      importOnly: server.importOnly,
    }),
  };
}

async function existingImportSource(host: string): Promise<Server | null> {
  const self = deploHostSelfAddresses();
  if (isDeploHostServer({ ip: host, host }, self))
    throw new Error(
      "That address is the machine Deplo itself runs on. A migration source is " +
        "the other platform's host, and the agent here is already installed.",
    );
  const a = host.trim().toLowerCase();
  return (
    (await listAllServers()).find(
      (s) =>
        s.ip?.trim().toLowerCase() === a || s.host?.trim().toLowerCase() === a,
    ) ?? null
  );
}

async function claimImportSource(
  source: Server,
  teamId: string,
): Promise<void> {
  const [held] = await getDb()
    .select({ teamId: serverTeamsTable.teamId })
    .from(serverTeamsTable)
    .where(eq(serverTeamsTable.serverId, source.id))
    .limit(1);
  if (!held)
    await getDb()
      .insert(serverTeamsTable)
      .values({ serverId: source.id, teamId })
      .onConflictDoNothing();
  else if (held.teamId !== teamId) {
    const live = await getDb()
      .select({ id: runsTable.id })
      .from(runsTable)
      .where(
        and(eq(runsTable.teamId, held.teamId), eq(runsTable.status, "running")),
      )
      .limit(1);
    if (live.length > 0)
      throw new Error(
        `${source.name} is being read by a migration in another team.`,
      );
    await getDb()
      .update(serverTeamsTable)
      .set({ teamId })
      .where(
        and(
          eq(serverTeamsTable.serverId, source.id),
          eq(serverTeamsTable.teamId, held.teamId),
        ),
      );
  }
  await getDb()
    .update(serversTable)
    .set({
      uninstallNextAt: null,
      uninstallRunId: null,
      uninstallAttempts: 0,
      uninstallError: "",
    })
    .where(eq(serversTable.id, source.id));
}

export async function ensureDeploHostServer(): Promise<void> {
  const rawToken = process.env.DEPLO_HOST_BOOTSTRAP_TOKEN?.trim();
  if (!rawToken) return;
  const ip = process.env.DEPLO_SERVER_IP?.trim();
  if (!ip) return;

  const self = deploHostSelfAddresses();
  const existing = (await listAllServers()).find((s) =>
    isDeploHostServer(s, self),
  );
  const stored = storedBootstrapFor(rawToken);

  if (existing) {
    if (existing.agent || existing.status !== "provisioning") return;
    await getDb()
      .update(serversTable)
      .set({
        bootstrapTokenHash: stored.tokenHash,
        bootstrapExpiresAt: stored.expiresAt,
        bootstrapUsedAt: stored.usedAt,
      })
      .where(eq(serversTable.id, existing.id));
    return;
  }

  const server: Server = {
    id: newId("srv"),
    name: process.env.DEPLO_HOST_NAME?.trim() || ip,
    host: ip,
    type: "remote",
    status: "provisioning",
    ip,
    dockerVersion: "",
    traefikEnabled: false,
    cpuCores: 0,
    memoryMb: 0,
    diskGb: 0,
    allTeams: true,
    storageOnly: false,
    buildOnly: false,
    buildFallback: null,
    importOnly: false,
    uninstallPending: false,
    uninstallError: "",
    hostArch: "",
    deployConcurrency: 1,
    agentCanary: false,
    createdAt: nowIso(),
    bootstrap: stored,
  };
  await getDb().insert(serversTable).values(serverToRow(server));
}

export async function reissueBootstrap(id: string): Promise<AddServerResult> {
  const { teamId, user, server } = await requireAdminServer(id);

  const { rawToken, stored } = mintBootstrap();
  const baseUrl = await bootstrapBaseUrl(server);
  const { fingerprint, insecure } = await controlPlaneCert(baseUrl);
  await getDb()
    .update(serversTable)
    .set({
      bootstrapTokenHash: stored.tokenHash,
      bootstrapExpiresAt: stored.expiresAt,
      bootstrapUsedAt: stored.usedAt,
      ...(server.agent ? {} : { status: "provisioning" as const }),
    })
    .where(eq(serversTable.id, id));
  const fresh = (await getServerById(id))!;
  await recordActivity(
    "server",
    `Reissued install command for server ${server.name}`,
    user.name,
    null,
    teamId,
  );
  return {
    server: fresh,
    installCommand: installCommand({
      baseUrl,
      rawToken,
      fingerprint,
      insecure,
      storageOnly: fresh.storageOnly,
      buildOnly: fresh.buildOnly,
      importOnly: fresh.importOnly,
    }),
  };
}
