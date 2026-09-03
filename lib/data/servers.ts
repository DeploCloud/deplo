import "server-only";

import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb, type DrizzleClient, type DbTx } from "../db/client";
import {
  databases as databasesTable,
  backupDestination as destinationTable,
  apps as appsTable,
  serverTeams as serverTeamsTable,
  servers as serversTable,
  teams as teamsTable,
} from "../db/schema/control-plane";
import { assembleServer, serverToRow } from "./infra-rows";
import { appCapabilities } from "./node-access";
import {
  deploHostSelfAddresses,
  isBuildFallbackServer,
  isDeploHostServer,
  resolveServerIp,
} from "../deploy/domains";
import { getCurrentUser } from "../auth";
import {
  reachesWholeTeam,
  requireActiveTeamId,
  requireInstanceAdmin,
  requireTeamWide,
} from "../membership";
import { narrowedScope } from "../auth/request-context";
import { newId, nowIso } from "../ids";
import { instancePublicBaseUrl } from "./instance-settings";
import { recordActivity } from "./activity";
import { teamAvatarUrl } from "../avatar";
import { pendingTeardownsForServer } from "./teardown-queue";
import {
  mintBootstrap,
  storedBootstrapFor,
  installCommand,
  uninstallCommand,
  controlPlaneCert,
  findServerForToken,
  signBootstrapCsr,
  DEFAULT_AGENT_PORT,
} from "../agent/bootstrap";
import type { Server, Team } from "../types";

/**
 * `servers` is RELATIONAL as of cut-set (e) (relational-store PLAN Step 6).
 */

/**
 * All servers by creation order (internal; NO auth gate).
 */
export async function listAllServers(): Promise<Server[]> {
  const rows = await getDb()
    .select()
    .from(serversTable)
    .orderBy(asc(serversTable.createdAt));
  return rows.map(assembleServer);
}

/** One server by id (internal; no auth gate). Null when unknown. */
export async function getServerById(id: string): Promise<Server | null> {
  const rows = await getDb()
    .select()
    .from(serversTable)
    .where(eq(serversTable.id, id))
    .limit(1);
  return rows[0] ? assembleServer(rows[0]) : null;
}

/**
 * The public, TEAM-SCOPED server read: a viewer sees only the servers their active
 * team may target (every `all_teams` server + the ones granted to it).
 */
export async function listServers(): Promise<Server[]> {
  return listServersForCurrentTeam();
}

export async function getServer(id: string): Promise<Server | null> {
  // A point lookup answers NOT FOUND rather than "your token is limited", so a
  // narrowed scope can never become an oracle for which server ids exist.
  if (narrowedScope()) return null;
  if (!(await reachesWholeTeam())) return null;
  const teamId = await requireActiveTeamId();
  const server = await getServerById(id);
  if (!server) return null;
  if (server.allTeams) return server;
  const granted = await getDb()
    .select({ teamId: serverTeamsTable.teamId })
    .from(serverTeamsTable)
    .where(
      and(
        eq(serverTeamsTable.serverId, id),
        eq(serverTeamsTable.teamId, teamId),
      ),
    )
    .limit(1);
  return granted.length > 0 ? server : null;
}

/**
 * The "primary" server, the first one added, or null when none exists yet
 * (e.g. straight after first-run setup, before the operator has added any host).
 * Callers must tolerate null and prompt the operator to add a server.
 */
export async function getPrimaryServer(): Promise<Server | null> {
  // Team-scoped: the first server the active team can target (was: the first server
  // overall, which leaked existence of an other-team-only server), and filtered by
  // role: "primary" means the default place to PUT something, so a
  // storage/build/import host answering it hands callers a target that refuses the
  // very thing they were about to do.
  const servers = await listServersForCurrentTeam();
  return servers.filter(canHostWorkloads)[0] ?? null;
}

/**
 * Servers a given team may target for its apps/databases: every `all_teams` server
 * PLUS the ones explicitly granted to this team via `server_teams`. Creation
 * order, like the unfiltered list.
 */
export async function listServersForTeam(teamId: string): Promise<Server[]> {
  const db = getDb();
  const grantedToTeam = db
    .select({ id: serverTeamsTable.serverId })
    .from(serverTeamsTable)
    .where(eq(serverTeamsTable.teamId, teamId));
  const rows = await db
    .select()
    .from(serversTable)
    .where(
      or(
        eq(serversTable.allTeams, true),
        inArray(serversTable.id, grantedToTeam),
      ),
    )
    .orderBy(asc(serversTable.createdAt));
  return rows.map(assembleServer);
}

/**
 * {@link listServersForTeam} for the caller's active team (asserts membership).
 */
export async function listServersForCurrentTeam(): Promise<Server[]> {
  await requireTeamWide("servers");
  const teamId = await requireActiveTeamId();
  return listServersForTeam(teamId);
}

/**
 * The server PICKER: id, name and type, and nothing else. A member limited to one
 * project who could create an app but never choose a host would hold a capability
 * that does nothing, which is the opposite of what limiting a role is for.
 */
export async function listServerChoices(): Promise<
  { id: string; name: string; type: Server["type"]; isDeploHost: boolean }[]
