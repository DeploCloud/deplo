import type {
  HostMount,
  NamedVolume,
  SourceApplication,
  SourceCompose,
  SourceDatabase,
  SourceEnvironment,
  SourceMember,
  SourceProject,
  SourceS3Destination,
  SourceSchedule,
  SourceServer,
  SourceSharedEnv,
} from "./model";
import { coolifyClient } from "./coolify/adapter";
import { dokployClient } from "./dokploy/adapter";

export const MIGRATION_PLATFORMS = ["dokploy", "coolify"] as const;
export type MigrationPlatform = (typeof MIGRATION_PLATFORMS)[number];

export function isMigrationPlatform(v: unknown): v is MigrationPlatform {
  return (
    typeof v === "string" &&
    (MIGRATION_PLATFORMS as readonly string[]).includes(v)
  );
}

export interface SourceCredential {
  kind: MigrationPlatform;
  baseUrl: string;
  apiKey: string;
}

export interface ServiceRuntime {
  volumes: NamedVolume[];
  hostMounts: HostMount[];
  running: boolean;
  notes: string[];
  undetermined?: boolean;
}

export interface RuntimeQuery {
  kind: string;
  id: string;
  appName: string;
  serverId?: string;
  declaredVolumes: NamedVolume[];
  declaredBindMounts: HostMount[];
  composeFile: string | null;
}

export interface MigrationSourceClient {
  readonly platform: MigrationPlatform;
  readonly baseUrl: string;
  readonly displayName: string;

  assertReadable(): Promise<void>;

  listProjects(): Promise<SourceProject[]>;
  getEnvironment(id: string): Promise<SourceEnvironment | null>;
  getService(
    kind: string,
    id: string,
  ): Promise<SourceApplication | SourceCompose | SourceDatabase>;
  getResolvedCompose(id: string): Promise<string | null>;
  listServers(): Promise<SourceServer[]>;
  listMembers(): Promise<SourceMember[]>;
  sourceTeam(): Promise<{ id: string | null; name: string | null }>;
  otherTeams(): Promise<string[] | null>;
  listSchedules(kind: string, id: string): Promise<SourceSchedule[]>;
  teamSharedEnv(): Promise<SourceSharedEnv | null>;
  serverSharedEnv(sourceServerId: string): Promise<SourceSharedEnv | null>;
  listBackupDestinations(): Promise<SourceS3Destination[]>;

  serviceRuntime(svc: RuntimeQuery): Promise<ServiceRuntime>;

  stopService(kind: string, id: string): Promise<void>;

  startService(kind: string, id: string): Promise<void>;

  platformNetworks(svc: { kind: string; id: string }): string[];
}

export class StopAcceptedError extends Error {}

export function sourceClient(c: SourceCredential): MigrationSourceClient {
  return c.kind === "coolify" ? coolifyClient(c) : dokployClient(c);
}
