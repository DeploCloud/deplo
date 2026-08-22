/**
 * The wire shapes the import wizard reads, mirroring the DTOs in
 * `lib/data/dokploy-import.ts`.
 *
 * Hand-written on purpose - there is no codegen here - and kept in one file so
 * the wizard, the tree and the progress dialog agree on them. Adding a field is
 * still three edits: the data-layer DTO, the Pothos ref, and here plus the
 * query's selection set.
 */

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
}

export interface PlanMember {
  email: string;
  name: string;
  sourceRole: string;
  hasAccount: boolean;
  inTeam: boolean;
}

export interface Plan {
  sourceUrl: string;
  orgName: string | null;
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
  sourceUrl: string;
  orgName: string | null;
  actor: string;
  status: string;
  created: number;
  skipped: number;
  failed: number;
  manual: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
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
