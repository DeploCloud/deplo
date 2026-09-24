import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

import { activities } from "../db/schema/control-plane/activity";
import {
  githubApps,
  githubInstallation,
} from "../db/schema/control-plane/integrations";
import { servers } from "../db/schema/control-plane/servers";
import type { Activity, ActivityType } from "../types/activity";
import type { GithubApp, GithubInstallation } from "../types/git";
import type { Server, ServerStatus } from "../types/server";

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
  allTeams: true,
  storageOnly: true,
  buildOnly: true,
  importOnly: true,
  uninstallPending: true,
  uninstallError: true,
  buildFallback: true,
  hostArch: true,
  deployConcurrency: true,
  agentCanary: true,
  createdAt: true,
  agent: true,
  bootstrap: true,
  lastSeenAt: true,
  statusCheckedAt: true,
  statusMessage: true,
} satisfies Record<keyof Server, true>;
void SERVER_FIELDS;

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
    allTeams: s.allTeams,
    storageOnly: s.storageOnly,
    buildOnly: s.buildOnly,
    buildFallback: s.buildFallback,
    importOnly: s.importOnly,
    uninstallError: s.uninstallError,
    hostArch: s.hostArch,
    deployConcurrency: s.deployConcurrency,
    agentCanary: s.agentCanary,
    agentPort: s.agent?.port ?? null,
    agentCertFingerprint: s.agent?.certFingerprint ?? null,
    agentCertPem: s.agent?.certPem ?? null,
    agentVersion: s.agent?.version ?? null,
    bootstrapTokenHash: s.bootstrap?.tokenHash ?? null,
    bootstrapExpiresAt: s.bootstrap?.expiresAt ?? null,
    bootstrapUsedAt: s.bootstrap?.usedAt ?? null,
    lastSeenAt: s.lastSeenAt ?? null,
    statusCheckedAt: s.statusCheckedAt ?? null,
    statusMessage: s.statusMessage ?? null,
    createdAt: s.createdAt,
  };
}

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
    allTeams: row.allTeams,
    storageOnly: row.storageOnly ?? false,
    buildOnly: row.buildOnly ?? false,
    buildFallback: row.buildFallback ?? null,
    importOnly: row.importOnly ?? false,
    uninstallPending: row.uninstallNextAt !== null,
    uninstallError: row.uninstallError ?? "",
    hostArch: row.hostArch ?? "",
    deployConcurrency: row.deployConcurrency ?? 1,
    agentCanary: row.agentCanary ?? false,
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
  if (row.statusCheckedAt !== null)
    server.statusCheckedAt = row.statusCheckedAt;
  if (row.statusMessage !== null) server.statusMessage = row.statusMessage;
  return server;
}

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

export function activityToRow(a: Omit<Activity, "seq">): ActivityInsert {
  return {
    id: a.id,
    teamId: a.teamId,
    type: a.type,
    message: a.message,
    actor: a.actor,
    actorUserId: a.actorUserId,
    actorUser: undefined,
    actorProvider: a.actorProvider,
    appId: a.appId,
    databaseId: a.databaseId,
    createdAt: a.createdAt,
  } satisfies Record<keyof Omit<Activity, "seq">, unknown> as ActivityInsert;
}

export function assembleActivity(row: ActivityRow): Activity {
  return {
    id: row.id,
    seq: row.seq,
    teamId: row.teamId,
    type: row.type as ActivityType,
    message: row.message,
    actor: row.actor,
    actorUserId: row.actorUserId,
    actorUser: null,
    actorProvider: row.actorProvider ?? null,
    appId: row.appId,
    databaseId: row.databaseId,
    createdAt: row.createdAt,
  };
}
