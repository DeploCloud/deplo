import { builder } from "../builder";
import {
  getCleanupPolicy,
  listCleanupRuns,
  previewCleanup,
  runCleanupNow,
  updateCleanupPolicy,
  type CleanupPolicy,
  type CleanupReport,
  type CleanupReportScope,
  type CleanupRunDTO,
  type CleanupRunItem,
} from "@/lib/data/docker-cleanup";

/* ------------------------------------------------------------------ */
/* Enums                                                               */
/* ------------------------------------------------------------------ */

// The scope allow-list, mirroring `CLEANUP_SCOPES` (lib/data/docker-cleanup.ts) and,
// through it, the agent's proto enum. Local to this domain (the BackupStatus precedent)
// rather than the shared enums.ts. It is CLOSED on purpose: `system`/`container`/
// `volume`/`network` prune are absent because on a Deplo host a stopped app is a live
// app and a dangling volume may hold user data — do not add a value here.
const DockerCleanupScopeEnum = builder.enumType("DockerCleanupScope", {
  description:
    "A class of Docker object a cleanup may reclaim. build_cache = the daemon's BuildKit cache. dangling_images = untagged layers (never `-a`). orphan_buildkit_cache = dangling volumes proven to be abandoned buildkitd stores. unused_app_images = old app images no container references (off by default: Deplo pushes to no registry, so a removed image comes back only by a rebuild).",
  values: [
    "build_cache",
    "dangling_images",
    "orphan_buildkit_cache",
    "unused_app_images",
  ] as const,
});

const DockerCleanupTriggerEnum = builder.enumType("DockerCleanupTrigger", {
  values: ["manual", "scheduled"] as const,
});

const DockerCleanupRunStatusEnum = builder.enumType("DockerCleanupRunStatus", {
  values: ["running", "success", "failed"] as const,
});

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

const DockerCleanupPolicyRef = builder
  .objectRef<CleanupPolicy>("DockerCleanupPolicy")
  .implement({
    description:
      "The instance-wide Docker cleanup schedule. One policy, not one per server: a host opts OUT via `excludedServerIds`, so a newly added server cannot silently go un-swept. Reads as the safe defaults (disabled) until it is saved once.",
    fields: (t) => ({
      enabled: t.exposeBoolean("enabled"),
      schedule: t.exposeString("schedule", {
        description: "5-field cron expression, evaluated in UTC. Rejected on save if it does not parse.",
      }),
      minAgeHours: t.exposeInt("minAgeHours", {
        description: "Only reclaim objects older than this. 0 = no age filter.",
      }),
      keepImagesPerApp: t.exposeInt("keepImagesPerApp", {
        description: "unused_app_images only: how many of the newest images to keep per app.",
      }),
      scopes: t.field({
        type: [DockerCleanupScopeEnum],
        description: "What the sweep reclaims. Empty = nothing, and the policy cannot be enabled.",
        resolve: (p) => p.scopes,
      }),
      excludedServerIds: t.exposeStringList("excludedServerIds", {
        description:
          "Servers the SCHEDULED sweep skips. A manual runDockerCleanupNow ignores this list — the operator standing in front of the button has already made that decision.",
      }),
      updatedAt: t.exposeString("updatedAt", {
        nullable: true,
        description: "Null until the policy has been saved once.",
      }),
    }),
  });

const DockerCleanupReportScopeRef = builder
  .objectRef<CleanupReportScope>("DockerCleanupReportScope")
  .implement({
    description: "One scope's line in a preview: what the agent WOULD reclaim, having removed nothing.",
    fields: (t) => ({
      scope: t.field({ type: DockerCleanupScopeEnum, resolve: (s) => s.scope }),
      // Float, not Int — a build cache easily exceeds 2^31 bytes (the BackupRun.sizeBytes rule).
      reclaimedBytes: t.exposeFloat("reclaimedBytes"),
      itemsRemoved: t.exposeInt("itemsRemoved"),
      items: t.exposeStringList("items", {
        description:
          "The image ids / volume names in question. Bounded by the agent to 200 entries — `itemsRemoved` is the authoritative count.",
      }),
      skipped: t.exposeBoolean("skipped", {
        description:
          "The agent declined this scope because it could not prove the removal was safe. Not a failure: the other scopes still run.",
      }),
      error: t.exposeString("error", { nullable: true }),
    }),
  });

const DockerCleanupReportRef = builder
  .objectRef<CleanupReport>("DockerCleanupReport")
  .implement({
    description:
      "A live, never-persisted answer to 'what would a cleanup reclaim on this host?' — the agent's dry run. Nothing was removed. This is what the confirm dialog shows, so the operator approves a LIST rather than a verb.",
    fields: (t) => ({
      serverId: t.exposeString("serverId"),
      serverName: t.exposeString("serverName"),
      reclaimedBytes: t.exposeFloat("reclaimedBytes", {
        description: "The sum of the per-scope totals.",
      }),
      scopes: t.field({ type: [DockerCleanupReportScopeRef], resolve: (r) => r.scopes }),
    }),
  });

const DockerCleanupRunItemRef = builder
  .objectRef<CleanupRunItem>("DockerCleanupRunItem")
  .implement({
    description:
      "One scope's outcome in an executed run. Counts only — the history keeps how much was reclaimed, not which objects.",
    fields: (t) => ({
      scope: t.field({ type: DockerCleanupScopeEnum, resolve: (i) => i.scope }),
      reclaimedBytes: t.exposeFloat("reclaimedBytes"),
      itemsRemoved: t.exposeInt("itemsRemoved"),
      skipped: t.exposeBoolean("skipped"),
      error: t.exposeString("error", { nullable: true }),
    }),
  });

