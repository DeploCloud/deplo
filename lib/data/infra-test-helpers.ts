import { activities as activitiesTable } from "../db/schema/control-plane/activity";
import {
  githubApps as githubAppsTable,
  githubInstallation as githubInstallationTable,
} from "../db/schema/control-plane/integrations";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import {
  activityToRow,
  githubAppToRow,
  githubInstallationToRow,
  serverToRow,
} from "./infra-rows";
import type { TestDb } from "../db/test-harness";
import type { Activity, ActivityType } from "../types/activity";
import type { GithubApp, GithubInstallation } from "../types/git";
import type { Server } from "../types/server";

const T0 = "2026-01-01T00:00:00.000Z";

export const TRUNCATE_INFRA = `truncate table
  activities, github_installation, github_apps, servers
  restart identity cascade;`;

export function makeServer(opts: Partial<Server> & { id: string }): Server {
  return {
    id: opts.id,
    name: opts.name ?? opts.id,
    host: opts.host ?? "10.0.0.1",
    type: "remote",
    status: opts.status ?? "online",
    ip: opts.ip ?? "10.0.0.1",
    dockerVersion: opts.dockerVersion ?? "27",
    traefikEnabled: opts.traefikEnabled ?? true,
    cpuCores: opts.cpuCores ?? 4,
    memoryMb: opts.memoryMb ?? 8192,
    diskGb: opts.diskGb ?? 100,
    allTeams: opts.allTeams ?? true,
    storageOnly: opts.storageOnly ?? false,
    buildOnly: opts.buildOnly ?? false,
    buildFallback: opts.buildFallback ?? null,
    importOnly: opts.importOnly ?? false,
    uninstallPending: opts.uninstallPending ?? false,
    uninstallError: opts.uninstallError ?? "",
    hostArch: opts.hostArch ?? "amd64",
    deployConcurrency: opts.deployConcurrency ?? 1,
    createdAt: opts.createdAt ?? T0,
    agent: opts.agent,
    bootstrap: opts.bootstrap,
    lastSeenAt: opts.lastSeenAt,
    statusCheckedAt: opts.statusCheckedAt,
    statusMessage: opts.statusMessage,
  };
}

export async function seedServerRow(
  db: TestDb,
  opts: Partial<Server> & { id: string },
): Promise<Server> {
  const server = makeServer(opts);
  await db
    .insert(serversTable)
    .values(serverToRow(server))
    .onConflictDoNothing();
  return server;
}

export async function seedGithubApp(
  db: TestDb,
  opts: Partial<GithubApp> & { id: string; teamId: string },
): Promise<GithubApp> {
  const app: GithubApp = {
    id: opts.id,
    teamId: opts.teamId,
    appId: opts.appId ?? 1000,
    slug: opts.slug ?? opts.id,
    name: opts.name ?? opts.id,
    clientId: opts.clientId ?? "client",
    clientSecretEnc: opts.clientSecretEnc ?? "cs_enc",
    webhookSecretEnc: opts.webhookSecretEnc ?? "ws_enc",
    privateKeyEnc: opts.privateKeyEnc ?? "pk_enc",
    htmlUrl: opts.htmlUrl ?? "https://github.com/apps/x",
    createdAt: opts.createdAt ?? T0,
  };
  await db.insert(githubAppsTable).values(githubAppToRow(app));
  return app;
}

export async function seedGithubInstallation(
  db: TestDb,
  opts: Partial<GithubInstallation> & { id: string; appId: string },
): Promise<GithubInstallation> {
  const install: GithubInstallation = {
    id: opts.id,
    appId: opts.appId,
    installationId: opts.installationId ?? 5000,
    accountLogin: opts.accountLogin ?? "acct",
    accountType: opts.accountType ?? "Organization",
    avatarUrl: opts.avatarUrl ?? "https://avatars/x",
    createdAt: opts.createdAt ?? T0,
  };
  await db
    .insert(githubInstallationTable)
    .values(githubInstallationToRow(install));
  return install;
}

export async function seedActivity(
  db: TestDb,
  opts: Partial<Activity> & { id: string; teamId: string },
): Promise<Omit<Activity, "seq">> {
  const a: Omit<Activity, "seq"> = {
    id: opts.id,
    teamId: opts.teamId,
    type: (opts.type ?? "app") as ActivityType,
    message: opts.message ?? "did a thing",
    actor: opts.actor ?? "owner",
    actorUser: opts.actorUser ?? null,
    actorUserId: opts.actorUserId ?? null,
    actorProvider: opts.actorProvider ?? null,
    appId: opts.appId ?? null,
    databaseId: opts.databaseId ?? null,
    createdAt: opts.createdAt ?? T0,
  };
  await db.insert(activitiesTable).values(activityToRow(a));
  return a;
}
