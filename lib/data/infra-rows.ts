import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

import {
  activities,
  githubApps,
  githubInstallation,
  servers,
} from "../db/schema/control-plane";
import type {
  Activity,
  ActivityType,
  GithubApp,
  GithubInstallation,
  Server,
  ServerStatus,
} from "../types";

/**
 * The ONE relational-rows ↔ domain-objects mapping for the infra/integrations
 * tables (relational-store PLAN Step 6 cut-set (e)): `servers`, `github_apps`,
 * `github_installation`, `activities`.
 */

export type ServerRow = InferSelectModel<typeof servers>;
export type ServerInsert = InferInsertModel<typeof servers>;
export type GithubAppRow = InferSelectModel<typeof githubApps>;
export type GithubAppInsert = InferInsertModel<typeof githubApps>;
export type GithubInstallationRow = InferSelectModel<typeof githubInstallation>;
export type GithubInstallationInsert = InferInsertModel<
  typeof githubInstallation
>;
export type ActivityRow = InferSelectModel<typeof activities>;
export type ActivityInsert = InferInsertModel<typeof activities>;

/* ------------------------------------------------------------------ */
/* servers (flattens ServerAgent + ServerBootstrap)                    */
/* ------------------------------------------------------------------ */

/**
 * Which {@link Server} fields are folded into which `servers` columns.
 */
const SERVER_FIELDS = {
  id: true,
  name: true,
  host: true,
  type: true,
  status: true,
  ip: true,
  dockerVersion: true,
  traefikEnabled: true,
  cpuCores: true,
  memoryMb: true,
  diskGb: true,
  cpuUsage: true,
  memoryUsage: true,
  diskUsage: true,
  allTeams: true,
  storageOnly: true,
  buildOnly: true,
  importOnly: true,
  uninstallPending: true,
  uninstallError: true,
  hostArch: true,
  deployConcurrency: true,
  traefikDashboard: true,
  createdAt: true,
  agent: true,
  bootstrap: true,
  lastSeenAt: true,
  statusCheckedAt: true,
  statusMessage: true,
} satisfies Record<keyof Server, true>;
void SERVER_FIELDS;

/** Explode a {@link Server} (+ its nested agent/bootstrap) into a `servers` row. */
export function serverToRow(s: Server): ServerInsert {
  return {
    id: s.id,
    name: s.name,
    host: s.host,
    type: s.type,
    status: s.status,
    ip: s.ip,
    dockerVersion: s.dockerVersion,
    traefikEnabled: s.traefikEnabled,
    cpuCores: s.cpuCores,
    memoryMb: s.memoryMb,
    diskGb: s.diskGb,
    cpuUsage: s.cpuUsage,
    memoryUsage: s.memoryUsage,
    diskUsage: s.diskUsage,
    allTeams: s.allTeams,
    storageOnly: s.storageOnly,
    buildOnly: s.buildOnly,
    importOnly: s.importOnly,
    // The retry state itself (attempts, next_at, run_id) is written by targeted
    // UPDATEs, never from a DTO round trip - a full row write from a shape that cannot
    // carry it would reset the ladder on every unrelated save.
    uninstallError: s.uninstallError,
    hostArch: s.hostArch,
    deployConcurrency: s.deployConcurrency,
    // Flattened ServerAgent (NULL columns when not yet provisioned).
    agentPort: s.agent?.port ?? null,
    agentCertFingerprint: s.agent?.certFingerprint ?? null,
    agentCertPem: s.agent?.certPem ?? null,
    agentVersion: s.agent?.version ?? null,
    // Flattened ServerBootstrap (NULL columns once provisioned / never set).
    bootstrapTokenHash: s.bootstrap?.tokenHash ?? null,
    bootstrapExpiresAt: s.bootstrap?.expiresAt ?? null,
    bootstrapUsedAt: s.bootstrap?.usedAt ?? null,
    lastSeenAt: s.lastSeenAt ?? null,
    // The health OBSERVATION behind `status`. Absent means "never probed" - a
    // distinct, honest state the UI renders as "Unknown", so neither is defaulted.
    statusCheckedAt: s.statusCheckedAt ?? null,
    statusMessage: s.statusMessage ?? null,
    // The dashboard's domain + username round-trip; the password does NOT, and this
    // must never learn to write it.
    traefikDashboardDomain: s.traefikDashboard?.domain ?? null,
    traefikDashboardUser: s.traefikDashboard?.username ?? null,
    createdAt: s.createdAt,
  };
}

/**
 * Reassemble a `servers` row into a {@link Server}, rebuilding the nested
 * `agent`/`bootstrap` objects from their flattened columns.
 */
