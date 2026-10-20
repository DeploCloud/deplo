import {
  pgTable,
  text,
  integer,
  boolean,
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
    agentPort: integer("agent_port"),
    agentCertFingerprint: text("agent_cert_fingerprint"),
    agentCertPem: text("agent_cert_pem"),
    agentVersion: text("agent_version"),
    bootstrapTokenHash: text("bootstrap_token_hash"),
    bootstrapExpiresAt: isoTimestamptz("bootstrap_expires_at"),
    bootstrapUsedAt: isoTimestamptz("bootstrap_used_at"),
    lastSeenAt: isoTimestamptz("last_seen_at"),
    statusCheckedAt: isoTimestamptz("status_checked_at"),
    statusProbedAt: isoTimestamptz("status_probed_at"),
    statusMessage: text("status_message"),
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
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("servers_cert_fingerprint_uq")
      .on(t.agentCertFingerprint)
      .where(
        sql`${t.agentCertFingerprint} is not null and ${t.agentCertFingerprint} <> ''`,
      ),
    index("servers_bootstrap_token_idx")
      .on(t.bootstrapTokenHash)
      .where(sql`${t.bootstrapTokenHash} is not null`),
  ],
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
