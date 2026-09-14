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

// servers - [Server](../../../types.ts), with ServerAgent / ServerBootstrap flattened onto the row.
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
    // Flattened ServerAgent (present once provisioned; NULL while provisioning).
    agentPort: integer("agent_port"),
    agentCertFingerprint: text("agent_cert_fingerprint"),
    agentCertPem: text("agent_cert_pem"),
    agentVersion: text("agent_version"),
    // Flattened ServerBootstrap (present only while provisioning).
    bootstrapTokenHash: text("bootstrap_token_hash"),
    bootstrapExpiresAt: isoTimestamptz("bootstrap_expires_at"),
    bootstrapUsedAt: isoTimestamptz("bootstrap_used_at"),
    lastSeenAt: isoTimestamptz("last_seen_at"),
    // When `status` was last OBSERVED (a probe classified and recorded a result), and
    // the curated reason behind a non-online value.
    statusCheckedAt: isoTimestamptz("status_checked_at"),
    // The throttle LEASE - when a probe was last claimed, advanced whether or not it
    // went on to observe anything. Kept separate from status_checked_at so an
    // inconclusive probe (timeout/skip) never fabricates a fresh observation timestamp.
    statusProbedAt: isoTimestamptz("status_probed_at"),
    statusMessage: text("status_message"),
    // Team access scope. `true` (default) = available to every team - the
    // historical instance-wide behaviour. `false` restricts the server to the
    // teams enumerated in `server_teams`. See [Server.allTeams](../../types.ts).
    allTeams: boolean("all_teams").notNull().default(true),
    // A VPS bought purely to HOLD BACKUPS: the agent is installed, Docker is not, and
    // nothing is ever deployed here.
    storageOnly: boolean("storage_only").notNull().default(false),
    // A server bought purely to COMPILE: Docker is installed, Traefik is not, and no
    // app of any team runs here.
    buildOnly: boolean("build_only").notNull().default(false),
    // Whether this host may compile for an app whose build server could not. NULL is
    // automatic, which is the Deplo host and nothing else (migration 0151).
    buildFallback: boolean("build_fallback"),
    // A server registered ONLY to import from another platform: Docker is there (it is
    // that platform's host), Traefik is not, the shared `deplo` network is not, and
    // nothing of ours ever runs here.
    importOnly: boolean("import_only").notNull().default(false),
    // The pending removal of a MIGRATION SOURCE's agent, kept on the row that has to
    // die rather than in a queue of its own: deleting it drops the intent with it
    // (migration 0118).
    uninstallNextAt: isoTimestamptz("uninstall_next_at"),
    uninstallAttempts: integer("uninstall_attempts").notNull().default(0),
    uninstallError: text("uninstall_error").notNull().default(""),
    uninstallRunId: text("uninstall_run_id"),
    // This host's CPU architecture ("amd64" | "arm64"), observed from each Hello like
    // `docker_version` and `traefik_enabled` - never asserted at registration.
    hostArch: text("host_arch").notNull().default(""),
    // How many deployments this server's agent runs at once. The deploy queue
    // (lib/deploy/deploy-queue.ts) reads it as the per-server slot count; a
    // same-service deploy never overlaps regardless.
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

// serverTeams - which teams may target a server; rows matter only when `all_teams` is false.
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
