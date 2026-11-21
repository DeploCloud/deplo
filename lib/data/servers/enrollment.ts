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
import { isDeploHostServer, isThisMachineAddress } from "../../deploy/domains";
import { getCurrentUser } from "../../auth/current-user";
import { requireActiveTeamId, requireInstanceAdmin } from "../../membership";
import { newId, nowIso } from "../../ids";
import { bootstrapBaseUrl } from "./panel-address";
import { recordActivity } from "../activity";
import {
  mintBootstrap,
  storedBootstrapFor,
  installCommand,
  controlPlaneCert,
} from "../../agent/bootstrap";
import { listAllServers, getServerById, requireAdminServer } from "./roster";
import { cleanServerName, SERVER_NAME_MAX } from "./settings";
import { markDeploHost } from "./agent-identity";
import {
  canonicalHost,
  HOST_ADDRESS_ERROR,
  parseHostAddress,
} from "../../host-address";
import type { Server } from "../../types/server";
import {
  assertJoinableCluster,
  requestClusterJoin,
} from "../clusters/join-requests";

export interface AddServerInput {
  name: string;
  /** A migration source's machine; for any other server only where its Apps answer (ADR-0050). */
  host?: string;
  allTeams?: boolean;
  storageOnly?: boolean;
  buildOnly?: boolean;
  importOnly?: boolean;
  teamIds?: string[];
  /** Join this cluster once installed. */
  clusterId?: string;
}

export interface AddServerResult {
  server: Server;
  installCommand: string;
}

export async function addServer(
  input: AddServerInput,
): Promise<AddServerResult> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const importOnly = input.importOnly ?? false;
  let host = "";
  if (importOnly || input.host?.trim()) {
    const parsed = parseHostAddress(input.host);
    if (!parsed) throw new Error(HOST_ADDRESS_ERROR);
    host = parsed.host;
  }

  const { rawToken, stored } = mintBootstrap();
  // A server Deplo adds is never the machine it runs on: the installer enrolled that one.
  const baseUrl = await bootstrapBaseUrl({});
  const { fingerprint, insecure, pin } = await controlPlaneCert(baseUrl);

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

  if (input.clusterId) {
    if (importOnly)
      throw new Error("A migration source cannot join a cluster.");
    await assertJoinableCluster(input.clusterId);
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
      (input.name.trim() || host || "server").slice(0, SERVER_NAME_MAX),
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
    generatedAddressFamily: null,
    importOnly,
    uninstallPending: false,
    uninstallError: "",
    hostArch: "",
    deployConcurrency: 1,
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
  if (input.clusterId) await requestClusterJoin(server.id, input.clusterId);
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
      pin,
      storageOnly: server.storageOnly,
      buildOnly: server.buildOnly,
      importOnly: server.importOnly,
    }),
  };
}

async function existingImportSource(host: string): Promise<Server | null> {
  if (isThisMachineAddress(host))
    throw new Error(
      "That address is the machine Deplo itself runs on. A migration source is " +
        "the other platform's host, and the agent here is already installed.",
    );
  return (await listAllServers()).find((s) => serverAt(s, host)) ?? null;
}

function serverAt(s: Server, host: string): boolean {
  const a = canonicalHost(host);
  return canonicalHost(s.ip) === a || canonicalHost(s.host) === a;
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
  const stored = rawToken ? storedBootstrapFor(rawToken) : null;
  const all = await listAllServers();
  // The server the installer's own token enrolled is the machine Deplo runs on (ADR-0050).
  const byToken = stored
    ? all.find((s) => s.bootstrap?.tokenHash === stored.tokenHash)
    : undefined;
  let existing = all.find((s) => isDeploHostServer(s)) ?? byToken;
  // An install from before the mark: recognised by its address this once, by the mark ever after.
  existing ??= all.find(
    (s) =>
      !s.importOnly &&
      (isThisMachineAddress(s.ip) || isThisMachineAddress(s.host)),
  );
  if (existing && !existing.deploHost) await markDeploHost(existing.id);
  const raw = process.env.DEPLO_SERVER_IP?.trim();
  if (!stored || !raw) return;
  const ip = parseHostAddress(raw)?.host ?? raw;

  // The installer moved this machine to an address its row is not at (its IPv4 went away): the address follows.
  if (
    existing &&
    existing.id === byToken?.id &&
    !isThisMachineAddress(existing.ip) &&
    !isThisMachineAddress(existing.host)
  ) {
    await getDb()
      .update(serversTable)
      .set({ ip, host: ip })
      .where(eq(serversTable.id, existing.id));
    return;
  }

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
    generatedAddressFamily: null,
    importOnly: false,
    uninstallPending: false,
    uninstallError: "",
    hostArch: "",
    deployConcurrency: 1,
    createdAt: nowIso(),
    bootstrap: stored,
    deploHost: true,
  };
  await getDb().insert(serversTable).values(serverToRow(server));
}

export async function reissueBootstrap(id: string): Promise<AddServerResult> {
  const { teamId, user, server } = await requireAdminServer(id);

  const { rawToken, stored } = mintBootstrap();
  const baseUrl = await bootstrapBaseUrl(server);
  const { fingerprint, insecure, pin } = await controlPlaneCert(baseUrl);
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
      pin,
      // The same server again: the installer replaces its agent rather than stopping at it.
      reinstall: true,
      storageOnly: fresh.storageOnly,
      buildOnly: fresh.buildOnly,
      importOnly: fresh.importOnly,
    }),
  };
}
