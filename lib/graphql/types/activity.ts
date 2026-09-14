import { builder } from "../builder";
import { VarAuthorRef } from "./env";
import { listActivity } from "@/lib/data/activity";
import type { Activity, ActivityType } from "@/lib/types/activity";

const ActivityTypeEnum = builder.enumType("ActivityType", {
  values: [
    "deployment",
    "app",
    "project",
    "database",
    "domain",
    "env",
    "member",
    "security",
    "server",
    "integration",
    "instance",
    "backup",
    "s3",
    "cron",
    "cleanup",
    "monitoring",
    "mcp",
  ] as const,
});

const ActivityRef = builder.objectRef<Activity>("Activity").implement({
  description: "A single audit-log event in the active team's timeline.",
  fields: (t) => ({
    id: t.exposeID("id"),
    teamId: t.exposeID("teamId"),
    type: t.field({ type: ActivityTypeEnum, resolve: (a) => a.type }),
    message: t.exposeString("message"),
    actor: t.exposeString("actor"),
    actorUserId: t.exposeID("actorUserId", { nullable: true }),
    actorUser: t.field({
      type: VarAuthorRef,
      nullable: true,
      resolve: (a) => a.actorUser,
    }),
    actorProvider: t.exposeString("actorProvider", {
      nullable: true,
      description:
        "The git host `actor` is a login on, when a webhook push wrote this " +
        "row (`github`, `gitlab`, `bitbucket`, `gitea`). Null for a person on " +
        "this instance and for an actor with no host, like `system`.",
    }),
    appId: t.exposeID("appId", { nullable: true }),
    databaseId: t.exposeID("databaseId", { nullable: true }),
    createdAt: t.exposeString("createdAt"),
    // Opaque keyset position: not `seq` as an Int, because a GraphQL Int is 32 bits.
    cursor: t.string({ resolve: (a) => `${a.createdAt}|${a.seq}` }),
  }),
});

function parseCursor(
  cursor: string | null | undefined,
): { createdAt: string; seq: number } | undefined {
  if (!cursor) return undefined;
  const at = cursor.lastIndexOf("|");
  const seq = Number(cursor.slice(at + 1));
  if (at < 1 || !Number.isSafeInteger(seq)) return undefined;
  return { createdAt: cursor.slice(0, at), seq };
}

builder.queryFields((t) => ({
  activity: t.field({
    type: [ActivityRef],
    authScopes: { capability: "view_activity" },
    description: "Recent activity in the active team, newest first.",
    args: {
      limit: t.arg.int({ required: false }),
      cursor: t.arg.string({ required: false }),
      actorUserIds: t.arg.idList({ required: false }),
      types: t.arg({ type: [ActivityTypeEnum], required: false }),
      from: t.arg.string({ required: false }),
      to: t.arg.string({ required: false }),
      resourceIds: t.arg.idList({ required: false }),
    },
    resolve: (_r, a) =>
      listActivity(a.limit ?? undefined, {
        actorUserIds: a.actorUserIds?.map(String),
        types: a.types as ActivityType[] | undefined,
        from: a.from ?? undefined,
        to: a.to ?? undefined,
        resourceIds: a.resourceIds?.map(String),
        cursor: parseCursor(a.cursor),
      }),
  }),
}));
