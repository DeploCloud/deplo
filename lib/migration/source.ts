/**
 * One source panel, whichever product it is.
 *
 * The importer and the mappers speak only this: an adapter turns its own API into
 * the row shapes in `./model`, and nothing above the seam learns which panel it is
 * reading. See https://deplo.build/docs/guides/move-from-dokploy
 */

import type {
  HostMount,
  NamedVolume,
  SourceApplication,
  SourceCompose,
  SourceDatabase,
  SourceEnvironment,
  SourceMember,
  SourceProject,
  SourceSchedule,
  SourceServer,
} from "./model";
import { dokployClient } from "./dokploy/adapter";

/** The products Deplo migrates from. Anything else is refused by that name. */
export const MIGRATION_PLATFORMS = ["dokploy", "coolify"] as const;
export type MigrationPlatform = (typeof MIGRATION_PLATFORMS)[number];

export function isMigrationPlatform(v: unknown): v is MigrationPlatform {
  return (
    typeof v === "string" &&
    (MIGRATION_PLATFORMS as readonly string[]).includes(v)
  );
}

/** A source panel and the credential that reads it. */
export interface SourceCredential {
  kind: MigrationPlatform;
  /** Origin with no trailing slash and no `/api`, e.g. https://panel.acme.com. */
  baseUrl: string;
  /** The panel's API key or token. Each adapter knows which header it rides in. */
  apiKey: string;
}

/** What a service mounts right now, and whether it is still up. */
export interface ServiceRuntime {
  volumes: NamedVolume[];
  hostMounts: HostMount[];
  running: boolean;
  notes: string[];
}

/** What `serviceRuntime` is asked about: enough to answer without the panel when
 *  the service is stopped, which is the normal state of one being left behind. */
export interface RuntimeQuery {
  kind: string;
  id: string;
  appName: string;
  declaredVolumes: NamedVolume[];
  declaredBindMounts: HostMount[];
}

export interface MigrationSourceClient {
  readonly platform: MigrationPlatform;
  readonly baseUrl: string;
  /** The platform's name, for a report line a person reads. */
  readonly displayName: string;

  listProjects(): Promise<SourceProject[]>;
  getEnvironment(id: string): Promise<SourceEnvironment | null>;
  getService(
    kind: string,
    id: string,
  ): Promise<SourceApplication | SourceCompose | SourceDatabase>;
  /** The compose the panel resolved, when the YAML lives in a repository. */
  getResolvedCompose(id: string): Promise<string | null>;
  listServers(): Promise<SourceServer[]>;
  listMembers(): Promise<SourceMember[]>;
  organizationName(): Promise<string | null>;
  listSchedules(kind: string, id: string): Promise<SourceSchedule[]>;

  /**
   * What a service mounts right now. Dokploy answers by inspecting containers,
   * Coolify by reading its own storage rows - which is why this is a method and
   * not a function over one shape of API.
   */
  serviceRuntime(svc: RuntimeQuery): Promise<ServiceRuntime>;

  /**
   * Stop it over there, and do NOT return while it is still running: a volume read
   * while its container writes cannot be trusted. This is the point of no return.
   */
  stopService(kind: string, id: string): Promise<void>;

  /** The platform's own networks to take out of THIS service's compose. Fixed for
   *  Dokploy, per-resource for Coolify. */
  platformNetworks(svc: { kind: string; id: string }): string[];
}

/** The client for one panel. The only place a platform is turned into code. */
export function sourceClient(c: SourceCredential): MigrationSourceClient {
  if (c.kind === "coolify")
    throw new Error(
      "Deplo can recognise a Coolify panel but cannot import from one yet.",
    );
  return dokployClient(c);
}