> {
  const teamId = await requireActiveTeamId();
  // Resolved once for the whole list: it walks the NICs.
  const self = deploHostSelfAddresses();
  return (await listServersForTeam(teamId))
    .filter(canHostWorkloads)
    .map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      isDeploHost: isDeploHostServer(s, self),
    }));
}

/**
 * Whether a server may RUN a workload - the one predicate behind every deploy
 * target picker, and behind the server-side re-checks in `createApp` and the
 * database resolver that back them up.
 */
export function canHostWorkloads(s: Server): boolean {
  return !s.storageOnly && !s.buildOnly && !s.importOnly;
}

/**
 * Refuse an action that treats a MIGRATION SOURCE as one of our servers.
 */
export function assertNotMigrationSource(
  s: Pick<Server, "name" | "importOnly">,
): void {
  if (s.importOnly)
    throw new Error(
      `${s.name} is a migration source - Deplo only reads from it, it does not run it.`,
    );
}

/**
 * The BUILD SERVER picker: the hosts that can compile for another machine.
 */
export async function listBuildServerChoices(): Promise<
  {
    id: string;
    name: string;
    hostArch: string;
    buildOnly: boolean;
    buildFallback: boolean;
    isDeploHost: boolean;
  }[]
> {
  const teamId = await requireActiveTeamId();
  const self = deploHostSelfAddresses();
  return (await listServersForTeam(teamId))
    .filter((s) => !s.storageOnly && !s.importOnly)
    .map((s) => ({
      id: s.id,
      name: s.name,
      hostArch: s.hostArch,
      buildOnly: s.buildOnly,
      buildFallback: isBuildFallbackServer(s, self),
      isDeploHost: isDeploHostServer(s, self),
    }));
}

/**
 * The public address of the host ONE app runs on - the value a custom domain's A
 * record has to point at.
 */
export async function serverIpForApp(appId: string): Promise<string> {
  const reach = await appCapabilities(appId);
  if (reach.length === 0) return resolveServerIp(undefined);
  const rows = await getDb()
    .select({ ip: serversTable.ip, host: serversTable.host })
    .from(appsTable)
    .innerJoin(serversTable, eq(serversTable.id, appsTable.serverId))
    .where(eq(appsTable.id, appId))
    .limit(1);
  // `resolveServerIp` already has the fallback for a host with no address
  // recorded, so this returns the same shape the fleet read did.
  return resolveServerIp({ ip: rows[0]?.ip ?? undefined });
}

/** The team ids a non-`all_teams` server is restricted to (empty for an unscoped one). */
export async function getServerTeamIds(serverId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ teamId: serverTeamsTable.teamId })
    .from(serverTeamsTable)
    .where(eq(serverTeamsTable.serverId, serverId));
  return rows.map((r) => r.teamId);
}

/** The teams a server is granted to, with names - for the access editor + badges. */
export async function getServerTeams(serverId: string): Promise<Team[]> {
  const rows = await getDb()
    .select({
      id: teamsTable.id,
      name: teamsTable.name,
      slug: teamsTable.slug,
      plan: teamsTable.plan,
      image: teamsTable.image,
      createdAt: teamsTable.createdAt,
    })
    .from(serverTeamsTable)
    .innerJoin(teamsTable, eq(teamsTable.id, serverTeamsTable.teamId))
    .where(eq(serverTeamsTable.serverId, serverId))
    .orderBy(asc(teamsTable.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    plan: r.plan as Team["plan"],
    avatarUrl: teamAvatarUrl(r.image),
    createdAt: r.createdAt,
  }));
}

/** Every server's granted team ids in one query (serverId → teamIds), for the page. */
export async function listAllServerTeamIds(): Promise<Map<string, string[]>> {
  const rows = await getDb()
    .select({
      serverId: serverTeamsTable.serverId,
      teamId: serverTeamsTable.teamId,
    })
    .from(serverTeamsTable);
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.serverId);
    if (list) list.push(r.teamId);
    else map.set(r.serverId, [r.teamId]);
  }
  return map;
}

export interface AddServerInput {
  name: string;
  host: string;
  /**
   * Team access at registration. Omitted / `true` → available to all teams.
   * `false` → restrict to `teamIds` (the install dialog's "Specific teams").
   */
  allTeams?: boolean;
  /** A server that only HOLDS backups: agent installed, no Docker, no deploys. */
  storageOnly?: boolean;
  /** A server that only BUILDS: Docker installed, no Traefik, nothing deployed. */
  buildOnly?: boolean;
  /**
   * A server registered only to IMPORT from another platform. Set by the import
   * wizard, never by the Add server dialog.
   */
  importOnly?: boolean;
  teamIds?: string[];
}

/** What addServer returns: the new row plus the one-time install command (P1). */
export interface AddServerResult {
  server: Server;
  /**
   * The paste-on-the-server command the operator runs to provision the agent.
   * Shown ONCE (it embeds the single-use bootstrap token); the control plane
   * stores only the token's hash. The UI must surface this immediately.
   */
  installCommand: string;
}

/**
 * Where the agent this command installs will call home to.
 *
 * On THIS host that is loopback, and it has to be: the panel is published on
 * 127.0.0.1 only, and during a takeover so is its proxy - so its public address
 * answers nothing and no certificate can be read for it. That refused every
 * install command at the one moment recovering from the panel was the only way
 * out. The installer bootstraps agent 0 over exactly this address.
 */
