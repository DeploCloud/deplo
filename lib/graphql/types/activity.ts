import { builder } from "../builder";
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
    authScopes: { loggedIn: true },
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
