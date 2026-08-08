import { builder } from "../builder";
import { S3ProviderEnum } from "./enums";
import {
  listDestinations,
  createDestination,
  testDestination,
  testDestinations,
  destinationTestReport,
  deleteDestination,
  revealRecoveryKey,
  type DestinationDTO,
  type DestinationTestResult,
} from "@/lib/data/destinations";
import type {
  S3TestReport,
  S3TestStep,
  S3TestLogLine,
} from "@/lib/data/s3-test-report";
import type { DestinationKind, S3Provider } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Enums (local — neither is shared in enums.ts)                        */
/* ------------------------------------------------------------------ */

// Connectivity state of a destination. Local to this module because no other
// domain references it; the wire enum mirrors the DestinationStatus TS union.
const DestinationStatusEnum = builder.enumType("DestinationStatus", {
  values: ["connected", "error", "unverified"] as const,
});

// Where the artifacts live. `s3` is a bucket; `server` is a directory on a
// server in the fleet, whose artifacts are always encrypted.
const DestinationKindEnum = builder.enumType("DestinationKind", {
  values: ["s3", "server"] as const,
});

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

export const BackupDestinationRef = builder
  .objectRef<DestinationDTO>("BackupDestination")
  .implement({
    description:
      "Where a team's backup artifacts are kept: an S3-compatible bucket, or a " +
      "directory on a server in the fleet. Secrets are masked and the recovery " +
      "key is never a field — it has its own mutation, which records who took it.",
    fields: (t) => ({
      id: t.exposeID("id"),
      teamId: t.exposeID("teamId"),
      name: t.exposeString("name"),
      kind: t.field({ type: DestinationKindEnum, resolve: (d) => d.kind }),
      // One line naming where this points: the endpoint, or `<server> · <path>`.
      // Every picker and card shows this rather than assembling its own.
      where: t.string({ resolve: (d) => destinationWhereField(d) }),
      status: t.field({ type: DestinationStatusEnum, resolve: (d) => d.status }),
      createdAt: t.exposeString("createdAt"),
      // Last-test verdict, so a red badge can say WHY without opening the log.
      lastTestAt: t.exposeString("lastTestAt", { nullable: true }),
      lastTestError: t.exposeString("lastTestError", { nullable: true }),

      /* ---- kind: s3 ---- */
      provider: t.field({
        type: S3ProviderEnum,
        nullable: true,
        resolve: (d) => d.provider,
      }),
      endpoint: t.exposeString("endpoint", { nullable: true }),
      region: t.exposeString("region", { nullable: true }),
      bucket: t.exposeString("bucket", { nullable: true }),
      accessKeyMasked: t.exposeString("accessKeyMasked", { nullable: true }),

      /* ---- kind: server ---- */
      serverId: t.exposeID("serverId", { nullable: true }),
      serverName: t.exposeString("serverName", { nullable: true }),
      // The configured directory (null = the agent's managed store) and the one
      // the agent actually resolved, so the card shows a real path either way.
      path: t.exposeString("path", { nullable: true }),
      resolvedPath: t.exposeString("resolvedPath", { nullable: true }),
      // Float, not Int: a modern disk is well past 2^31 bytes.
      freeBytes: t.float({ nullable: true, resolve: (d) => d.lastFreeBytes }),
      totalBytes: t.float({ nullable: true, resolve: (d) => d.lastTotalBytes }),
      // Null until someone downloads the recovery key. Drives the nudge on the
      // card: an encrypted backup whose only key lives inside the thing that
      // might be lost is not a backup.
      recoveryKeySavedAt: t.exposeString("recoveryKeySavedAt", { nullable: true }),
    }),
  });

/** Mirror of `destinationWhere` in the data layer, kept here so the field can be
 *  resolved without importing a `server-only` module into the schema twice. */
function destinationWhereField(d: DestinationDTO): string {
  if (d.kind === "s3") return d.endpoint ?? "";
  const server = d.serverName ?? "a removed server";
  const path = d.resolvedPath ?? d.path;
  return path ? `${server} · ${path}` : server;
}

/**
 * The recovery key for a server destination: the age identity in the clear.
 *
 * One of exactly two sanctioned exceptions to "never add a show-secret
 * affordance" (the other is the basic-auth password), and it earns it: without
 * this key, a rotated DEPLO_SECRET or a lost control plane makes every artifact
 * on that disk unreadable forever. With it, `age -d -i key.txt` reads them on
 * any machine.
 */
const RecoveryKeyRef = builder
  .objectRef<{ name: string; recipient: string; identity: string }>("RecoveryKey")
  .implement({
    description:
      "The private key that decrypts a server destination's artifacts. Save it " +
      "somewhere outside Deplo: it is the only way to read those backups if this " +
      "instance is lost. Fetching it is recorded in Activity.",
    fields: (t) => ({
      name: t.exposeString("name"),
      recipient: t.exposeString("recipient"),
      identity: t.exposeString("identity"),
    }),
  });

/* ------------------------------------------------------------------ */
/* Connection test report (the debug output behind the badge)           */
/* ------------------------------------------------------------------ */

const S3TestStepStatusEnum = builder.enumType("S3TestStepStatus", {
  values: ["passed", "failed", "skipped"] as const,
});