async function bootstrapBaseUrl(server: {
  ip?: string;
  host?: string;
}): Promise<string> {
  if (!isDeploHostServer(server)) return instancePublicBaseUrl();
  const port = Number(process.env.DEPLO_PANEL_PORT?.trim());
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : 3000}`;
}

/**
 * Register a remote server (PLAN Part B, P1). No SSH-in: the control plane never
 * holds the server's root credential.
 */
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
  // command (P3). Empty over plain HTTP - the agent then uses the HMAC path.
  const { fingerprint, insecure } = await controlPlaneCert(baseUrl);

  const importOnly = input.importOnly ?? false;
  if (importOnly) await assertImportHostIsNew(host);

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
    name: input.name.trim() || host,
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
    // both gets the safer of the two rather than a database error: storage-only is
    // the one that skips Docker, and a host with no Docker cannot build.
    storageOnly: !importOnly && (input.storageOnly ?? false),
    buildOnly: !importOnly && !input.storageOnly && (input.buildOnly ?? false),
    // Automatic: the Deplo host builds as a fallback, a new remote does not.
    buildFallback: null,
    importOnly,
    // Nothing is being taken off anything yet: a migration source earns its
    // uninstall when its migration finishes.
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

/**
 * Refuse to register a MIGRATION SOURCE that is a machine Deplo already stands on.
 * "Migration complete" would uninstall it.
 */
async function assertImportHostIsNew(host: string): Promise<void> {
  const self = deploHostSelfAddresses();
  if (isDeploHostServer({ ip: host, host }, self))
    throw new Error(
      "That address is the machine Deplo itself runs on. A migration source is " +
        "the other platform's host, and the agent here is already installed.",
    );
  const a = host.trim().toLowerCase();
  const clash = (await listAllServers()).find(
    (s) =>
      s.ip?.trim().toLowerCase() === a || s.host?.trim().toLowerCase() === a,
  );
  if (clash)
    throw new Error(
      `${clash.name} is already registered at that address. Deplo can import ` +
        "from a machine it already reaches - no second server is needed.",
    );
}

/**
 * Register the machine Deplo itself runs on as a server - "agent 0" - so a fresh
 * install has somewhere to deploy to WITHOUT anyone opening a shell. Everything it
 * needs is environment written by the installer, never client input.
 */
export async function ensureDeploHostServer(): Promise<void> {
  const rawToken = process.env.DEPLO_HOST_BOOTSTRAP_TOKEN?.trim();
  if (!rawToken) return;
  // The address the control plane will DIAL, which is why it is taken from the
  // installer's own detection rather than guessed from a NIC here: a container sees
  // docker's bridge addresses, and the agent's cert SANs are pinned to whatever this
  // row declares (completeBootstrap never trusts a self-reported one).
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
    // would answer with the container's random id. Falls back to the address,
    // which at least says where it is.
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

/**
 * Re-mint a fresh bootstrap token + install command for a server - whether it is
 * still `provisioning` (the original token expired or the operator lost it) OR
 * already provisioned and online (the operator wants the install command back to
 * copy it again, e.g. to reinstall or repair the agent on the box).
 */
export async function reissueBootstrap(id: string): Promise<AddServerResult> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");

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
      // re-copy must not knock it back to "provisioning". Only a server still
      // awaiting its first call-home gets (re)marked provisioning.
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
      // host: without it a migration source's second install would put Traefik and
      // the shared network on another platform's box.
      importOnly: fresh.importOnly,
    }),
  };
}

/** What {@link removeServer} hands back to the operator. */
export interface ServerRemoval {
  /**
   * The paste-on-the-server command that actually uninstalls the agent. ALWAYS
   * returned - removal never cleans the host, so the operator always needs it.
   */
  uninstallCommand: string;
  /** A non-blocking hazard the operator must know about, or null. */
  warning: string | null;
}

/**
 * The instance's public base URL: the address an admin set in Settings → Deplo,
 * otherwise DEPLO_PUBLIC_URL, otherwise the request's own host.
 */
async function publicBaseUrl(): Promise<string> {
  return instancePublicBaseUrl();
}

/** The uninstall one-liner, with `-k` when the panel's certificate needs it. */
async function hostUninstallCommand(): Promise<string> {
  const baseUrl = await publicBaseUrl();
  const { insecure } = await controlPlaneCert(baseUrl);
  return uninstallCommand({ baseUrl, insecure });
}

/**
 * The paste-on-the-host command that takes Deplo's agent back off a machine.
 * Exists because the row that needs it is exactly the row Deplo cannot act on: an
 * unreachable host's agent can only be removed from the host.
 */
export async function agentUninstallCommand(): Promise<string> {
  await requireActiveTeamId();
  return hostUninstallCommand();
}

/** Format a blocked-by list for an error message: at most `max` names, then a count. */
function nameList(names: string[], max = 5): string {
  const shown = names.slice(0, max).join(", ");
  const rest = names.length - max;
  return rest > 0 ? `${shown} …and ${rest} more` : shown;
}

/**
 * Refuse when the host still RUNS something, BEFORE anything is touched. Both
 * tables' `server_id` FKs are RESTRICT, so a removal would fail anyway - but as a
 * raw Postgres foreign-key error, which tells the operator nothing.
 */
async function assertNoWorkloads(id: string): Promise<void> {
  const [apps, dbs] = await Promise.all([
    getDb()
      .select({ slug: appsTable.slug })
      .from(appsTable)
      .where(eq(appsTable.serverId, id)),
    getDb()
      .select({ name: databasesTable.name })
      .from(databasesTable)
      .where(eq(databasesTable.serverId, id)),
  ]);
  if (apps.length > 0)
    throw new Error(
      `Move or delete the apps on this server first, still assigned: ` +
        `${nameList(apps.map((a) => a.slug))}`,
    );
  if (dbs.length > 0)
    throw new Error(
      `Move or delete the databases on this server first, still hosted here: ` +
        `${nameList(dbs.map((d) => d.name))}`,
    );
}

/**
 * Everything {@link assertNoWorkloads} refuses, plus the backup destinations kept
 * on this host. It runs before the trust revoke, so a blocked removal has no side
 * effects at all.
 */
async function assertServerRemovable(id: string): Promise<void> {
  await assertNoWorkloads(id);
  const destinations = await getDb()
    .select({ name: destinationTable.name, teamId: destinationTable.teamId })
    .from(destinationTable)
    .where(eq(destinationTable.serverId, id));
  if (destinations.length > 0)
    throw new Error(
      `Remove the backup destinations kept on this server first, still pointing ` +
        `here: ${nameList(destinations.map((d) => d.name))}. Each one belongs to a ` +
        `team, whose members remove it from Storage → Destinations.`,
    );
}

/**
 * Remove a server. (b) Revoke trust, drop the pinned agent cert, so even a box
 * we can no longer reach never keeps a valid badge. Persisted before the delete,
 * so a crash in between still leaves trust dead. A sweep here would be theatre.
 */
export async function removeServer(id: string): Promise<ServerRemoval> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  return removeServerRow(id, user.name, teamId);
}

/**
 * The removal itself, with NO gate of its own - everything {@link removeServer}
 * does once it knows the caller is allowed to.
 */
async function removeServerRow(
  id: string,
  actorName: string,
  teamId: string,
): Promise<ServerRemoval> {
  const user = { name: actorName };
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");

  // (0) The host running Deplo itself is NOT removable, by anyone, ever.
  if (isDeploHostServer(server))
    throw new Error(
      `${server.name} is the host running Deplo itself - it can't be removed, ` +
        `because doing so would cut this dashboard off from its own server.`,
    );

  // (a) Block on live workloads - before any side effect.
  await assertServerRemovable(id);

  // An App mid-move OFF this server is NOT a blocker (the source host may be the very
  // thing that died, which would deadlock the removal), but it is a data hazard we
  // must not let pass silently: its volumes still sit on this host and
  // `apps.migrate_from_server_id` is SET NULL on delete, so the marker naming this
  // host as the copy-from source is about to vanish.
  const stranded = await getDb()
    .select({ slug: appsTable.slug })
    .from(appsTable)
    .where(eq(appsTable.migrateFromServerId, id));

  // Queued teardowns go with the host: they name stacks on a machine Deplo is about
  // to forget, so retrying them forever would be dialing an address that is no longer
  // ours.
  const abandoned = await pendingTeardownsForServer(id);

  // (b) Revoke trust before the delete: if anything below fails, the agent's
  // badge is already dead.
  const pinned = server.agent?.certFingerprint ?? "";
  await getDb()
    .update(serversTable)
    .set({ agentCertFingerprint: "" })
    .where(eq(serversTable.id, id));

  // (c) Delete - restoring the pin if it fails, so we never leave a server that
  // is present in the table yet can never be dialed again.
  try {
    await getDb().delete(serversTable).where(eq(serversTable.id, id));
  } catch (e) {
    await getDb()
      .update(serversTable)
      .set({ agentCertFingerprint: pinned })
      .where(eq(serversTable.id, id));
    throw new Error(
      `Could not remove ${server.name} (its trust was restored): ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }
  await recordActivity(
    "server",
    `Removed server ${server.name}`,
    user.name,
    null,
    teamId,
  );
  if (abandoned > 0)
    await recordActivity(
      "server",
      `${abandoned} pending teardown${abandoned === 1 ? "" : "s"} on ${server.name} ` +
        `${abandoned === 1 ? "was" : "were"} dropped with the server.`,
      user.name,
      null,
      teamId,
    );

  const warning =
    stranded.length > 0
      ? `${nameList(stranded.map((a) => a.slug))} ${stranded.length === 1 ? "was" : "were"} ` +
        `mid-move off ${server.name}: the data volumes still live on that host and Deplo ` +
        `has just forgotten where. Copy them off before you uninstall with --purge-data.`
      : null;

  return {
    uninstallCommand: await hostUninstallCommand(),
    warning,
  };
}

/** What {@link uninstallServerAgent} hands back. */
export interface ServerUninstall {
  /** True when the host is clean AND the row is gone. False leaves both in place. */
  removed: boolean;
  /**
   * The host-side one-liner, ALWAYS returned - on success so the operator can
   * verify, on failure because it is then the only way through.
   */
  uninstallCommand: string;
  /** Why it did not happen, or null. Surfaced verbatim in the UI. */
  error: string | null;
  /** A non-blocking hazard, or null - same shape as {@link ServerRemoval}. */
  warning: string | null;
}

/**
 * Take Deplo off a MIGRATION SOURCE: uninstall the agent from the host, then
 * forget the server. (1) Block on what would make the delete fail - BEFORE the
 * RPC.
 */
export async function uninstallServerAgent(
  id: string,
): Promise<ServerUninstall> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  return uninstallMigrationSource(id, user.name, teamId);
}

/**
 * The uninstall itself, with NO capability gate - what {@link
 * uninstallServerAgent} does once it knows the caller is allowed to, and what the
 * automatic sweep does with nobody signed in at all.
 */
export async function uninstallMigrationSource(
  id: string,
  actorName: string,
  teamId: string,
  deadlineMs?: number,
): Promise<ServerUninstall> {
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");
  const command = await hostUninstallCommand();

  // Scoped to the one role that asked for it. An ordinary server's removal is a
  // deliberate, unchanged flow (ADR-0011); widening this is a product decision,
  // not a side effect of the RPC existing.
  if (serverRole(server) !== "import")
    throw new Error(
      `${server.name} is a server in your fleet, not a migration source. ` +
        `Remove it from its own page if you want it gone.`,
    );

  await assertServerRemovable(id);

  if (server.agent?.certFingerprint) {
    try {
      const { selfUninstallServerAgent } =
        await import("../infra/agent-client");
      const removed = await selfUninstallServerAgent(id, deadlineMs);
      await recordActivity(
        "server",
        `Uninstalled the agent from ${server.name} (${removed.join(", ") || "nothing found"})`,
        actorName,
        null,
        teamId,
      );
    } catch (e) {
      return {
        removed: false,
        uninstallCommand: command,
        error: e instanceof Error ? e.message : String(e),
        warning: null,
      };
    }
  }

  const { warning } = await removeServerRow(id, actorName, teamId);
  return { removed: true, uninstallCommand: command, error: null, warning };
}

export interface UpdateServerAddressInput {
  id: string;
  /** The new dial address (IP or DNS name) - written to BOTH `host` and `ip`,
   *  which nothing else ever makes diverge (addServer copies one into the other),
   *  unless {@link UpdateServerAddressInput.keepHost} says otherwise. */
  address: string;
  /** New agent gRPC port; omit to keep the current one. */
  agentPort?: number | null;
  /** Skip the reachability check - for a host that is not up at the new address yet. */
  force?: boolean;
  /**
   * Write only `ip` and leave `host` alone - the MIGRATION WIZARD's flag, and the
   * one case where the two are meant to diverge.
   */
  keepHost?: boolean;
}

/**
 * Rewrite where Deplo dials a server's agent (Danger zone -> "Change address") -
 * the migration verb: a VPS got a new IP, or the whole instance moved hosts.
 */
export async function updateServerAddress(
  input: UpdateServerAddressInput,
): Promise<{ warning: string | null }> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const server = await getServerById(input.id);
  if (!server) throw new Error("Server not found");

  const address = input.address.trim();
  if (!address) throw new Error("Address is required");
  if (
    input.agentPort != null &&
    (!Number.isInteger(input.agentPort) ||
      input.agentPort < 1 ||
      input.agentPort > 65535)
  )
    throw new Error("Agent port must be between 1 and 65535");
  const port = input.agentPort ?? server.agent?.port ?? DEFAULT_AGENT_PORT;
  if (
    address === server.host &&
    address === server.ip &&
    port === (server.agent?.port ?? port)
  )
    return { warning: null };

  let warning: string | null = null;
  if (server.agent?.certFingerprint) {
    const sans = [
      ...new Set([address, server.ip, server.host].filter(Boolean)),
    ];
    try {
      const { renewAgentCert } = await import("../agent/cert-renewal");
      // The NEW address first.
      try {
        await renewAgentCert(server.id, sans, {
          ip: address,
          host: address,
          agentPort: port,
        });
      } catch {
        // The current dial, for the orderly move this was written for - and for
        // `force`, where the new address is not expected to answer yet.
        await renewAgentCert(server.id, sans);
      }
    } catch (e) {
      // Soft on purpose: the force path exists precisely because the old address may
      // already be dead, and an IP-dialed host never consults these SANs.
      warning =
        (input.force
          ? `The address was saved without checking it (force). `
          : `The address is saved and Deplo reached the agent there. `) +
        `One thing did not happen: the certificate's list of names could not be ` +
        `refreshed (${e instanceof Error ? e.message : String(e)}). That list is ` +
        `only consulted when this server is dialed by a DNS NAME - an IP verifies ` +
        `by fingerprint and does not touch it - so switch this server to a name ` +
        `before the certificate renews and TLS will fail until it does.`;
    }
    if (!input.force) {
      const { connectAgentAt } = await import("../infra/agent-client");
      const conn = await connectAgentAt(server.id, {
        ip: address,
        host: address,
        agentPort: port,
      });
      try {
        await conn.hello();
      } finally {
        conn.close();
      }
    }
  }

  const updated = await getDb()
    .update(serversTable)
    .set({
      // `keepHost` leaves `host` as the address the row was BORN with - see the
      // field's own doc. Everywhere else the two stay identical.
      ...(input.keepHost ? {} : { host: address }),
      ip: address,
      // Meaningless before an agent exists - bootstrap sets it when one calls home.
      ...(server.agent && input.agentPort != null
        ? { agentPort: input.agentPort }
        : {}),
    })
    .where(eq(serversTable.id, input.id))
    .returning({ id: serversTable.id });
  // The probe window is real: a concurrent removeServer between the read above
  // and this write must surface as a refusal, not as success + phantom activity.
  if (updated.length === 0) throw new Error("Server not found");
  await recordActivity(
    "server",
    `Changed server ${server.name} address to ${address}:${port}`,
    user.name,
    null,
    teamId,
  );
  return { warning };
}

