import type { ID, VarAuthor } from "./identity";

export type ActivityType =
  | "deployment"
  | "app"
  | "project"
  | "database"
  | "domain"
  | "env"
  | "member"
  | "security"
  | "server"
  | "integration"
  | "instance"
  | "backup"
  | "s3"
  | "cron"
  | "cleanup"
  | "monitoring"
  | "mcp";

export interface Activity {
  id: ID;
  seq: number;
  teamId: ID;
  type: ActivityType;
  message: string;
  actor: string;
  actorUserId: ID | null;
  actorUser: VarAuthor | null;
  actorProvider: string | null;
  appId: ID | null;
  databaseId: ID | null;
  createdAt: string;
}