const DockerCleanupRunRef = builder
  .objectRef<CleanupRunDTO>("DockerCleanupRun")
  .implement({
    description:
      "One executed sweep on one server. A run that could not even start — an unprovisioned host, an agent offline or too old — is still recorded, as `failed`: the history never lies about an attempt.",
    fields: (t) => ({
      id: t.exposeID("id"),
      serverId: t.exposeID("serverId", {
        nullable: true,
        description: "Null once the server is removed — `serverName` is what keeps the row readable.",
      }),
      serverName: t.exposeString("serverName"),
      trigger: t.field({ type: DockerCleanupTriggerEnum, resolve: (r) => r.trigger }),
      actor: t.exposeString("actor", {
        description: 'The user who ran it, or "Scheduler" for a scheduled sweep.',
      }),
      status: t.field({ type: DockerCleanupRunStatusEnum, resolve: (r) => r.status }),
      error: t.exposeString("error", { nullable: true }),
      reclaimedBytes: t.exposeFloat("reclaimedBytes"),
      startedAt: t.exposeString("startedAt"),
      finishedAt: t.exposeString("finishedAt", { nullable: true }),
      items: t.field({
        type: [DockerCleanupRunItemRef],
        description: "The per-scope breakdown, in the scope allow-list's order.",
        resolve: (r) => r.items,
      }),
    }),
  });

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const UpdateDockerCleanupPolicyInputType = builder.inputType(
  "UpdateDockerCleanupPolicyInput",
  {
    description:
      "Save the instance-wide cleanup policy. The scopes are a whole-set replace, so a scope left out is a scope no longer reclaimed.",
    fields: (t) => ({
      enabled: t.boolean({ required: true }),
      schedule: t.string({ required: true }),
      minAgeHours: t.int({ required: true }),
      keepImagesPerApp: t.int({ required: true }),
      scopes: t.field({ type: [DockerCleanupScopeEnum], required: true }),
      // Optional and NOT the same as an empty list: omitted leaves the opt-out list
      // untouched, `[]` clears it (every server is swept).
      excludedServerIds: t.stringList({ required: false }),
    }),
  },
);

/* ------------------------------------------------------------------ */
/* Queries (the DB reads — no agent is dialed)                         */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  dockerCleanupPolicy: t.field({
    type: DockerCleanupPolicyRef,
    authScopes: { capability: "manage_infra" },
    description:
      "The instance-wide Docker cleanup policy. Never null: an instance that has never configured cleanup reads as disabled, with the safe defaults.",
    resolve: () => getCleanupPolicy(),
  }),
  dockerCleanupRuns: t.field({
    type: [DockerCleanupRunRef],
    authScopes: { capability: "manage_infra" },
    description:
      "Cleanup history, newest first. Not team-scoped: servers are the one shared cross-team resource, so a run belongs to a host.",
    args: {
      serverId: t.arg.string({
        required: false,
        description: "Only this server's runs. Omit for every server's.",
      }),
      limit: t.arg.int({ required: false, description: "Clamped to [1, 100]. Defaults to 20." }),
    },
    resolve: (_r, { serverId, limit }) =>
      listCleanupRuns({ serverId: serverId ?? undefined, limit: limit ?? undefined }),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  updateDockerCleanupPolicy: t.field({
    type: DockerCleanupPolicyRef,
    authScopes: { capability: "manage_infra" },
    description:
      "Save the instance-wide cleanup policy. The cron is rejected (not repaired) when it does not parse — an unparseable schedule is a cleanup that silently never runs while the UI says it is enabled. The numeric bounds are clamped instead: there is no dangerous value of 'keep N images', only an unhelpful one.",
    args: { input: t.arg({ type: UpdateDockerCleanupPolicyInputType, required: true }) },
    resolve: (_r, { input }) =>
      updateCleanupPolicy({
        enabled: input.enabled,
        schedule: input.schedule,
        minAgeHours: input.minAgeHours,
        keepImagesPerApp: input.keepImagesPerApp,
        scopes: [...input.scopes],
        excludedServerIds: input.excludedServerIds
          ? [...input.excludedServerIds]
          : undefined,
      }),
  }),
  // The preview is a MUTATION, not a query, even though it removes nothing and persists
  // nothing. It DIALS THE AGENT — and app/api/graphql/route.ts serves GET, so a
  // side-effecting query would be reachable by a plain link (prefetch, crawler, CSRF)
  // and would turn the control plane into a fan-out dialer on someone else's click.
  // Same reasoning as checkServerHealth (types/server.ts:366-371). It takes no host/port,
  // only an opaque serverId resolved through the pinned dial target.
  previewDockerCleanup: t.field({
    type: DockerCleanupReportRef,
    authScopes: { capability: "manage_infra" },
    description:
      "Enumerate what a cleanup WOULD reclaim on this server, removing nothing (the agent's dry run). Writes no run row. This is what the UI calls before it opens the confirm dialog.",
    args: { serverId: t.arg.string({ required: true }) },
    resolve: (_r, { serverId }) => previewCleanup(serverId),
  }),
  runDockerCleanupNow: t.field({
    type: DockerCleanupRunRef,
    authScopes: { capability: "manage_infra" },
    description:
      "Reclaim Docker disk on this server now, with the policy's scopes — whether or not the schedule is enabled, and ignoring the exclusion list (which only governs the scheduled sweep). Allow-listed: it never prunes containers, volumes or networks, so a stopped app, its data and its network survive. Errors clearly when the server is unreachable, unprovisioned, or its agent is too old to know how to clean up.",
    args: { serverId: t.arg.string({ required: true }) },
    resolve: (_r, { serverId }) => runCleanupNow(serverId),
  }),
}));