/**
 * Update a server's agent binary in place to the latest released version WITHOUT
 * reissuing its certificates.
 */
export async function updateServerAgent(
  id: string,
): Promise<{ version: string }> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");
  // Not on a migration source: upgrading the agent on another platform's machine
  // is maintenance of a host we do not run, and the one thing this feature is FOR
  // there is removing it. Reachable from MCP, so the refusal lives here.
  assertNotMigrationSource(server);
  if (!server.agent?.certFingerprint)
    throw new Error(
      "This server is not provisioned yet - finish provisioning before updating its agent",
    );

  // Lazy-import for the same reason removeServer does: keep the grpc agent-client
  // (and its deps) out of modules that never reach an agent.
  const { selfUpdateServerAgent } = await import("../infra/agent-client");
  const result = await selfUpdateServerAgent(id);

  // Record the new version optimistically; the next Hello (markServerSeen)
  // refreshes it from the live agent regardless, so this is just a faster echo.
  await getDb()
    .update(serversTable)
    .set({ agentVersion: result.version })
    .where(eq(serversTable.id, id));
  await recordActivity(
    "server",
    `Updated agent on ${server.name} to v${result.version}`,
    user.name,
    null,
    teamId,
  );
  return result;
}

/** Distinct team ids that have at least one project OR database on this server. */
async function teamsWithWorkloadsOnServer(
  serverId: string,
  db: DrizzleClient | DbTx = getDb(),
): Promise<string[]> {
  const [projTeams, dbTeams] = await Promise.all([
    db
      .selectDistinct({ teamId: appsTable.teamId })
      .from(appsTable)
      .where(eq(appsTable.serverId, serverId)),
    db
      .selectDistinct({ teamId: databasesTable.teamId })
      .from(databasesTable)
      .where(eq(databasesTable.serverId, serverId)),
  ]);
  return [
    ...new Set([
      ...projTeams.map((r) => r.teamId),
      ...dbTeams.map((r) => r.teamId),
    ]),
  ];
}

