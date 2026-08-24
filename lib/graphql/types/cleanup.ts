import { builder } from "../builder";
import { CLEANUP_RUNS_TOPIC, pubSub } from "../pubsub";
import {
  getCleanupPolicy,
  listCleanupRuns,
  listCleanupRunsForSubscriber,
  runCleanupNow,
  setServerCleanupExcluded,
  updateCleanupPolicy,
  type CleanupPolicy,
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
    "A class of Docker object a cleanup may reclaim. build_cache = the daemon's BuildKit cache. dangling_images = untagged layers (never `-a`). orphan_buildkit_cache = dangling volumes proven to be abandoned buildkitd stores. unused_app_images = old app images no container references, bounded per app by that app's `rollbackKeep` (falling back to keepImagesPerApp where a rollback is impossible). Deplo pushes to no registry, so a removed image comes back only by a rebuild - the newest image per app always survives. leftover_app_files = the config files of Apps and databases that were DELETED, judged against the stacks this instance still knows about; the only scope that removes something no rebuild recreates, so it is skipped outright on an agent too old to have the list. All five are on by default.",
  values: [
    "build_cache",
    "dangling_images",
    "orphan_buildkit_cache",
    "unused_app_images",
    "leftover_app_files",
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
      "The instance-wide Docker cleanup schedule. One policy, not one per server: a host opts OUT via `excludedServerIds`, so a newly added server cannot silently go un-swept. Until it is saved once it reads as the defaults — ENABLED, daily at 04:00 UTC, every scope — so a fresh install sweeps its hosts without anyone finding this setting first; a saved row (including an explicit disable) always wins.",
    fields: (t) => ({
      enabled: t.exposeBoolean("enabled"),
      schedule: t.exposeString("schedule", {
        description:
          "5-field cron expression, evaluated in UTC. Rejected on save if it does not parse.",
      }),
      minAgeHours: t.exposeInt("minAgeHours", {
        description: "Only reclaim objects older than this. 0 = no age filter.",
      }),
      keepImagesPerApp: t.exposeInt("keepImagesPerApp", {
        description:
          "unused_app_images only: how many of the newest images to keep for an " +
          "app that CANNOT be rolled back - a compose stack, a prebuilt image, a " +
          "pull request preview. An app Deplo builds is governed by its own " +
          "`App.rollbackKeep` instead, which the sweep sends per app.",
      }),
      scopes: t.field({
        type: [DockerCleanupScopeEnum],
        description:
          "What the sweep reclaims. Empty = nothing, and the policy cannot be enabled.",
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
        description:
          "Null once the server is removed — `serverName` is what keeps the row readable.",
      }),
      serverName: t.exposeString("serverName"),
      trigger: t.field({
        type: DockerCleanupTriggerEnum,
        resolve: (r) => r.trigger,
      }),
      actor: t.exposeString("actor", {
        description:
          'The user who ran it, or "Scheduler" for a scheduled sweep.',
      }),
      status: t.field({
        type: DockerCleanupRunStatusEnum,
        resolve: (r) => r.status,
      }),
      error: t.exposeString("error", { nullable: true }),
      reclaimedBytes: t.exposeFloat("reclaimedBytes"),
      startedAt: t.exposeString("startedAt"),
      finishedAt: t.exposeString("finishedAt", { nullable: true }),
      items: t.field({
        type: [DockerCleanupRunItemRef],
        description:
          "The per-scope breakdown, in the scope allow-list's order.",
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
    authScopes: { instanceAdmin: true },
    description:
      "The instance-wide Docker cleanup policy. Never null: an instance that has never configured cleanup reads as the defaults — enabled, daily, every scope.",
    resolve: () => getCleanupPolicy(),
  }),
  dockerCleanupRuns: t.field({
    type: [DockerCleanupRunRef],
    authScopes: { instanceAdmin: true },
    description:
      "Cleanup history, newest first. Not team-scoped: servers are the one shared cross-team resource, so a run belongs to a host.",
    args: {
      serverId: t.arg.string({
        required: false,
        description: "Only this server's runs. Omit for every server's.",
      }),
      limit: t.arg.int({
        required: false,
        description:
          "Clamped to [1, 100]. Defaults to the retention cap — 3 × the number of servers — which is also all the store keeps (older runs are pruned after every sweep).",
      }),
    },
    resolve: (_r, { serverId, limit }) =>
      listCleanupRuns({
        serverId: serverId ?? undefined,
        limit: limit ?? undefined,
      }),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  updateDockerCleanupPolicy: t.field({
    type: DockerCleanupPolicyRef,
    authScopes: { instanceAdmin: true },
    description:
      "Save the instance-wide cleanup policy. The cron is rejected (not repaired) when it does not parse — an unparseable schedule is a cleanup that silently never runs while the UI says it is enabled. The numeric bounds are clamped instead: there is no dangerous value of 'keep N images', only an unhelpful one.",
    args: {
      input: t.arg({
        type: UpdateDockerCleanupPolicyInputType,
        required: true,
      }),
    },
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
  setServerCleanupExcluded: t.field({
    type: DockerCleanupPolicyRef,
    authScopes: { instanceAdmin: true },
    description:
      "Include ONE server in the scheduled sweep, or leave it out, without touching any other host's membership. This is what a server's own Cleanup tab writes: sending the whole exclusion list from a per-host page would rewrite every other host from a stale snapshot. Manual `runDockerCleanupNow` ignores the list either way.",
    args: {
      serverId: t.arg.string({ required: true }),
      excluded: t.arg.boolean({ required: true }),
    },
    resolve: (_r, { serverId, excluded }) =>
      setServerCleanupExcluded(serverId, excluded),
  }),
  runDockerCleanupNow: t.field({
    type: DockerCleanupRunRef,
    authScopes: { instanceAdmin: true },
    description:
      "START a sweep of this server now, with the policy's scopes — whether or not the schedule is enabled, and ignoring the exclusion list (which only governs the scheduled sweep). Returns IMMEDIATELY with the `running` run: the host keeps working in the background, so the caller never waits on a `docker rmi` sweep and closing the page cannot cancel it. Follow it on the `dockerCleanupRuns` subscription (or re-read the query); whatever the host fails at — unreachable, unprovisioned, an agent too old — lands on that run as `failed` with the reason. Only pre-flight problems error here: unknown server, nothing selected to reclaim, or a sweep already running on this host. Allow-listed: it never prunes containers, volumes or networks, so a stopped app, its data and its network survive.",
    args: { serverId: t.arg.string({ required: true }) },
    resolve: (_r, { serverId }) => runCleanupNow(serverId),
  }),
}));

/* ------------------------------------------------------------------ */
/* Subscription (the live history)                                     */
/* ------------------------------------------------------------------ */

/**
 * The live history. Sweeps are background jobs — a manual one returns before the host
 * has done anything, and the nightly one has no client at all — so the run rows are
 * the progress indicator, and they have to move on their own.
 *
 * IMPORTANT — no cookies in the stream, same as `appStatus` (lib/graphql/types/app.ts):
 * the async iterator runs AFTER the streaming Response is returned, so every read in
 * the generator goes through the session-free `listCleanupRunsForSubscriber`. The gate
 * is the field's `instanceAdmin` scope, which the scope-auth layer evaluates in request
 * scope from the context snapshot (a synchronous `!!ctx.viewer?.isInstanceAdmin`) —
 * exactly the same authority `dockerCleanupRuns`-the-query checks.
 *
 * The whole list is emitted, not a diff: it is a handful of rows (retention caps it at
 * 3 × servers) and a full snapshot is what lets the client render without reconciling
 * anything — the same reason the app stream re-reads its snapshot per ping.
 */
builder.subscriptionFields((t) => ({
  dockerCleanupRuns: t.field({
    type: [DockerCleanupRunRef],
    authScopes: { instanceAdmin: true },
    description:
      "Emits the whole cleanup history whenever it changes — a sweep started, finished, or was pruned. Fires once immediately with the current snapshot. Instance-wide: there is no per-server stream, because there is one policy and one shared fleet.",
    subscribe: () => cleanupRunsStream(),
    resolve: (runs) => runs,
  }),
}));

/** Exported for the SSE test: it must stay cookie-free across iteration ticks. */
export async function* cleanupRunsStream(): AsyncGenerator<CleanupRunDTO[]> {
  // Initial snapshot — a fresh subscriber paints the current history immediately,
  // which also re-syncs a client whose SSE connection just self-healed.
  yield await listCleanupRunsForSubscriber();
  // The payload carries nothing beyond "something changed" (the channel's key is a
  // constant), so each ping is answered with a fresh read rather than a diff.
  for await (const _ping of pubSub.subscribe(
    "cleanupRunsChanged",
    CLEANUP_RUNS_TOPIC,
  )) {
    yield await listCleanupRunsForSubscriber();
  }
}
