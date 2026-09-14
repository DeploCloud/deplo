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
  // Omitted / `true` → available to all teams. `false` → restrict to `teamIds`.
  allTeams?: boolean;
  // A server that only HOLDS backups: agent installed, no Docker, no deploys.
  storageOnly?: boolean;
  // A server that only BUILDS: Docker installed, no Traefik, nothing deployed.
  buildOnly?: boolean;
  // Registered only to IMPORT from another platform - the import wizard's flag.
  importOnly?: boolean;
  teamIds?: string[];
}

// What addServer returns: the new row plus the one-time install command.
export interface AddServerResult {
  server: Server;
  // Shown ONCE (it embeds the single-use bootstrap token); the control plane
  // stores only the token's hash. The UI must surface this immediately.
  installCommand: string;
}

// Where the agent this command installs will call home to. On THIS host that is
// loopback and has to be: the panel is published on 127.0.0.1 only, and during a
// takeover so is its proxy, so its public address answers nothing.
async function bootstrapBaseUrl(server: {
  ip?: string;
  host?: string;
}): Promise<string> {
  if (!isDeploHostServer(server)) return instancePublicBaseUrl();
  const port = Number(process.env.DEPLO_PANEL_PORT?.trim());
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : 3000}`;
}

// addServer registers a remote server. No SSH-in: the control plane never holds
// the server's root credential.
export async function addServer(
  input: AddServerInput,
): Promise<AddServerResult> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const host = input.host.trim();

  const { rawToken, stored } = mintBootstrap();
  const baseUrl = await bootstrapBaseUrl({ ip: host, host });
  // Best-effort: read the control plane's own TLS fingerprint to pin in the
  // command. Empty over plain HTTP - the agent then uses the HMAC path.
  const { fingerprint, insecure } = await controlPlaneCert(baseUrl);

  const importOnly = input.importOnly ?? false;
  if (importOnly) {
    const reached = await existingImportSource(host);
    // A machine Deplo already reaches needs no second row. A fleet server at that
    // address is not this wizard's to touch; a migration source is.
    if (reached && !reached.importOnly)
      return { server: reached, installCommand: "" };
    if (reached) {
      await claimImportSource(reached, teamId);
      // A ROW is not a running agent: one that answered once and has since been
      // taken off keeps its fingerprint, and reading that as "connected" walked
      // the wizard past Install onto a machine Deplo cannot read.
      return reached.agent && (await sourceAgentReachable(reached.id))
        ? { server: reached, installCommand: "" }
        : reissueBootstrap(reached.id);
    }
  }

  // Default to instance-wide. Another team seeing it in its own Servers list would be
  // a leak of who is migrating what from where.
  const allTeams = importOnly ? false : (input.allTeams ?? true);
  const teamIds = importOnly
    ? [teamId]
    : allTeams
      ? []
      : [...new Set(input.teamIds ?? [])];

  const server: Server = {
    id: newId("srv"),
    // Truncate rather than refuse: a migration source is named from the run, and
    // an over-long name is not worth failing an install over.
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
    // Exclusive by CHECK constraint too, but decided here so a client that sends
    // both gets the safer of the two: storage-only skips Docker, and a host with
    // no Docker cannot build.
    storageOnly: !importOnly && (input.storageOnly ?? false),
    buildOnly: !importOnly && !input.storageOnly && (input.buildOnly ?? false),
    // Automatic: the Deplo host builds as a fallback, a new remote does not.
    buildFallback: null,
    importOnly,
    // A migration source earns its uninstall when its migration finishes.
    uninstallPending: false,
    uninstallError: "",
    // Unknown until the agent says Hello, like dockerVersion above it.
    hostArch: "",
    // Born strict: one deploy at a time on this host until an admin raises it.
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

// The server Deplo already has at a MIGRATION SOURCE's address: a second row for
// the same machine strands the first, and "migration complete" would then
// uninstall the wrong agent.
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

// The machine is being read again: grant it to the team reading it and forget what
// the last walk left on the row. Refused while another team's migration is still
// running - those disks are being copied right now.
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

// ensureDeploHostServer registers the machine Deplo itself runs on - "agent 0" -
// so a fresh install has somewhere to deploy to WITHOUT anyone opening a shell.
// Everything it needs is environment written by the installer, never client input.
export async function ensureDeploHostServer(): Promise<void> {
  const rawToken = process.env.DEPLO_HOST_BOOTSTRAP_TOKEN?.trim();
  if (!rawToken) return;
  // The address the control plane will DIAL, taken from the installer's own
  // detection rather than a NIC here (a container sees docker's bridge), and the
  // agent's cert SANs are pinned to whatever this row declares.
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
    // The host's own hostname, passed in by the installer - `os.hostname()` here
    // would answer with the container's random id.
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
    // Instance-wide: it is the only server a new install has, so restricting it
    // to whichever team happens to be created first would strand every other one.
    allTeams: true,
    storageOnly: false,
    buildOnly: false,
    buildFallback: null,
    importOnly: false,
    uninstallPending: false,
    uninstallError: "",
    hostArch: "",
    deployConcurrency: 1,
    createdAt: nowIso(),
    bootstrap: stored,
  };
  await getDb().insert(serversTable).values(serverToRow(server));
}

// reissueBootstrap re-mints a fresh bootstrap token + install command for a
// server, whether it is still `provisioning` or already provisioned and online.
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
      // A trusted server (one with a pinned agent cert) stays online/offline - a
      // re-copy must not knock it back to "provisioning".
      ...(server.agent ? {} : { status: "provisioning" as const }),
    })
    .where(eq(serversTable.id, id));
  const fresh = (await getServerById(id))!;
  // Re-minting a single-use bootstrap token arms a ~1h re-pin window, and for an
  // already-trusted server that window can silently replace its agent cert.
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
      // The role has to ride along or the re-copied command installs a DIFFERENT
      // host: a migration source's second install would put Traefik and the
      // shared network on another platform's box.
      importOnly: fresh.importOnly,
    }),
  };
}
