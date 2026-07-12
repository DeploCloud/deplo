import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

import {
  activities,
  devSshUser,
  githubApps,
  githubInstallation,
  servers,
} from "../db/schema/control-plane";
import type {
  Activity,
  ActivityType,
  DevSshUser,
  GithubApp,
  GithubInstallation,
  Server,
  ServerStatus,
} from "../types";

/**
 * The ONE relational-rows ↔ domain-objects mapping for the infra/integrations
 * tables (relational-store PLAN Step 6 cut-set (e)): `servers`, `github_apps`,
 * `github_installation`, `dev_ssh_user`, `activities`. Every reader and writer in
 * the data layer (`lib/data/{servers,github,dev-ssh,activity}.ts`,
 * `lib/github/app.ts`) goes through here, so reads and writes can't drift on how a
 * row folds into a domain object — the same anti-drift seam `backup-rows.ts` is
 * for the backups tables, `app-graph-rows.ts` for the project graph, and
 * `notification-row.ts` for `notification_settings`.
 *
 * Pure — no `server-only`, no store, no db handle — so a `server-only` module can
 * import it freely. Load-bearing details:
 *
 *  - **`servers` flattens two nested objects.** `ServerAgent` (present once
 *    provisioned) → `agent_*` columns, `ServerBootstrap` (present only while
 *    provisioning) → `bootstrap_*` columns. The columns are nullable; a NULL
 *    `agent_port` means "no agent yet", so {@link assembleServer} rebuilds the
 *    nested object iff its discriminant column is present. (`agentToRow` is the
 *    exact mapping the old `server-row.ts` mirror bridge wrote — that bridge is
 *    retired now that `servers` is relational-authoritative.)
 *  - **`activities` has a `seq` asymmetry.** `Activity` (the domain type) has no
 *    `seq`, but `activities` carries a DB-generated `bigint identity seq` (PLAN
 *    §5). {@link activityToRow} never writes it; {@link assembleActivity} drops it.
 *    A copy/insert in source-array order reproduces insertion order.
 */

export type ServerRow = InferSelectModel<typeof servers>;
export type ServerInsert = InferInsertModel<typeof servers>;
export type GithubAppRow = InferSelectModel<typeof githubApps>;
export type GithubAppInsert = InferInsertModel<typeof githubApps>;
export type GithubInstallationRow = InferSelectModel<typeof githubInstallation>;
export type GithubInstallationInsert = InferInsertModel<
  typeof githubInstallation
>;
export type DevSshUserRow = InferSelectModel<typeof devSshUser>;
export type DevSshUserInsert = InferInsertModel<typeof devSshUser>;
export type ActivityRow = InferSelectModel<typeof activities>;
export type ActivityInsert = InferInsertModel<typeof activities>;

/* ------------------------------------------------------------------ */
/* servers (flattens ServerAgent + ServerBootstrap)                    */
/* ------------------------------------------------------------------ */

/**
 * Which {@link Server} fields are folded into which `servers` columns. Unlike the
 * flat collections, this mapping flattens TWO nested objects (`agent`/`bootstrap`)
 * onto the row, so a `satisfies Record<keyof Server, …>` on the RETURN can't
 * express exhaustiveness (the row keys are not the `Server` keys). This explicit
 * `Record<keyof Server, true>` is the exhaustiveness guard instead: adding a new
 * `Server` field is a compile error here until it is consciously handled in
 * {@link serverToRow} (and the column or its flattening added below).
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
  deployConcurrency: true,
  createdAt: true,
  agent: true,
  bootstrap: true,
  lastSeenAt: true,
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
    createdAt: s.createdAt,
  };
}

/**
 * Reassemble a `servers` row into a {@link Server}, rebuilding the nested
 * `agent`/`bootstrap` objects from their flattened columns. The discriminant for
 * "is there an agent" is `agent_port` (NULL while provisioning); for "is there a
 * pending bootstrap" it is `bootstrap_token_hash` (NULL once provisioned).
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
  if (row.lastSeenAt !== null) server.lastSeenAt = row.lastSeenAt;
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
  } satisfies Record<keyof GithubInstallation, unknown> as GithubInstallationInsert;
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
/* dev_ssh_user                                                        */
/* ------------------------------------------------------------------ */

/** Explode a {@link DevSshUser} into its `dev_ssh_user` row. */
export function devSshUserToRow(u: DevSshUser): DevSshUserInsert {
  return {
    id: u.id,
    appId: u.appId,
    username: u.username,
    publicKey: u.publicKey,
    passwordEnc: u.passwordEnc,
    createdAt: u.createdAt,
  } satisfies Record<keyof DevSshUser, unknown> as DevSshUserInsert;
}

/** Reassemble a `dev_ssh_user` row into a {@link DevSshUser}. */
export function assembleDevSshUser(row: DevSshUserRow): DevSshUser {
  return {
    id: row.id,
    appId: row.appId,
    username: row.username,
    publicKey: row.publicKey,
    passwordEnc: row.passwordEnc,
    createdAt: row.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/* activities (history; seq asymmetry)                                 */
/* ------------------------------------------------------------------ */

/**
 * Explode an {@link Activity} into its `activities` row. NEVER writes `seq` — it
 * is a `bigint identity` the DB assigns in insertion order (PLAN §5), so a copy /
 * insert in source-array order reproduces the history's order.
 */
export function activityToRow(a: Activity): ActivityInsert {
  return {
    id: a.id,
    teamId: a.teamId,
    type: a.type,
    message: a.message,
    actor: a.actor,
    appId: a.appId,
    createdAt: a.createdAt,
  } satisfies Record<keyof Activity, unknown> as ActivityInsert;
}

/**
 * Reassemble an `activities` row into an {@link Activity}. Drops `seq` (the domain
 * object never carries it — list ordering reads it via the SQL `ORDER BY`, not the
 * returned object).
 */
export function assembleActivity(row: ActivityRow): Activity {
  return {
    id: row.id,
    teamId: row.teamId,
    type: row.type as ActivityType,
    message: row.message,
    actor: row.actor,
    appId: row.appId,
    createdAt: row.createdAt,
  };
}
