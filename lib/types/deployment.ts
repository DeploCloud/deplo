import type { ID, VarAuthor } from "./identity";

export const DEFAULT_LOG_RANGE_DAYS = 7;
export const MAX_LOG_RANGE_DAYS = 90;
export const MIN_LOG_RANGE_DAYS = 1;

export type DeploymentStatus =
  "queued" | "building" | "ready" | "error" | "canceled";

export type DeploymentEnvironment = "production" | "preview";

export interface Deployment {
  id: ID;
  appId: ID;
  status: DeploymentStatus;
  environment: DeploymentEnvironment;
  deployKey: string;
  previewId: ID | null;
  prNumber: number | null;
  serverId: ID | null;
  buildServerId: ID | null;
  commitSha: string;
  commitMessage: string;
  commitAuthor: string;
  branch: string;
  url: string;
  createdAt: string;
  startedAt: string | null;
  readyAt: string | null;
  buildDurationMs: number | null;
  forceRecreate: boolean;
  imageRef: string | null;
  rollbackOf: ID | null;
  creator: string;
  creatorUserId: ID | null;
  creatorUser: VarAuthor | null;
  creatorProvider: string | null;
}

export type LogLevel =
  "info" | "warn" | "error" | "debug" | "command" | "success";

export interface LogLine {
  ts: string;
  level: LogLevel;
  text: string;
}
