import "server-only";

import { count, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { getDb } from "../db/client";
import { apiTokens } from "../db/schema/control-plane/api-tokens";
import { apps } from "../db/schema/control-plane/apps";
import { teamRoles } from "../db/schema/control-plane/access-control";
import { backupDestination, backups } from "../db/schema/control-plane/backups";
import { databases } from "../db/schema/control-plane/databases";
import { appPreviews } from "../db/schema/control-plane/deployments";
import { teams, users } from "../db/schema/control-plane/identity";
import { instanceSettings } from "../db/schema/control-plane/instance";
import {
  gitConnections,
  githubApps,
} from "../db/schema/control-plane/integrations";
import { notificationChannels } from "../db/schema/control-plane/notifications";
import { environments } from "../db/schema/control-plane/projects";
import { servers } from "../db/schema/control-plane/servers";
import { passkey } from "../db/schema/auth";
import { knownExpectedAgentVersion } from "../agent/release";
import { deploHostSelfAddresses, isDeploHostServer } from "../deploy/domains";
import { DEPLO_VERSION } from "../version";

// https://deplo.build/docs/operations/anonymous-usage-statistics (ADR-0033)
export const USAGE_REPORT_SCHEMA = 1;
export const USAGE_REPORT_URL = "https://usage.deplo.build/v1/report";
const HOSTS_CAP = 500;

export interface UsageReportHost {
  agentVersion: string | null;
  dockerVersion: string;
  arch: string;
  isDeploHost: boolean;
  isBuildServer: boolean;
  importOnly: boolean;
}

export interface UsageReport {
  schema: number;
  instanceId: string | null;
  deploVersion: string;
  expectedAgentVersion: string;
  installKind: string;
  daysSinceFirstReport: number;
  hosts: UsageReportHost[];
  counts: {
    teams: number;
    users: number;
    servers: number;
    environments: number;
    previews: number;
    backupSchedules: number;
    appsBySource: Record<string, number>;
    databasesByEngine: Record<string, number>;
    destinationsByKind: Record<string, number>;
  };
  features: {
    mcp: boolean;
    twoFactorPolicy: boolean;
    passkeys: boolean;
    gitProvider: boolean;
    notificationChannel: boolean;
    gravatar: boolean;
  };
}

export const DAY_MS = 24 * 60 * 60 * 1000;

function sourceKey(source: string, provider: string | null): string {
  if (source === "git") return provider ?? "git";
  if (source === "docker-image") return "image";
  return source;
}

function destinationKey(kind: string): string {
  return kind === "s3" ? "bucket" : kind;
}

function tally(
  rows: { key: string; n: number }[],
  map: (key: string) => string = (k) => k,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { key, n } of rows) out[map(key)] = (out[map(key)] ?? 0) + n;
  return out;
}

async function countRows(table: PgTable): Promise<number> {
  const [row] = await getDb().select({ n: count() }).from(table);
  return row?.n ?? 0;
}

async function exists(table: PgTable, where?: SQL): Promise<boolean> {
  const rows = await getDb()
    .select({ one: sql`1` })
    .from(table)
    .where(where)
    .limit(1);
  return rows.length > 0;
}

export async function buildUsageReport(opts: {
  instanceId: string | null;
  mintedAt: string | null;
  now?: Date;
}): Promise<UsageReport> {
  const db = getDb();
  const now = opts.now ?? new Date();
  const self = deploHostSelfAddresses();

  const [
    settings,
    hostRows,
    teamCount,
    userCount,
    serverCount,
    environmentCount,
    previewCount,
    scheduleCount,
    appRows,
    databaseRows,
    destinationRows,
    mcp,
    teamPolicy,
    rolePolicy,
    passkeys,
    gitConnection,
    githubApp,
    notificationChannel,
  ] = await Promise.all([
    db
      .select({
        takeoverPlatform: instanceSettings.takeoverPlatform,
        gravatarEnabled: instanceSettings.gravatarEnabled,
      })
      .from(instanceSettings)
      .where(eq(instanceSettings.id, "default"))
      .then((r) => r[0]),
    db
      .select({
        ip: servers.ip,
        host: servers.host,
        agentVersion: servers.agentVersion,
        dockerVersion: servers.dockerVersion,
        arch: servers.hostArch,
        buildOnly: servers.buildOnly,
        importOnly: servers.importOnly,
      })
      .from(servers)
      .orderBy(servers.createdAt)
      .limit(HOSTS_CAP),
    countRows(teams),
    countRows(users),
    countRows(servers),
    countRows(environments),
    countRows(appPreviews),
    countRows(backups),
    db
      .select({ source: apps.source, provider: apps.repoProvider, n: count() })
      .from(apps)
      .groupBy(apps.source, apps.repoProvider),
    db
      .select({ key: databases.type, n: count() })
      .from(databases)
      .groupBy(databases.type),
    db
      .select({ key: backupDestination.kind, n: count() })
      .from(backupDestination)
      .groupBy(backupDestination.kind),
    exists(apiTokens, isNotNull(apiTokens.mcpLastUsedAt)),
    exists(teams, eq(teams.requireTwoFactor, true)),
    exists(teamRoles, eq(teamRoles.requireTwoFactor, true)),
    exists(passkey),
    exists(gitConnections),
    exists(githubApps),
    exists(notificationChannels),
  ]);

  return {
    schema: USAGE_REPORT_SCHEMA,
    instanceId: opts.instanceId,
    deploVersion: DEPLO_VERSION,
    expectedAgentVersion: knownExpectedAgentVersion(),
    installKind: settings?.takeoverPlatform ?? "plain",
    daysSinceFirstReport: opts.mintedAt
      ? Math.max(
          0,
          Math.floor((now.getTime() - Date.parse(opts.mintedAt)) / DAY_MS),
        )
      : 0,
    hosts: hostRows.map((h) => ({
      agentVersion: h.agentVersion || null,
      dockerVersion: h.dockerVersion,
      arch: h.arch,
      isDeploHost: isDeploHostServer(h, self),
      isBuildServer: h.buildOnly,
      importOnly: h.importOnly,
    })),
    counts: {
      teams: teamCount,
      users: userCount,
      servers: serverCount,
      environments: environmentCount,
      previews: previewCount,
      backupSchedules: scheduleCount,
      appsBySource: tally(
        appRows.map((r) => ({ key: sourceKey(r.source, r.provider), n: r.n })),
      ),
      databasesByEngine: tally(databaseRows),
      destinationsByKind: tally(destinationRows, destinationKey),
    },
    features: {
      mcp,
      twoFactorPolicy: teamPolicy || rolePolicy,
      passkeys,
      gitProvider: gitConnection || githubApp,
      notificationChannel,
      gravatar: settings?.gravatarEnabled ?? false,
    },
  };
}
