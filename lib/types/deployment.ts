import type { ID, VarAuthor } from "./identity";

// DEFAULT_LOG_RANGE_DAYS - how far back the log viewer reaches out of the box;
// MAX/MIN bound what an instance admin may raise it to.
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
  // The host-side KEY this deploy owns: the container `deplo-<key>`, the stack
  // file `<key>.yml`, the files dir `files/<key>`, the named volumes
  // `deplo-<key>-<name>` and every agent RPC.
  deployKey: string;
  // The pull request preview this deploy belongs to, or null for production.
  previewId: ID | null;
  // Denormalized PR number, so the list can still say "PR #42" after the preview
  // row is reaped. Null for production.
  prNumber: number | null;
  // The server this deploy runs on. Denormalized so the queue can drain
  // per-server, and load-bearing beyond that: a preview may be pinned to a
  // different machine than production.
  serverId: ID | null;
  // The server this deploy BUILT on, when that was not `serverId`. null is
  // "built where it runs", which is also every row predating build servers.
  buildServerId: ID | null;
  commitSha: string;
  commitMessage: string;
  commitAuthor: string;
  branch: string;
  url: string;
  createdAt: string;
  // When the build was claimed off the queue and actually started - the origin
  // `buildDurationMs` is measured from. Null while queued.
  startedAt: string | null;
  readyAt: string | null;
  buildDurationMs: number | null;
  // Replace the running containers even if the rendered stack is unchanged
  // (`compose up --force-recreate`).
  forceRecreate: boolean;
  // The image tag this deploy rendered into its stack and the agent ran.
  imageRef: string | null;
  // Set when this deploy is a ROLLBACK: the deployment whose image it re-ran.
  // Null ⇒ it built its own image, which is also what decides whether it occupies
  // a retention slot.
  rollbackOf: ID | null;
  creator: string;
  // The account behind {@link creator}. NULL for a webhook push and for every row
  // written before it existed - both render the bare string.
  creatorUserId: ID | null;
  // That person, resolved for display. A DECORATION the list batch-resolves.
  creatorUser: VarAuthor | null;
  // The git host {@link creator} is a login on, set only by a webhook push.
  // Null ⇒ somebody with an account here, drawn with their own avatar.
  creatorProvider: string | null;
}

export type LogLevel =
  "info" | "warn" | "error" | "debug" | "command" | "success";

export interface LogLine {
  ts: string;
  level: LogLevel;
  text: string;
}
