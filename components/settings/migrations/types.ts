/**
 * The wire shapes the import wizard reads, mirroring the DTOs in
 * `lib/data/migration-import.ts`.
 */

import type { SourceKind } from "./sources";

export type { SourceKind };

export interface PlanService {
  sourceId: string;
  kind: string;
  name: string;
  targetKind: string | null;
  status: "new" | "exists" | "unsupported" | "needs_grant";
  sourceServerId: string;
  buildsFromSource: boolean;
  /** Deplo's engine id for a database, for its brand mark. Null otherwise. */
  engine: string | null;
  /**
   * The host port this database publishes on Dokploy. Null for anything else,
   * and null throughout when the person importing cannot publish ports at all -
   * which is why the review can just read this and never has to ask twice.
   */
  exposedPort: number | null;
  domains: string[];
  /** The icon it would arrive with, inline, or null when it has none. */
  logo: string | null;
  notes: string[];
}

export interface PlanEnvironment {
  sourceId: string;
  name: string;
  exists: boolean;
  services: PlanService[];
}

export interface PlanProject {
  sourceId: string;
  name: string;
  exists: boolean;
  environments: PlanEnvironment[];
}

/** One machine behind the source instance; the first is its own host (`""`). */
export interface PlanServer {
  sourceId: string;
  name: string;
  ipAddress: string | null;
  /** The Deplo server at that address, or null when Deplo has no agent there. */
  deploServerId: string | null;
  deploServerName: string | null;
  /** Whether that server's agent answers. A row a failed attempt left behind sits
   *  at the same address and is matched all the same. */
  deploServerOnline: boolean;
}

export interface PlanMember {
  email: string;
  name: string;
  sourceRole: string;
  hasAccount: boolean;
  avatarUrl: string | null;
  avatarColor: string | null;
  inTeam: boolean;
}

export interface Plan {
  /** Which product answered. The wizard names it instead of asking. */
  platform: SourceKind;
  sourceUrl: string;
  orgName: string | null;
  /** The panel's other teams, for the line that names the ones no token covers.
   *  Null when the panel cannot say - see `./queue`. */
  otherTeams: string[] | null;
  projects: PlanProject[];
  servers: PlanServer[];
  members: PlanMember[];
}

export interface ReportItem {
  path: string;
  sourceKind: string;
  sourceName: string;
  outcome: string;
  targetKind: string | null;
  targetId: string | null;
  message: string | null;
  /** When it happened. Null on rows written before the report became a log. */
  at?: string | null;
}

export interface Invite {
  email: string;
  name: string;
  link: string | null;
  outcome: string;
  message: string | null;
}

export interface ImportRun {
  id: string;
  /** Which product this run read. */
  platform: SourceKind;
  sourceUrl: string;
  orgName: string | null;
  actor: string;
  /** The actor's picture and monogram colour - nulls for a run whose starter has
   *  no account here any more. */
  actorUsername: string | null;
  actorAvatarUrl: string | null;
  actorAvatarColor: string | null;
  status: string;
  created: number;
  skipped: number;
  failed: number;
  manual: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /**
   * Where the run had got to, as the server last wrote it down. Filled on the
   * run the wizard OPENS on, so the panel is right on the first paint instead of
   * waiting for the live feed to connect; the history list leaves them out.
   */
  phase?: string;
  doneSteps?: number;
  totalSteps?: number;
  stepLabel?: string | null;
  lastPath?: string | null;
  /** When whatever is driving it last said so - null while nothing has. */
  heartbeatAt?: string | null;
}

/** What a revert took back out of Deplo, and what it could not. */
export interface RevertResult {
  apps: number;
  databases: number;
  environments: number;
  projects: number;
  sharedVars: number;
  /** One line per thing that is still here, and why. */
  failed: string[];
}

/** A team the migration could land in - the viewer may create projects in each. */
export interface TargetTeam {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/** A server a picker offers. `isDeploHost` marks the machine Deplo itself runs on. */
export interface ServerChoice {
  id: string;
  name: string;
  isDeploHost?: boolean;
  /** Build pickers only: a host that compiles for others and runs nothing. */
  buildOnly?: boolean;
}

/** Where one service lands. `buildServerId` null is Automatic. */
export interface Placement {
  serverId: string;
  buildServerId: string | null;
  /**
   * A database's host port. `undefined` keeps the one it had on Dokploy, `null`
   * publishes none, a number publishes there instead. Only ever set for a
   * database whose port the review had something to say about.
   */
  exposedPort?: number | null;
}

/** How far the panel thinks the run has got. */
export interface MigrationProgress {
  done: number;
  total: number;
  current: string;
}

/** A server's answer to "are these host ports free?" - see `hostPortsInUse`. */
export interface PortCheck {
  checked: boolean;
  inUse: number[];
  reason: string | null;
}

/** A service Deplo has no equivalent for cannot be picked, so it never counts. */
export function isImportable(s: PlanService): boolean {
  return s.status !== "unsupported";
}

/** Every service under a project that could be ticked. */
export function importableOf(p: PlanProject): PlanService[] {
  return p.environments.flatMap((e) => e.services.filter(isImportable));
}