/** Resolve team ids to their display names (for the block error message). */
async function teamNames(
  ids: string[],
  db: DrizzleClient | DbTx = getDb(),
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ name: teamsTable.name })
    .from(teamsTable)
    .where(inArray(teamsTable.id, ids));
  return rows.map((r) => r.name);
}

/**
 * Re-assert, INSIDE a write transaction, that a server is still targetable by a
 * team - taking a SHARE lock on the server row so the check serializes against a
 * concurrent {@link setServerTeams} restrict (which takes the row's UPDATE lock).
 */
export async function assertServerAccessibleTx(
  tx: DbTx,
  serverId: string,
  teamId: string,
): Promise<void> {
  const rows = await tx
    .select({ allTeams: serversTable.allTeams })
    .from(serversTable)
    .where(eq(serversTable.id, serverId))
    .for("share");
  if (!rows[0]) throw new Error("Server not found");
  if (rows[0].allTeams) return;
  const grant = await tx
    .select({ teamId: serverTeamsTable.teamId })
    .from(serverTeamsTable)
    .where(
      and(
        eq(serverTeamsTable.serverId, serverId),
        eq(serverTeamsTable.teamId, teamId),
      ),
    )
    .limit(1);
  if (!grant[0]) throw new Error("That server isn't available to this team.");
}

