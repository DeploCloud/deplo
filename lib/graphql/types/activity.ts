import { builder } from "../builder";
import { VarAuthorRef } from "./env";
import { listActivity } from "@/lib/data/activity";
import type { Activity, ActivityType } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Enums (local, not shared in enums.ts)                              */
/* ------------------------------------------------------------------ */

// The kind of event an Activity row records. Defined locally because no other
// domain module needs it; mirrors the `ActivityType` union in lib/types.ts.
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

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

const ActivityRef = builder.objectRef<Activity>("Activity").implement({
  description: "A single audit-log event in the active team's timeline.",
  fields: (t) => ({
    id: t.exposeID("id"),
    teamId: t.exposeID("teamId"),
    type: t.field({ type: ActivityTypeEnum, resolve: (a) => a.type }),
    message: t.exposeString("message"),
    actor: t.exposeString("actor"),
    // The human behind `actor`, when there is one. Non-human actors ("system" /
    // "github") and rows predating the column stay null.
    actorUserId: t.exposeID("actorUserId", { nullable: true }),
    // That person, resolved for display: the avatar the row shows before the
    // name. Same shape as an env var's author, deliberately - one identity type.
    actorUser: t.field({
      type: VarAuthorRef,
      nullable: true,
      resolve: (a) => a.actorUser,
    }),
    appId: t.exposeID("appId", { nullable: true }),
    databaseId: t.exposeID("databaseId", { nullable: true }),
    createdAt: t.exposeString("createdAt"),
    // This row's keyset position, opaque on purpose: hand it back as `cursor` to
    // read the page after it. Not `seq` as an Int - a GraphQL Int is 32 bits and
    // `seq` is a bigint.
    cursor: t.string({ resolve: (a) => `${a.createdAt}|${a.seq}` }),
  }),
});

/** Undo {@link ActivityRef}'s `cursor`. A malformed one pages from the top. */
function parseCursor(
  cursor: string | null | undefined,
): { createdAt: string; seq: number } | undefined {
  if (!cursor) return undefined;
  const at = cursor.lastIndexOf("|");
  const seq = Number(cursor.slice(at + 1));
  if (at < 1 || !Number.isSafeInteger(seq)) return undefined;
  return { createdAt: cursor.slice(0, at), seq };
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  activity: t.field({
    type: [ActivityRef],
    authScopes: { capability: "view_activity" },
    description: "Recent activity in the active team, newest first.",
    args: {
      limit: t.arg.int({ required: false }),
      /** An `Activity.cursor` from the previous page. */
      cursor: t.arg.string({ required: false }),
      actorUserIds: t.arg.idList({ required: false }),
      types: t.arg({ type: [ActivityTypeEnum], required: false }),
      from: t.arg.string({ required: false }),
      to: t.arg.string({ required: false }),
      /** App, folder, project and database ids mixed. */
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

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

// None - `recordActivity` is internal (called by other data-layer writes) and
// is not exposed as a mutation.
