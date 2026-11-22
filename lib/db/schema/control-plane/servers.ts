import {
  pgTable,
  text,
  integer,
  boolean,
  doublePrecision,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { isoTimestamptz } from "../columns";
import { teams } from "./identity";

export const servers = pgTable(
  "servers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    host: text("host").notNull(),
    type: text("type").notNull(),
    status: text("status").notNull(),
    ip: text("ip").notNull(),
    dockerVersion: text("docker_version").notNull(),
    traefikEnabled: boolean("traefik_enabled").notNull(),
    cpuCores: integer("cpu_cores").notNull(),
    memoryMb: integer("memory_mb").notNull(),
    diskGb: integer("disk_gb").notNull(),
    // Unused: dropped one release later, so an installer rollback to 0.6.0 still reads it.
    agentPort: integer("agent_port"),
    agentCertFingerprint: text("agent_cert_fingerprint"),
    agentCertPem: text("agent_cert_pem"),
    // A rotation's new certificate, stored before the agent installs it (ADR-0050).
    agentNextCertFingerprint: text("agent_next_cert_fingerprint"),
    agentNextCertPem: text("agent_next_cert_pem"),
    // The server the installer enrolled for the machine Deplo runs on: known by identity, never by address.
    deploHost: boolean("deplo_host").notNull().default(false),
    // Where its agent link last came from, as the panel's proxy saw it: shown, never trusted.
    connectedFrom: text("connected_from"),
    // That address is none of its own (the agent's reported ones or its stored one): it is behind a router.
    behindRouter: boolean("behind_router").notNull().default(false),
    agentVersion: text("agent_version"),
    bootstrapTokenHash: text("bootstrap_token_hash"),
    bootstrapExpiresAt: isoTimestamptz("bootstrap_expires_at"),
    bootstrapUsedAt: isoTimestamptz("bootstrap_used_at"),
    lastSeenAt: isoTimestamptz("last_seen_at"),
    statusCheckedAt: isoTimestamptz("status_checked_at"),
    statusProbedAt: isoTimestamptz("status_probed_at"),
    statusMessage: text("status_message"),
    // Set by the first verified agent link and never cleared (ADR-0041).
    firstLinkedAt: isoTimestamptz("first_linked_at"),
    // An instance admin let Deplo pass its update stop without this server: it needs its server agent reinstalled.
    leftBehindAt: isoTimestamptz("left_behind_at"),
    // It left its cluster while its agent did not answer: the sweep tells the agent until it has heard.
    clusterLeavePendingAt: isoTimestamptz("cluster_leave_pending_at"),
    // A leader it no longer runs for any cluster could not be uninstalled: the sweep asks again.
    clusterLeaderRetirePendingAt: isoTimestamptz(
      "cluster_leader_retire_pending_at",
    ),
    allTeams: boolean("all_teams").notNull().default(true),
    storageOnly: boolean("storage_only").notNull().default(false),
    buildOnly: boolean("build_only").notNull().default(false),
    buildFallback: boolean("build_fallback"),
    // "ipv4" | "ipv6"; null = automatic, IPv4 when the host has one.
    generatedAddressFamily: text("generated_address_family"),
    importOnly: boolean("import_only").notNull().default(false),
    uninstallNextAt: isoTimestamptz("uninstall_next_at"),
    uninstallAttempts: integer("uninstall_attempts").notNull().default(0),
    uninstallError: text("uninstall_error").notNull().default(""),
    uninstallRunId: text("uninstall_run_id"),
    hostArch: text("host_arch").notNull().default(""),
    deployConcurrency: integer("deploy_concurrency").notNull().default(1),
    // Where an admin dragged it on the Servers page; null = never placed, after the placed ones.
    position: integer("position"),
    // Where it is in the world (ADR-0049), as an instance admin set it; null = found from its address.
    geoLatitude: doublePrecision("geo_latitude"),
    geoLongitude: doublePrecision("geo_longitude"),
    // The city picked, as the picker named it; null when typed as coordinates.
    geoPlace: text("geo_place"),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("servers_cert_fingerprint_uq")
      .on(t.agentCertFingerprint)
      .where(
        sql`${t.agentCertFingerprint} is not null and ${t.agentCertFingerprint} <> ''`,
      ),
    uniqueIndex("servers_next_cert_fingerprint_uq")
      .on(t.agentNextCertFingerprint)
      .where(sql`${t.agentNextCertFingerprint} is not null`),
    index("servers_bootstrap_token_idx")
      .on(t.bootstrapTokenHash)
      .where(sql`${t.bootstrapTokenHash} is not null`),
  ],
);

// Keys a server rotated away from: a machine that still holds one is a copy (ADR-0050).
export const serverRetiredCerts = pgTable(
  "server_retired_certs",
  {
    fingerprint: text("fingerprint").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    certPem: text("cert_pem").notNull(),
    retiredAt: isoTimestamptz("retired_at").notNull(),
  },
  (t) => [index("server_retired_certs_server_idx").on(t.serverId)],
);

export const serverTeams = pgTable(
  "server_teams",
  {
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.teamId] })],
);

// One row per server whose agent update is in flight or failed; none means idle (ADR-0037).
export const serverAgentUpdates = pgTable("server_agent_updates", {
  serverId: text("server_id")
    .primaryKey()
    .references(() => servers.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  failure: text("failure").notNull().default(""),
  attempts: integer("attempts").notNull().default(0),
  targetVersion: text("target_version").notNull(),
  firstFailedAt: isoTimestamptz("first_failed_at"),
  nextRetryAt: isoTimestamptz("next_retry_at"),
  revived: boolean("revived").notNull().default(false),
  lastError: text("last_error").notNull().default(""),
  updatedAt: isoTimestamptz("updated_at").notNull(),
});

// What each server's agent last said it can do over Hello, read at render so nothing dials a server then.
export const serverAgentCapabilities = pgTable(
  "server_agent_capabilities",
  {
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
    agentVersion: text("agent_version").notNull(),
    reportedAt: isoTimestamptz("reported_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.capability] })],
);