export interface SetServerTeamsInput {
  allTeams: boolean;
  /** The granted teams when `allTeams` is false (ignored when it is true). */
  teamIds: string[];
}

/**
 * Set a server's team access (Settings → Servers → Team access; also the install
 * dialog's initial choice). Widening to `all_teams` never blocks.
 */
export async function setServerTeams(
  id: string,
  input: SetServerTeamsInput,
): Promise<Server> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");

  const allTeams = input.allTeams;
  const teamIds = allTeams ? [] : [...new Set(input.teamIds)];
  const selected = new Set(teamIds);

  await getDb().transaction(async (tx) => {
    // Lock the server row FOR UPDATE so a concurrent create that SHARE-locks it
    // (assertServerAccessibleTx) serializes against this restrict - the workload check
    // below then observes every workload committed before we won the lock, closing the
    // TOCTOU window (no team left orphaned on a server it can't see).
    const locked = await tx
      .select({ id: serversTable.id })
      .from(serversTable)
      .where(eq(serversTable.id, id))
      .for("update");
    if (!locked[0]) throw new Error("Server not found");

    if (!allTeams) {
      // The chosen teams must exist (clean message instead of a raw FK error).
      if (teamIds.length > 0) {
        const known = await tx
          .select({ id: teamsTable.id })
          .from(teamsTable)
          .where(inArray(teamsTable.id, teamIds));
        if (known.length !== teamIds.length)
          throw new Error("One or more selected teams no longer exist.");
      }
      // Block when a team with workloads on this server would lose its access.
      const using = await teamsWithWorkloadsOnServer(id, tx);
      const losing = using.filter((t) => !selected.has(t));
      if (losing.length > 0) {
        const names = await teamNames(losing, tx);
        throw new Error(
          `These teams still have apps or databases on this server: ${names.join(
            ", ",
          )}. Move or delete them before revoking the team's access.`,
        );
      }
    }

    await tx
      .update(serversTable)
      .set({ allTeams })
      .where(eq(serversTable.id, id));
    await tx.delete(serverTeamsTable).where(eq(serverTeamsTable.serverId, id));
    if (teamIds.length > 0)
      await tx
        .insert(serverTeamsTable)
        .values(teamIds.map((teamId) => ({ serverId: id, teamId })));
  });

  await recordActivity(
    "server",
    allTeams
      ? `Made server ${server.name} available to all teams`
      : `Set server ${server.name} access to ${teamIds.length} team${teamIds.length === 1 ? "" : "s"}`,
    user.name,
    null,
    teamId,
  );
  return (await getServerById(id))!;
}

