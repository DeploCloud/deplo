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

export interface PlanServer {
  sourceId: string;
  name: string;
  ipAddress: string | null;
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
}

/** A service Deplo has no equivalent for cannot be picked, so it never counts. */
export function isImportable(s: PlanService): boolean {
  return s.status !== "unsupported";
}

/** Every service under a project that could be ticked. */
export function importableOf(p: PlanProject): PlanService[] {
  return p.environments.flatMap((e) => e.services.filter(isImportable));
}
