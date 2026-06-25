import "server-only";

import { headers } from "next/headers";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb, type DrizzleClient, type DbTx } from "../db/client";
import {
  databases as databasesTable,
  projects as projectsTable,
  serverTeams as serverTeamsTable,
  servers as serversTable,
  teams as teamsTable,
} from "../db/schema/control-plane";
import { assembleServer, serverToRow } from "./infra-rows";
import { getCurrentUser } from "../auth";
import { requireActiveTeamId, requireCapability } from "../membership";
import { newId, nowIso } from "../ids";
import { resolvePublicBaseUrl } from "../public-url";
import { recordActivity } from "./activity";
import {
  mintBootstrap,
  installCommand,
  controlPlaneCertFingerprint,
  findServerForToken,
  signBootstrapCsr,
  DEFAULT_AGENT_PORT,
} from "../agent/bootstrap";
import type { Server, Team } from "../types";

/**
 * `servers` is RELATIONAL as of cut-set (e) (relational-store PLAN Step 6). It is
 * instance-wide infra (no `team_id`), read/written directly through the `servers`
 * table here. The old JSONB `read().servers`/`mutate()` paths and the
 * `server-row.ts` mirror bridge (which kept the relational row in sync while
 * `servers` was JSONB-authoritative for cut-set (c)'s `projects.server_id` FK) are
 * gone — this module now owns the table outright.
 */

/**
 * All servers by creation order (internal; NO auth gate). Exported for the
 * consumers that iterate every server (metrics fan-out, summary join, S3 dest
 * server picklist) and already enforce their own auth — they read the relational
 * `servers` table through this instead of the deleted `read().servers`.
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
 * The public, TEAM-SCOPED server read: a viewer sees only the servers their
 * active team may target (every `all_teams` server + the ones granted to it).
 * A server restricted to other teams must never leak through this read — the
 * unscoped list is {@link listAllServers} (internal) / the manage_infra-gated
 * management page. (Previously this returned every server to any logged-in user,
 * which leaked a restricted server's metadata to excluded teams.)
 */
export async function listServers(): Promise<Server[]> {
  return listServersForCurrentTeam();
}

export async function getServer(id: string): Promise<Server | null> {
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
 * The "primary" server — the first one added — or null when none exists yet
 * (e.g. straight after first-run setup, before the operator has added any host).
 * Callers must tolerate null and prompt the operator to add a server.
 */
export async function getPrimaryServer(): Promise<Server | null> {
  // Team-scoped: the first server the active team can target (was: the first
  // server overall, which leaked existence of an other-team-only server).
  const servers = await listServersForCurrentTeam();
  return servers[0] ?? null;
}

/**
 * Servers a given team may target for its projects/databases: every `all_teams`
 * server PLUS the ones explicitly granted to this team via `server_teams`. This
 * is the CONSUMPTION view (the deploy-target picklist), as opposed to the
 * management view ({@link listServers}, which is unfiltered so an infra operator
 * administers every host). Creation order, like the unfiltered list.
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
      or(eq(serversTable.allTeams, true), inArray(serversTable.id, grantedToTeam)),
    )
    .orderBy(asc(serversTable.createdAt));
  return rows.map(assembleServer);
}

/** {@link listServersForTeam} for the caller's active team (asserts membership). */
export async function listServersForCurrentTeam(): Promise<Server[]> {
  const teamId = await requireActiveTeamId();
  return listServersForTeam(teamId);
}

/** The team ids a non-`all_teams` server is restricted to (empty for an unscoped one). */
export async function getServerTeamIds(serverId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ teamId: serverTeamsTable.teamId })
    .from(serverTeamsTable)
    .where(eq(serverTeamsTable.serverId, serverId));
  return rows.map((r) => r.teamId);
}

