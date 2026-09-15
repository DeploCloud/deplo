import "server-only";

import type { Deployment, LogLine } from "../../types/deployment";
import type {
  deployments,
  deploymentLogs,
} from "../../db/schema/control-plane/deployments";

export type DeploymentRow = typeof deployments.$inferSelect;
export type DeploymentLogRow = typeof deploymentLogs.$inferSelect;

export function assembleDeployment(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    appId: row.appId,
    status: row.status as Deployment["status"],
    environment: row.environment as Deployment["environment"],
    deployKey: row.deployKey,
    previewId: row.previewId,
    prNumber: row.prNumber,
    serverId: row.serverId,
    buildServerId: row.buildServerId ?? null,
    commitSha: row.commitSha,
    commitMessage: row.commitMessage,
    commitAuthor: row.commitAuthor,
    branch: row.branch,
    url: row.url,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    readyAt: row.readyAt,
    buildDurationMs: row.buildDurationMs,
    forceRecreate: row.forceRecreate,
    imageRef: row.imageRef,
    rollbackOf: row.rollbackOf,
    creator: row.creator,
    creatorUserId: row.creatorUserId ?? null,
    creatorUser: null,
    creatorProvider: row.creatorProvider ?? null,
  };
}

export function deploymentToRow(
  d: Deployment,
): typeof deployments.$inferInsert {
  return {
    id: d.id,
    appId: d.appId,
    status: d.status,
    environment: d.environment,
    deployKey: d.deployKey,
    previewId: d.previewId ?? null,
    prNumber: d.prNumber ?? null,
    commitSha: d.commitSha,
    commitMessage: d.commitMessage,
    commitAuthor: d.commitAuthor,
    branch: d.branch,
    url: d.url,
    startedAt: d.startedAt ?? null,
    readyAt: d.readyAt ?? null,
    buildDurationMs: d.buildDurationMs ?? null,
    forceRecreate: d.forceRecreate ?? false,
    imageRef: d.imageRef ?? null,
    rollbackOf: d.rollbackOf ?? null,
    creator: d.creator,
    creatorUserId: d.creatorUserId ?? null,
    creatorProvider: d.creatorProvider ?? null,
    createdAt: d.createdAt,
  };
}

export function assembleLogLine(row: DeploymentLogRow): LogLine {
  return { ts: row.ts, level: row.level, text: row.text };
}

export function logLineToRow(
  deploymentId: string,
  line: LogLine,
): typeof deploymentLogs.$inferInsert {
  return {
    deploymentId,
    ts: line.ts,
    level: line.level,
    text: line.text,
  };
}
