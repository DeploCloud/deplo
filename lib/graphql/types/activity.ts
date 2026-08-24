import { builder } from "../builder";
import { VarAuthorRef } from "./env";
import { listActivity } from "@/lib/data/activity";
import type { Activity } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Enums (local — not shared in enums.ts)                              */
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
    // name. Same shape as an env var's author, deliberately — one identity type.
    actorUser: t.field({
      type: VarAuthorRef,
      nullable: true,
      resolve: (a) => a.actorUser,
    }),
    appId: t.exposeID("appId", { nullable: true }),
    createdAt: t.exposeString("createdAt"),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  activity: t.field({
    type: [ActivityRef],
    authScopes: { capability: "view_activity" },
    description: "Recent activity in the active team, newest first.",
    args: { limit: t.arg.int({ required: false }) },
    resolve: (_r, { limit }) => listActivity(limit ?? undefined),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

// None — `recordActivity` is internal (called by other data-layer writes) and
// is not exposed as a mutation.
