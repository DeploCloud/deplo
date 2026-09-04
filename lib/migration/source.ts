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
  SourceS3Destination,
  SourceSchedule,
  SourceServer,
} from "./model";
import { coolifyClient } from "./coolify/adapter";
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
  /**
   * Deplo could not find out what this service mounts - no live container AND
   * nothing declared. NOT the same fact as "it mounts nothing", which is why the
   * report calls this one a decision for a person rather than a clean skip.
   */
  undetermined?: boolean;
}

/** What `serviceRuntime` is asked about: enough to answer without the panel when
 *  the service is stopped, which is the normal state of one being left behind. */
export interface RuntimeQuery {
  kind: string;
  id: string;
  appName: string;
  /** The panel's own id for the machine it runs on; empty for the panel's host.
   *  Dokploy inspects containers on THAT machine only when told which one. */
  serverId?: string;
  declaredVolumes: NamedVolume[];
  declaredBindMounts: HostMount[];
  /** The stack's own YAML, which is the only place a volume's real name is
   *  written when the file pins one. Null for anything that is not a stack. */
  composeFile: string | null;
}

export interface MigrationSourceClient {
  readonly platform: MigrationPlatform;
  readonly baseUrl: string;
  /** The platform's name, for a report line a person reads. */
  readonly displayName: string;

  /**
   * Refuse NOW if this credential cannot read what an import needs. Coolify hides
   * every variable value and every database password from a token without
   * `read:sensitive`, and it hides them SILENTLY - the apps would land with empty
   * variables and look like a migration that worked.
   */
  assertReadable(): Promise<void>;

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
  /**
   * The one team this credential reads. `id` is what tells two tokens of the same
   * team apart from two tokens of two teams; every part is null when the panel
   * would not say. `avatarUrl` is its picture over there, for the wizard to draw.
   */
  sourceTeam(): Promise<{
    id: string | null;
    name: string | null;
    avatarUrl: string | null;
  }>;
  /**
   * The teams on this panel this credential does NOT cover, by name, or null when
   * the panel cannot say - Coolify filters `/v1/teams` down to the token's own
   * team, so there it is never a list and the wizard has to ask.
   */
  otherTeams(): Promise<string[] | null>;
  listSchedules(kind: string, id: string): Promise<SourceSchedule[]>;
  /**
   * The panel's TEAM-level shared variables as a `KEY=value` blob, or null when it
   * has no such level. Project and environment ones ride on the tree. THROWS when
   * the level exists and the panel would not answer: an empty answer and a refused
   * one are not the same fact, and the caller has to say which it was.
   */
  teamSharedEnv(): Promise<string | null>;
  /**
   * The panel's SERVER-level shared variables for one source machine, same shape
   * and the same contract. `null` when the platform has no such level.
   */
  serverSharedEnv(sourceServerId: string): Promise<string | null>;
  /** The S3 stores the panel backs up to, with their credentials. Empty when the
   *  platform keeps none, or when this credential may not read them. */
  listBackupDestinations(): Promise<SourceS3Destination[]>;

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

  /**
   * Start it again over there. The ONE case Deplo writes to a platform it is
   * leaving: an operator backing out of a takeover, whose services this migration
   * is the reason are stopped.
   */
  startService(kind: string, id: string): Promise<void>;

  /** The platform's own networks to take out of THIS service's compose. Fixed for
   *  Dokploy, per-resource for Coolify. */
  platformNetworks(svc: { kind: string; id: string }): string[];
}

/** The client for one panel. The only place a platform is turned into code. */
/**
 * The panel ACCEPTED the stop and still reported the service running when the
 * wait ran out. Deplo did ask for that stop, so whoever backs out has to undo it.
 */
export class StopAcceptedError extends Error {}

export function sourceClient(c: SourceCredential): MigrationSourceClient {
  return c.kind === "coolify" ? coolifyClient(c) : dokployClient(c);
}

/**
 * A source team's picture, as far as it can be trusted into an `<img>`: the panel
 * is a third party, and this is the one string of its answer a browser fetches.
 * Dokploy's uploader writes a data URI; a person may also type an address.
 */
export function teamAvatarUrl(v: string | null | undefined): string | null {
  const s = v?.trim();
  if (!s || s.length > 1_000_000) return null;
  const ok =
    /^https?:\/\/./i.test(s) ||
    /^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i.test(s);
  return ok ? s : null;
}
