import { builder } from "../../builder";
import { VarAuthorRef } from "../env";
import { DeploymentStatusEnum, DeploymentEnvironmentEnum } from "../enums";
import {
  getLogs,
  getQueuePosition,
} from "@/lib/data/deployments/build-progress";
import { canRollbackTo } from "@/lib/data/deployments/rollback";
import type { Deployment, LogLine } from "@/lib/types/deployment";

const LogLineRef = builder.objectRef<LogLine>("LogLine").implement({
  fields: (t) => ({
    ts: t.exposeString("ts"),
    level: t.exposeString("level"),
    text: t.exposeString("text"),
  }),
});

export const DeploymentRef = builder
  .objectRef<Deployment & { canRollback?: boolean }>("Deployment")
  .implement({
    description: "A single build + release of an app.",
    fields: (t) => ({
      id: t.exposeID("id"),
      appId: t.exposeID("appId"),
      status: t.field({ type: DeploymentStatusEnum, resolve: (d) => d.status }),
      environment: t.field({
        type: DeploymentEnvironmentEnum,
        resolve: (d) => d.environment,
      }),
      previewId: t.exposeID("previewId", {
        nullable: true,
        description:
          "The pull request preview this build belongs to, or null for production.",
      }),
      prNumber: t.exposeInt("prNumber", {
        nullable: true,
        description:
          "The pull request number, denormalized so it survives the preview " +
          "itself being reaped. Null for a production build.",
      }),
      deployKey: t.exposeString("deployKey", {
        description:
          "The stack this build owns: the app slug for production, " +
          "`<slug>__pr-<n>` for a pull request preview.",
      }),
      commitSha: t.exposeString("commitSha"),
      commitMessage: t.exposeString("commitMessage"),
      commitAuthor: t.exposeString("commitAuthor"),
      branch: t.exposeString("branch"),
      url: t.exposeString("url"),
      createdAt: t.exposeString("createdAt"),
      startedAt: t.exposeString("startedAt", {
        nullable: true,
        description:
          "When the build was claimed off the queue and started running - the " +
          "origin `buildDurationMs` is measured from, and what a live build " +
          "timer counts up from. Null while still queued.",
      }),
      readyAt: t.exposeString("readyAt", { nullable: true }),
      buildDurationMs: t.exposeInt("buildDurationMs", { nullable: true }),
      creator: t.exposeString("creator"),
      creatorUser: t.field({
        type: VarAuthorRef,
        nullable: true,
        resolve: (d) => d.creatorUser,
      }),
      creatorProvider: t.exposeString("creatorProvider", {
        nullable: true,
        description:
          "The git host `creator` is a login on, when a webhook push started " +
          "this build (`github`, `gitlab`, `bitbucket`, `gitea`). Null when " +
          "somebody on this instance ran it.",
      }),
      rollbackOf: t.exposeID("rollbackOf", {
        nullable: true,
        description:
          "Set when this deploy was a rollback: the deployment whose image it " +
          "re-ran. Null when it built its own.",
      }),
      canRollback: t.field({
        type: "Boolean",
        description:
          "This app can be put back on this deployment: it succeeded, it built " +
          "an image, that image is still on the app's current server, and it is " +
          "not the one already running.",
        resolve: (d) =>
          d.canRollback !== undefined ? d.canRollback : canRollbackTo(d),
      }),
      logs: t.field({
        type: [LogLineRef],
        authScopes: { capability: "view_logs" },
        description:
          "Build logs for this deployment (most recent lines, capped).",
        resolve: (d) => getLogs(d.id).then((lines) => lines.slice(-5000)),
      }),
      queuePosition: t.field({
        type: "Int",
        nullable: true,
        description:
          "1-based position in the owning server's build queue while this " +
          "deployment is `queued` (1 = next to build); null once it starts " +
          "building or finishes.",
        resolve: (d) => getQueuePosition(d.id),
      }),
    }),
  });
