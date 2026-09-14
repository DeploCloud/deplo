import type { ID, VarAuthor } from "./identity";

export type ActivityType =
  | "deployment"
  | "app"
  | "project"
  | "database"
  | "domain"
  | "env"
  // People: members, roles, access grants, team settings and ownership.
  | "member"
  // Credentials: API tokens, passkeys, and the two-factor policy.
  | "security"
  // Hosts: the fleet, the server agent, maintenance and TLS certificates.
  | "server"
  // Third-party connections: git providers, the GitHub App, image registries.
  | "integration"
  // Instance-wide settings, and what Deplo reports about itself.
  | "instance"
  | "backup"
  | "s3"
  // Cron jobs: a job created, edited, run or deleted.
  | "cron"
  // Docker cleanup: a policy change, or a sweep that reclaimed disk on a server.
  | "cleanup"
  // Monitoring: a settings change (e.g. the "save metrics on server" switch).
  | "monitoring"
  // MCP: who let AI agents into this team, and when. "An agent deleted it" must
  // never be a dead end - the trail names the human who opened the door.
  | "mcp";

export interface Activity {
  id: ID;
  // The database's insert order. It breaks a same-timestamp tie for both the
  // feed's ORDER BY and its keyset cursor, so it travels with the row.
  seq: number;
  teamId: ID;
  type: ActivityType;
  message: string;
  actor: string;
  // The human behind `actor`, when there is one. `actor` is free text and also
  // carries non-human actors ("system" / "github"), which must NEVER be
  // attributed to a person - those stay `null`, as do rows predating the column.
  actorUserId: ID | null;
  // That person's identity, resolved for display.
  actorUser: VarAuthor | null;
  // The git host {@link actor} is a login on, set only by a webhook push. Null ⇒
  // a person here, or an actor with no host at all (`system`).
  actorProvider: string | null;
  appId: ID | null;
  // The database this happened to. A database is not an App, so it needs its own
  // pointer; both are null for a team-level event.
  databaseId: ID | null;
  createdAt: string;
}