export function assembleServer(row: ServerRow): Server {
  const server: Server = {
    id: row.id,
    name: row.name,
    host: row.host,
    type: row.type as Server["type"],
    status: row.status as ServerStatus,
    ip: row.ip,
    dockerVersion: row.dockerVersion,
    traefikEnabled: row.traefikEnabled,
    cpuCores: row.cpuCores,
    memoryMb: row.memoryMb,
    diskGb: row.diskGb,
    cpuUsage: row.cpuUsage,
    memoryUsage: row.memoryUsage,
    diskUsage: row.diskUsage,
    allTeams: row.allTeams,
    storageOnly: row.storageOnly ?? false,
    buildOnly: row.buildOnly ?? false,
    importOnly: row.importOnly ?? false,
    uninstallPending: row.uninstallNextAt !== null,
    uninstallError: row.uninstallError ?? "",
    // "" is "the agent never told us", which never matches another host's arch -
    // so an un-upgraded server is simply not offered as a builder.
    hostArch: row.hostArch ?? "",
    // NULL-safe: rows created before the column default to strict serialization.
    deployConcurrency: row.deployConcurrency ?? 1,
    createdAt: row.createdAt,
  };
  if (row.agentPort !== null) {
    server.agent = {
      port: row.agentPort,
      certFingerprint: row.agentCertFingerprint ?? "",
      certPem: row.agentCertPem ?? "",
      version: row.agentVersion ?? "",
    };
  }
  if (row.bootstrapTokenHash !== null) {
    server.bootstrap = {
      tokenHash: row.bootstrapTokenHash,
      expiresAt: row.bootstrapExpiresAt ?? "",
      usedAt: row.bootstrapUsedAt,
    };
  }
  // The domain is what makes the dashboard "on"; the username rides along for the
  // form. The encrypted password is NEVER projected - it stays in the data layer.
  if (row.traefikDashboardDomain) {
    server.traefikDashboard = {
      domain: row.traefikDashboardDomain,
      username: row.traefikDashboardUser ?? "",
    };
  }
  if (row.lastSeenAt !== null) server.lastSeenAt = row.lastSeenAt;
  if (row.statusCheckedAt !== null)
    server.statusCheckedAt = row.statusCheckedAt;
  if (row.statusMessage !== null) server.statusMessage = row.statusMessage;
  return server;
}

/* ------------------------------------------------------------------ */
/* github_apps                                                         */
/* ------------------------------------------------------------------ */

/** Explode a {@link GithubApp} into its `github_apps` row. */
export function githubAppToRow(a: GithubApp): GithubAppInsert {
  return {
    id: a.id,
    teamId: a.teamId,
    appId: a.appId,
    slug: a.slug,
    name: a.name,
    clientId: a.clientId,
    clientSecretEnc: a.clientSecretEnc,
    webhookSecretEnc: a.webhookSecretEnc,
    privateKeyEnc: a.privateKeyEnc,
    htmlUrl: a.htmlUrl,
    createdAt: a.createdAt,
  } satisfies Record<keyof GithubApp, unknown> as GithubAppInsert;
}

/** Reassemble a `github_apps` row into a {@link GithubApp}. */
export function assembleGithubApp(row: GithubAppRow): GithubApp {
  return {
    id: row.id,
    teamId: row.teamId,
    appId: row.appId,
    slug: row.slug,
    name: row.name,
    clientId: row.clientId,
    clientSecretEnc: row.clientSecretEnc,
    webhookSecretEnc: row.webhookSecretEnc,
    privateKeyEnc: row.privateKeyEnc,
    htmlUrl: row.htmlUrl,
    createdAt: row.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/* github_installation                                                 */
/* ------------------------------------------------------------------ */

/** Explode a {@link GithubInstallation} into its `github_installation` row. */
export function githubInstallationToRow(
  i: GithubInstallation,
): GithubInstallationInsert {
  return {
    id: i.id,
    appId: i.appId,
    installationId: i.installationId,
    accountLogin: i.accountLogin,
    accountType: i.accountType,
    avatarUrl: i.avatarUrl,
    createdAt: i.createdAt,
  } satisfies Record<
    keyof GithubInstallation,
    unknown
  > as GithubInstallationInsert;
}

/** Reassemble a `github_installation` row into a {@link GithubInstallation}. */
export function assembleGithubInstallation(
  row: GithubInstallationRow,
): GithubInstallation {
  return {
    id: row.id,
    appId: row.appId,
    installationId: row.installationId,
    accountLogin: row.accountLogin,
    accountType: row.accountType as GithubInstallation["accountType"],
    avatarUrl: row.avatarUrl,
    createdAt: row.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/* activities (history; seq asymmetry)                                 */
/* ------------------------------------------------------------------ */

/**
 * Explode an {@link Activity} into its `activities` row. NEVER writes `seq` - it
 * is a `bigint identity` the DB assigns in insertion order (PLAN §5), so a copy /
 * insert in source-array order reproduces the history's order.
 */
export function activityToRow(a: Omit<Activity, "seq">): ActivityInsert {
  return {
    id: a.id,
    teamId: a.teamId,
    type: a.type,
    message: a.message,
    actor: a.actor,
    actorUserId: a.actorUserId,
    // Named only to satisfy the `Record<keyof Activity>` guard, which is what
    // makes a new field impossible to forget here. It is a display DECORATION
    // resolved from `actor_user_id` on the way out; there is no column to write.
    actorUser: undefined,
    actorProvider: a.actorProvider,
    appId: a.appId,
    databaseId: a.databaseId,
    createdAt: a.createdAt,
  } satisfies Record<keyof Omit<Activity, "seq">, unknown> as ActivityInsert;
}

/**
 * Reassemble an `activities` row into an {@link Activity}. `seq` travels with the
 * row: it is the tie-break the feed's keyset cursor pages on.
 */
export function assembleActivity(row: ActivityRow): Activity {
  return {
    id: row.id,
    seq: row.seq,
    teamId: row.teamId,
    type: row.type as ActivityType,
    message: row.message,
    actor: row.actor,
    actorUserId: row.actorUserId,
    // A DECORATION the caller batch-resolves, never a column. Null here so the
    // one shape stays honest: a list that has not looked the actor up says so.
    actorUser: null,
    actorProvider: row.actorProvider ?? null,
    appId: row.appId,
    databaseId: row.databaseId,
    createdAt: row.createdAt,
  };
}
