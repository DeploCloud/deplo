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
import { deploClient } from "./deplo/adapter";
import { dokployClient } from "./dokploy/adapter";

export const MIGRATION_PLATFORMS = ["dokploy", "coolify", "deplo"] as const;
export type MigrationPlatform = (typeof MIGRATION_PLATFORMS)[number];

// The panels a Deplo install can take over on their own machine. Another Deplo is not one of them.
export const TAKEOVER_PLATFORMS = ["dokploy", "coolify"] as const;
export type TakeoverPlatform = (typeof TAKEOVER_PLATFORMS)[number];

export function isTakeoverPlatform(v: unknown): v is TakeoverPlatform {
  return (
    typeof v === "string" &&
    (TAKEOVER_PLATFORMS as readonly string[]).includes(v)
  );
}

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

export interface SourceDataExport {
  check(
    svc: { kind: string; id: string },
    volumes: string[],
  ): Promise<{ reachable: boolean; present: string[] | null }>;
  exportVolume(
    svc: { kind: string; id: string },
    name: string,
  ): AsyncIterable<Buffer>;
  exportHostPath(
    svc: { kind: string; id: string },
    path: string,
    allowFile?: boolean,
  ): AsyncIterable<Buffer>;
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

  // Set when the source panel hands its data over itself, so no agent goes on its machines (ADR-0034).
  readonly dataExport?: SourceDataExport;
}

export class StopAcceptedError extends Error {}

export function sourceClient(c: SourceCredential): MigrationSourceClient {
  if (c.kind === "deplo") return deploClient(c);
  return c.kind === "coolify" ? coolifyClient(c) : dokployClient(c);
}