/** The teams a server is granted to, with names — for the access editor + badges. */
export async function getServerTeams(serverId: string): Promise<Team[]> {
  const rows = await getDb()
    .select({
      id: teamsTable.id,
      name: teamsTable.name,
      slug: teamsTable.slug,
      plan: teamsTable.plan,
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
 * Register a remote server (PLAN Part B, P1). No SSH-in: the control plane never
 * holds the server's root credential. Instead it mints a one-time bootstrap
 * token, records the server in `provisioning`, and returns a paste-on-the-server
 * install command. The operator runs it; the agent calls home (see
 * app/api/agent/bootstrap), gets its CSR signed, and the server flips to
 * `online`. The old `sshUser`/`sshPort` fields are gone — the call-home model
 * never uses them (PLAN P1).
 */
export async function addServer(input: AddServerInput): Promise<AddServerResult> {
  const { membership } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;
  const host = input.host.trim();

  const { rawToken, stored } = mintBootstrap();
  const baseUrl = resolvePublicBaseUrl(await headers());
  // Best-effort: read the control plane's own TLS fingerprint to pin in the
  // command (P3). Empty over plain HTTP — the agent then uses the HMAC path.
  const fingerprint = await controlPlaneCertFingerprint(baseUrl);

  // Default to instance-wide. When restricting at registration, the junction
  // grants the named teams; an empty teamIds list means "no team yet" (the
  // operator wires teams up later from the server's Team access editor).
  const allTeams = input.allTeams ?? true;
  const teamIds = allTeams ? [] : [...new Set(input.teamIds ?? [])];

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
    cpuUsage: 0,
    memoryUsage: 0,
    diskUsage: 0,
    allTeams,
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
  await recordActivity("member", `Connected server ${server.name}`, user.name, null, membership.teamId);

  return {
    server,
    installCommand: installCommand({ baseUrl, rawToken, fingerprint }),
  };
}

/**
 * Re-mint a fresh bootstrap token + install command for a server — whether it is
 * still `provisioning` (the original token expired or the operator lost it) OR
 * already provisioned and online (the operator wants the install command back to
 * copy it again, e.g. to reinstall or repair the agent on the box). Re-minting
 * only issues a new single-use token; it does NOT disturb a running agent's pinned
 * mTLS — the old cert keeps working until/unless the operator actually re-runs the
 * command, at which point the normal call-home (`completeBootstrap`) re-pins a
 * fresh cert. Because re-minting is a copy action, a server that is already trusted
 * KEEPS its current status (online/offline); only a server that never finished its
 * first call-home is (re)marked `provisioning`.
 */
export async function reissueBootstrap(id: string): Promise<AddServerResult> {
  const { membership } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");

  const { rawToken, stored } = mintBootstrap();
  const baseUrl = resolvePublicBaseUrl(await headers());
  const fingerprint = await controlPlaneCertFingerprint(baseUrl);
  await getDb()
    .update(serversTable)
    .set({
      bootstrapTokenHash: stored.tokenHash,
      bootstrapExpiresAt: stored.expiresAt,
      bootstrapUsedAt: stored.usedAt,
      // A trusted server (one with a pinned agent cert) stays online/offline — a
      // re-copy must not knock it back to "provisioning". Only a server still
      // awaiting its first call-home gets (re)marked provisioning.
      ...(server.agent ? {} : { status: "provisioning" as const }),
    })
    .where(eq(serversTable.id, id));
  const fresh = (await getServerById(id))!;
  // Re-minting a single-use bootstrap token arms a ~1h re-pin window — and for an
  // already-trusted server that window can silently replace its agent cert. Like
  // addServer/removeServer, leave an audit trail so a re-issue against a live box
  // is never invisible (the operator-gated act is logged, not hidden).
  await recordActivity("member", `Reissued install command for server ${server.name}`, user.name, null, membership.teamId);
  return { server: fresh, installCommand: installCommand({ baseUrl, rawToken, fingerprint }) };
}

/**
 * Remove a remote server with the ordered three-move teardown (PLAN P6):
 *   (a) ALWAYS revoke trust first — drop the pinned cert — even if the box is
 *       dead, so a removed server never keeps a valid badge;
 *   (b) BLOCK removal while projects are still assigned — the operator
 *       reassigns or deletes them first, consciously (no silent re-home);
 *   (c) BEST-EFFORT remote teardown — pre-flight Hello, and if the agent
 *       answers, tell it to tear down its stacks; if unreachable, proceed with
 *       removal anyway and warn that leftover containers need a manual cleanup.
 *
 * Returns a warning string when (c) could not complete (the agent was
 * unreachable), or null on a clean teardown.
 */
export async function removeServer(id: string): Promise<{ warning: string | null }> {
  const { membership } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");

  // (b) Block while projects are assigned — a conscious decision by the operator.
  // Projects are relational; count this server's projects directly (also: the
  // `projects.server_id` FK is RESTRICT, so the DELETE below would fail anyway —
  // this gives a clear message before the teardown work).
  const assigned = await getDb()
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(eq(projectsTable.serverId, id))
    .limit(1);
  if (assigned.length > 0)
    throw new Error("Move or delete projects on this server first");

  // The teardown dials the agent with its CURRENT (pre-revoke) trust material, so
  // capture it before the revoke below clears the pinned cert.
  const snapshot: Server = { ...server, agent: server.agent ? { ...server.agent } : undefined };
  const wasProvisioned = Boolean(server.agent?.certFingerprint) || server.status === "online";

  // (a) Revoke trust FIRST, unconditionally: clear the pinned cert so even if
  // every later step fails, the agent's badge is already dead. Persisted before
  // any network call so a crash mid-teardown still leaves trust revoked.
  await getDb()
    .update(serversTable)
    .set({ agentCertFingerprint: "" })
    .where(eq(serversTable.id, id));

  // (c) Best-effort remote teardown. Import lazily so removing a server doesn't
  // force the agent-client (and its grpc deps) into modules that never deploy.
  // Dial via the pre-revoke snapshot (the live row's pin is now cleared).
  let warning: string | null = null;
  if (wasProvisioned) {
    try {
      const { teardownServerAgent } = await import("../infra/agent-client");
      await teardownServerAgent(snapshot);
    } catch (e) {
      warning =
        `Could not reach the agent on ${server.name} to tear down its containers ` +
        `(${e instanceof Error ? e.message : String(e)}). Remove leftover ` +
        `deplo-* containers on that host by hand.`;
    }
  }

  await getDb().delete(serversTable).where(eq(serversTable.id, id));
  await recordActivity("member", `Removed server ${server.name}`, user.name, null, membership.teamId);
  return { warning };
}

/**
 * Update a server's agent binary in place to the latest released version WITHOUT
 * reissuing its certificates. Unlike re-running the installer (which mints a new
 * token and re-bootstraps, clearing the agent's mTLS materials), this dials the
 * agent over its EXISTING pinned-mTLS channel and asks it to self-update: fetch
 * the checksum-verified latest binary, swap itself on disk, and re-exec keeping
 * the same on-disk cert/key/CA. Trust — the pinned fingerprint — is untouched, so
 * the server stays "online" with the same identity across the upgrade.
 *
 * Resolves the "latest" target version through the same release resolver the
 * outdated badge uses, so what we install matches what the dashboard flagged.
 * Returns the version the agent is now running. Throws when the server is
 * unreachable / not provisioned, or — until the agent ships the self-update RPC —
 * AgentUpdateUnsupportedError (the GraphQL layer turns that into a clear message
 * telling the operator to re-run the installer for now).
 */
export async function updateServerAgent(id: string): Promise<{ version: string }> {
  const { membership } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");
  if (!server.agent?.certFingerprint)
    throw new Error("This server is not provisioned yet — finish provisioning before updating its agent");

  // Lazy-import for the same reason removeServer does: keep the grpc agent-client
  // (and its deps) out of modules that never reach an agent. The seam resolves the
  // latest release itself (version + per-arch url/sha from one consistent release)
  // and tells the agent to self-update over its existing pinned-mTLS channel —
  // certs are never reissued.
  const { selfUpdateServerAgent } = await import("../infra/agent-client");
  const result = await selfUpdateServerAgent(id);

  // Record the new version optimistically; the next Hello (markServerSeen)
  // refreshes it from the live agent regardless, so this is just a faster echo.
  await getDb()
    .update(serversTable)
    .set({ agentVersion: result.version })
    .where(eq(serversTable.id, id));
  await recordActivity(
    "member",
    `Updated agent on ${server.name} to v${result.version}`,
    user.name,
    null,
    membership.teamId,
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
      .selectDistinct({ teamId: projectsTable.teamId })
      .from(projectsTable)
      .where(eq(projectsTable.serverId, serverId)),
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
 * team — taking a SHARE lock on the server row so the check serializes against a
 * concurrent {@link setServerTeams} restrict (which takes the row's UPDATE lock).
 * Callers that place a workload (createProject/createDatabase) use this to close
 * the TOCTOU window between picking a team-visible server and committing the row.
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
 * dialog's initial choice). `allTeams: true` opens it to every team and clears
 * any specific grants. `allTeams: false` restricts it to `teamIds`.
 *
 * RESTRICTING is BLOCKED when a team that still has projects or databases on this
 * server would lose access — the operator moves/deletes those first, the same
 * conscious-teardown rule {@link removeServer} enforces (no silent orphaning of a
 * team's running workloads onto a server it can no longer target). Widening to
 * `all_teams` never blocks. Gated by `manage_infra`.
 */
export async function setServerTeams(
  id: string,
  input: SetServerTeamsInput,
): Promise<Server> {
  const { membership } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");

  const allTeams = input.allTeams;
  const teamIds = allTeams ? [] : [...new Set(input.teamIds)];
  const selected = new Set(teamIds);

  await getDb().transaction(async (tx) => {
    // Lock the server row FOR UPDATE so a concurrent create that SHARE-locks it
    // (assertServerAccessibleTx) serializes against this restrict — the workload
    // check below then observes every workload committed before we won the lock,
    // closing the TOCTOU window (no team left orphaned on a server it can't see).
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
          `These teams still have projects or databases on this server: ${names.join(
            ", ",
          )}. Move or delete them before revoking the team's access.`,
        );
      }
    }

    await tx.update(serversTable).set({ allTeams }).where(eq(serversTable.id, id));
    await tx.delete(serverTeamsTable).where(eq(serverTeamsTable.serverId, id));
    if (teamIds.length > 0)
      await tx
        .insert(serverTeamsTable)
        .values(teamIds.map((teamId) => ({ serverId: id, teamId })));
  });

  await recordActivity(
    "member",
    allTeams
      ? `Made server ${server.name} available to all teams`
      : `Set server ${server.name} access to ${teamIds.length} team${teamIds.length === 1 ? "" : "s"}`,
    user.name,
    null,
    membership.teamId,
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
   * The address the agent believes it is reachable at — informational only. The
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
 * Complete a call-home bootstrap (PLAN P1-P4). UNAUTHENTICATED entry point (the
 * caller is a brand-new agent, not a logged-in user) — its trust comes entirely
 * from the single-use token + the CSR proof-of-possession, NOT from a session.
 * Validates the token against a provisioning server, signs the agent's CSR with
 * the control-plane CA using the SERVER ROW's declared address as the cert SANs
 * (never a self-reported one), then atomically pins the cert fingerprint, clears
 * the bootstrap token (single-use), and flips `provisioning -> online`.
 *
 * The check-sign-consume is split: signing (CSR crypto) happens first, then a
 * single conditional UPDATE re-validates the token is still unused and pins the
 * result. The `WHERE bootstrap_used_at IS NULL` predicate makes the consume
 * single-use under concurrency — a double-submit's loser updates 0 rows and throws
 * (replacing the old in-memory mutate() re-check).
 */
export async function completeBootstrap(
  call: BootstrapCallHome,
): Promise<BootstrapCompletion> {
  // Validate against the current servers (throws a typed BootstrapError on a bad
  // / expired / used token).
  const server = findServerForToken(await listAllServers(), call.token);
  // The cert SANs are the address WE will dial — the operator-declared host/ip
  // on the row, plus a self-reported host only if it matches (defence in depth).
  const dialHosts = [server.ip, server.host].filter(Boolean);
  const signed = await signBootstrapCsr(call.csrPem, dialHosts);
  const port = call.agentPort && call.agentPort > 0 ? call.agentPort : DEFAULT_AGENT_PORT;

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
 * Mark a server seen now (P5 heartbeat cache). A best-effort write behind the
 * live-read health check — never the source of truth for status. Also refreshes
 * `traefikEnabled` from the live Hello (whether a Traefik proxy is running on the
 * host) — read-live-not-stored, so the badge self-corrects if Traefik later stops
 * or is added, instead of the hardcoded false a remote row is born with.
 *
 * Async + self-swallowing (like `recordActivity`): callers fire-and-forget it
 * (`void markServerSeen(...)`), so a write failure never disrupts the live read.
 */
export async function markServerSeen(
  id: string,
  agentVersion?: string,
  traefikRunning?: boolean,
  specs?: { cpuCores: number; memoryMb: number; diskGb: number },
  dockerVersion?: string,
): Promise<void> {
  try {
    const set: Record<string, unknown> = { lastSeenAt: nowIso() };
    // `agentVersion` only applies when an agent exists (the old code guarded with
    // `if (s.agent)`); a CASE keeps the version pinned to that condition in one
    // atomic UPDATE — a NULL `agent_port` (unprovisioned) leaves the version NULL.
    if (agentVersion)
      set.agentVersion = sql`case when ${serversTable.agentPort} is not null then ${agentVersion} else ${serversTable.agentVersion} end`;
    if (typeof traefikRunning === "boolean") set.traefikEnabled = traefikRunning;
    // The Docker engine version the agent reports on its Hello — born "" at
    // registration and only known live, so persist it here (guard on non-empty so
    // a missing/Docker-unreachable Hello never blanks a good value). Drives the
    // Servers page's Docker spec tile without a live poll.
    if (dockerVersion) set.dockerVersion = dockerVersion;
    // Persist the host's hardware CAPACITY (cores / RAM / disk) the agent reports
    // alongside its live usage. Capacity is effectively static, so storing it lets
    // the Servers page render the specs without a live poll. Guard on cpuCores>0 so
    // a failed/empty measure never zeroes good values.
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