/**
 * Set a server's deploy concurrency - how many deployments its agent runs at once
 * (read by lib/deploy/deploy-queue). 1 =
 * strict per-server serialization; deploys on OTHER servers still run in parallel,
 * and a same-app deploy never overlaps regardless of this value.
 */
export async function setServerDeployConcurrency(
  id: string,
  concurrency: number,
): Promise<Server> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");
  const n = Math.floor(concurrency);
  if (!Number.isFinite(n) || n < 1)
    throw new Error("Concurrency must be a whole number of at least 1");
  if (n > 50) throw new Error("Concurrency above 50 isn't supported");
  await getDb()
    .update(serversTable)
    .set({ deployConcurrency: n })
    .where(eq(serversTable.id, id));
  await recordActivity(
    "server",
    `Set deploy concurrency for server ${server.name} to ${n}`,
    user.name,
    null,
    teamId,
  );
  return (await getServerById(id))!;
}

/**
 * What a server is FOR.
 */
export type ServerRole = "everything" | "build" | "storage" | "import";

/** The stored flags as one word. */
export function serverRole(
  s: Pick<Server, "storageOnly" | "buildOnly" | "importOnly">,
): ServerRole {
  if (s.importOnly) return "import";
  if (s.storageOnly) return "storage";
  if (s.buildOnly) return "build";
  return "everything";
}

/**
 * Change what a server is for. The one true asymmetry is physical rather than a
 * policy: a server INSTALLED as backups-only never had Docker put on it, and no
 * database write can change that.
 */
export async function setServerRole(
  id: string,
  role: ServerRole,
): Promise<Server> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");

  const current = serverRole(server);
  if (role === current) return server;

  // A migration source is not a role anyone picks: it is another platform's host,
  // registered by the import wizard, where the installer put no Traefik and no shared
  // network.
  if (current === "import")
    throw new Error(
      `${server.name} was installed only to import from another platform. ` +
        `Re-run the install command on the host to use it as a normal server.`,
    );
  if (role === "import")
    throw new Error(
      "A migration source is created by the import wizard, which installs the " +
        "agent on the other platform's host for you.",
    );

  // The physical one-way door: no Docker on the box, nothing to run or build with.
  if (current === "storage" && !server.dockerVersion)
    throw new Error(
      "This server was installed to hold backups only and has no Docker on it. " +
        "Re-run the install command on the host to change that.",
    );
  // Leaving "everything" means it stops serving what it serves today.
  if (current === "everything") await assertNoWorkloads(id);

  await getDb()
    .update(serversTable)
    .set({
      buildOnly: role === "build",
      storageOnly: role === "storage",
      importOnly: false,
    })
    .where(eq(serversTable.id, id));
  await recordActivity(
    "server",
    role === "build"
      ? `Set server ${server.name} to build only`
      : role === "storage"
        ? `Set server ${server.name} to hold backups only`
        : `Set server ${server.name} to run apps again`,
    user.name,
    null,
    teamId,
  );
  return (await getServerById(id))!;
}

/**
 * Whether this host compiles for an app whose own build server could not be
 * reached. `null` is automatic: the Deplo host builds as a fallback, no other
 * server does - and the app's own server stays the last resort either way.
 */
export async function setServerBuildFallback(
  id: string,
  buildFallback: boolean | null,
): Promise<Server> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");
  if (buildFallback) {
    assertNotMigrationSource(server);
    if (server.storageOnly)
      throw new Error(
        `${server.name} holds backups only - it has no Docker to build with.`,
      );
  }
  await getDb()
    .update(serversTable)
    .set({ buildFallback })
    .where(eq(serversTable.id, id));
  await recordActivity(
    "server",
    buildFallback === null
      ? `Left ${server.name} to decide its build fallback automatically`
      : buildFallback
        ? `Set server ${server.name} to build as a fallback`
        : `Stopped server ${server.name} from building as a fallback`,
    user.name,
    null,
    teamId,
  );
  return (await getServerById(id))!;
}

