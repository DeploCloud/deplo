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
  engine: string | null;
  exposedPort: number | null;
  domains: string[];
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

export interface PlanServer {
  sourceId: string;
  name: string;
  ipAddress: string | null;
  cloudflare: boolean;
  deploServerId: string | null;
  deploServerName: string | null;
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
  platform: SourceKind;
  sourceUrl: string;
  orgName: string | null;
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
  at?: string | null;
}

export interface Invite {
  email: string;
  name: string;
  link: string | null;
  outcome: string;
  message: string | null;
  sourceRole: string;
  hasAccount: boolean;
  avatarUrl: string | null;
}

export interface SessionRun {
  id: string;
  teamId: string;
  teamName: string;
  teamAvatarUrl: string | null;
  orgName: string | null;
  status: string;
  created: number;
  skipped: number;
  failed: number;
  manual: number;
  error: string | null;
  members: Invite[];
}

export interface ImportRun {
  id: string;
  teamId: string;
  teamName: string;
  teamSlug: string;
  teamAvatarUrl: string | null;
  platform: SourceKind;
  sourceUrl: string;
  orgName: string | null;
  actor: string;
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
  phase?: string;
  doneSteps?: number;
  totalSteps?: number;
  stepLabel?: string | null;
  lastPath?: string | null;
  heartbeatAt?: string | null;
}

export interface TargetTeam {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface ServerChoice {
  id: string;
  name: string;
  isDeploHost?: boolean;
  buildOnly?: boolean;
}

export interface Placement {
  serverId: string;
  buildServerId: string | null;
  exposedPort?: number | null;
}

export interface MigrationProgress {
  done: number;
  total: number;
  current: string;
}

export interface PortCheck {
  checked: boolean;
  inUse: number[];
  reason: string | null;
}

export function isImportable(s: PlanService): boolean {
  return s.status !== "unsupported";
}

export function importableOf(p: PlanProject): PlanService[] {
  return p.environments.flatMap((e) => e.services.filter(isImportable));
}