const S3TestStepRef = builder
  .objectRef<S3TestStep>("S3TestStep")
  .implement({
    description:
      "One step of the fixed probe sequence the agent performs (pick a server, " +
      "open the endpoint, head the bucket, write a probe file, remove it).",
    fields: (t) => ({
      key: t.exposeString("key"),
      label: t.exposeString("label"),
      detail: t.exposeString("detail"),
      status: t.field({ type: S3TestStepStatusEnum, resolve: (s) => s.status }),
    }),
  });

const S3TestLogLineRef = builder
  .objectRef<S3TestLogLine>("S3TestLogLine")
  .implement({
    description: "A line of the connection-test log, with the level to render it at.",
    fields: (t) => ({
      level: t.exposeString("level"),
      text: t.exposeString("text"),
    }),
  });

const S3TestReportRef = builder
  .objectRef<S3TestReport>("S3TestReport")
  .implement({
    description:
      "The result of testing a destination: the verdict, the probe sequence, the " +
      "agent's verbatim output, and the commands that reproduce the same three S3 " +
      "calls by hand. `never` ⇒ it has not been tested yet.",
    fields: (t) => ({
      ok: t.exposeBoolean("ok"),
      never: t.exposeBoolean("never"),
      error: t.exposeString("error"),
      startedAt: t.exposeString("startedAt"),
      durationMs: t.exposeInt("durationMs"),
      serverName: t.exposeString("serverName"),
      steps: t.field({ type: [S3TestStepRef], resolve: (r) => r.steps }),
      lines: t.field({ type: [S3TestLogLineRef], resolve: (r) => r.lines }),
      command: t.exposeString("command"),
    }),
  });

const DestinationTestResultRef = builder
  .objectRef<DestinationTestResult>("DestinationTestResult")
  .implement({
    description:
      "A completed connection test: the destination with its badge repainted, plus " +
      "the verdict. Callers MUST read `report.ok` — a failed probe is a normal " +
      "result, not a mutation error.",
    fields: (t) => ({
      destination: t.field({
        type: BackupDestinationRef,
        resolve: (r) => r.destination,
      }),
      report: t.field({ type: S3TestReportRef, resolve: (r) => r.report }),
    }),
  });

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const CreateDestinationInputType = builder.inputType("CreateDestinationInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    kind: t.field({ type: DestinationKindEnum, required: true }),
    // s3 — required when kind is s3, validated in the data layer so the message
    // says which field is missing rather than which arg failed.
    provider: t.field({ type: S3ProviderEnum, required: false }),
    endpoint: t.string({ required: false }),
    region: t.string({ required: false }),
    bucket: t.string({ required: false }),
    accessKey: t.string({ required: false }),
    secretKey: t.string({ required: false }),
    // server — `path` is instance-admin only; null means the agent's own
    // managed store, which is what almost everyone wants.
    serverId: t.string({ required: false }),
    path: t.string({ required: false }),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  backupDestinations: t.field({
    type: [BackupDestinationRef],
    authScopes: { loggedIn: true },
    description: "All backup destinations in the active team, newest first.",
    resolve: () => listDestinations(),
  }),
  destinationTestReport: t.field({
    type: S3TestReportRef,
    authScopes: { capability: "manage_backup_destinations" },
    description:
      "The STORED result of this destination's last connection test — reading it " +
      "never re-dials. `never` is true until the first test.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => destinationTestReport(id),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  createDestination: t.field({
    type: BackupDestinationRef,
    authScopes: { capability: "manage_backup_destinations" },
    args: { input: t.arg({ type: CreateDestinationInputType, required: true }) },
    resolve: (_r, { input }) =>
      createDestination({
        name: input.name,
        kind: input.kind as DestinationKind,
        provider: (input.provider as S3Provider | null) ?? null,
        endpoint: input.endpoint ?? null,
        region: input.region ?? null,
        bucket: input.bucket ?? null,
        accessKey: input.accessKey ?? null,
        secretKey: input.secretKey ?? null,
        serverId: input.serverId ?? null,
        path: input.path ?? null,
      }),
  }),
  testDestination: t.field({
    type: DestinationTestResultRef,
    authScopes: { capability: "manage_backup_destinations" },
    description:
      "Probe the destination through its agent — for a bucket, head/write/remove; " +
      "for a server, resolve the folder, check it is writable and report its free " +
      "space — and return BOTH the repainted destination and the verdict. A failed " +
      "probe resolves normally with `report.ok = false`: check it rather than " +
      "assuming success, and show `report.error` verbatim.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => testDestination(id),
  }),
  testDestinations: t.field({
    type: [BackupDestinationRef],
    authScopes: { capability: "manage_backup_destinations" },
    description:
      "Re-probe EVERY destination in the active team and return them with their " +
      "badges repainted, newest first. For pickers that must show live " +
      "connectivity the moment they open, rather than a status that was true " +
      "hours ago. A destination whose probe fails comes back as `error` with " +
      "`lastTestError` set — the call itself still resolves.",
    resolve: () => testDestinations(),
  }),
  destinationRecoveryKey: t.field({
    type: RecoveryKeyRef,
    authScopes: { capability: "manage_backup_destinations" },
    description:
      "Fetch a server destination's recovery key, and mark it saved. This hands " +
      "over the ability to read every artifact at that destination, so it is " +
      "recorded in Activity. A mutation rather than a field precisely so that " +
      "reading the destination never carries the key.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => revealRecoveryKey(id),
  }),
  deleteDestination: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_backup_destinations" },
    description:
      "Delete the destination and the schedules and run records that point at it. " +
      "The artifacts themselves are not touched. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteDestination(id);
      return true;
    },
  }),
}));