/** What a calling-home agent sends, and what completeBootstrap signs against. */
export interface BootstrapCallHome {
  /** The raw one-time token from the install command. */
  token: string;
  /** The agent's PKCS#10 CSR (its own key never leaves the box). */
  csrPem: string;
  /** The gRPC port the agent will listen on (default 9443). */
  agentPort?: number;
  /**
   * The address the agent believes it is reachable at - informational only. The
   * control plane dials the SERVER ROW's host/ip (operator-declared), not a
   * self-reported address, so a compromised agent can't redirect future dials.
   */
  advertisedHost?: string;
}

/** The signed material returned to a calling-home agent. */
export interface BootstrapCompletion {
  certPem: string;
  caPem: string;
}

/**
 * Complete a call-home bootstrap (PLAN P1-P4). The check-sign-consume is split:
 * signing (CSR crypto) happens first, then a single conditional UPDATE
 * re-validates the token is still unused and pins the result.
 */
export async function completeBootstrap(
  call: BootstrapCallHome,
): Promise<BootstrapCompletion> {
  // Validate against the current servers (throws a typed BootstrapError on a bad
  // / expired / used token).
  const server = findServerForToken(await listAllServers(), call.token);
  // The cert SANs are the address WE will dial - the operator-declared host/ip
  // on the row, plus a self-reported host only if it matches (defence in depth).
  const dialHosts = [server.ip, server.host].filter(Boolean);
  const signed = await signBootstrapCsr(call.csrPem, dialHosts);
  const port =
    call.agentPort && call.agentPort > 0 ? call.agentPort : DEFAULT_AGENT_PORT;

  // Atomic consume + pin: the conditional UPDATE only fires while the token is
  // still unused, so concurrent call-homes can't both provision (the loser
  // updates 0 rows). `RETURNING id` tells us whether we won.
  const now = nowIso();
  const won = await getDb()
    .update(serversTable)
    .set({
      bootstrapUsedAt: now,
      agentPort: port,
      agentCertFingerprint: signed.fingerprint,
      agentCertPem: signed.certPem,
      agentVersion: "",
      status: "online",
      lastSeenAt: now,
    })
    .where(
      sql`${serversTable.id} = ${server.id} and ${serversTable.bootstrapTokenHash} is not null and ${serversTable.bootstrapUsedAt} is null`,
    )
    .returning({ id: serversTable.id });
  if (won.length === 0) {
    throw new Error("bootstrap token was already consumed");
  }
  return { certPem: signed.certPem, caPem: signed.caPem };
}

/**
 * What a Hello actually OBSERVED about Traefik - `undefined` when it observed
 * nothing. Kept separate because that module is pure classification and must not
 * import the data layer.
 */
export function observedTraefik(hello: {
  dockerAvailable: boolean;
  traefikRunning: boolean;
}): boolean | undefined {
  return hello.dockerAvailable ? hello.traefikRunning : undefined;
}

/**
 * Mark a server seen now (P5 heartbeat cache). A best-effort write behind the
 * live-read health check, never the source of truth for status. Callers pass it
 * through {@link observedTraefik}, never raw.
 */
export async function markServerSeen(
  id: string,
  agentVersion?: string,
  traefikRunning?: boolean,
  specs?: { cpuCores: number; memoryMb: number; diskGb: number },
  dockerVersion?: string,
  hostArch?: string,
): Promise<void> {
  try {
    const set: Record<string, unknown> = { lastSeenAt: nowIso() };
    // `agentVersion` only applies when an agent exists (the old code guarded with
    // `if (s.agent)`); a CASE keeps the version pinned to that condition in one
    // atomic UPDATE - a NULL `agent_port` (unprovisioned) leaves the version NULL.
    if (agentVersion)
      set.agentVersion = sql`case when ${serversTable.agentPort} is not null then ${agentVersion} else ${serversTable.agentVersion} end`;
    if (typeof traefikRunning === "boolean")
      set.traefikEnabled = traefikRunning;
    // The Docker engine version the agent reports on its Hello - born "" at
    // registration and only known live, so persist it here (guard on non-empty so a
    // missing/Docker-unreachable Hello never blanks a good value).
    if (dockerVersion) set.dockerVersion = dockerVersion;
    // The host's CPU architecture, same read-live-then-persist deal as the Docker
    // version.
    if (hostArch) set.hostArch = hostArch;
    // Persist the host's hardware CAPACITY (cores / RAM / disk) the agent reports
    // alongside its live usage. Guard on cpuCores>0 so a failed/empty measure never
    // zeroes good values.
    if (specs && specs.cpuCores > 0) {
      set.cpuCores = specs.cpuCores;
      set.memoryMb = specs.memoryMb;
      set.diskGb = specs.diskGb;
    }
    await getDb().update(serversTable).set(set).where(eq(serversTable.id, id));
  } catch (e) {
    console.error("[deplo] markServerSeen failed:", e);
  }
}
