import { builder } from "../builder";
import { S3ProviderEnum } from "./enums";
import { createDestination } from "@/lib/data/destinations/create";
import type {
  DestinationDTO,
  DestinationOption,
} from "@/lib/data/destinations/dto";
import {
  listDestinations,
  listDestinationOptions,
} from "@/lib/data/destinations/listing";
import {
  testDestination,
  testDestinations,
  destinationTestReport,
  type DestinationTestResult,
} from "@/lib/data/destinations/probe";
import { revealRecoveryKey } from "@/lib/data/destinations/recovery-key";
import {
  destinationRemovalImpact,
  deleteDestination,
} from "@/lib/data/destinations/removal";
import type {
  S3TestReport,
  S3TestStep,
  S3TestLogLine,
} from "@/lib/data/s3-test-report";
import type { DestinationKind, S3Provider } from "@/lib/types/backup";

const DestinationStatusEnum = builder.enumType("DestinationStatus", {
  values: ["connected", "error", "unverified"] as const,
});

const DestinationKindEnum = builder.enumType("DestinationKind", {
  values: ["s3", "server"] as const,
});

export const BackupDestinationRef = builder
  .objectRef<DestinationDTO>("BackupDestination")
  .implement({
    description:
      "Where a team's backup artifacts are kept: an S3-compatible bucket, or a " +
      "directory on a server in the fleet. Secrets are masked and the recovery " +
      "key is never a field - it has its own mutation, which records who took it.",
    fields: (t) => ({
      id: t.exposeID("id"),
      teamId: t.exposeID("teamId"),
      name: t.exposeString("name"),
      kind: t.field({ type: DestinationKindEnum, resolve: (d) => d.kind }),
      where: t.string({ resolve: (d) => destinationWhereField(d) }),
      status: t.field({
        type: DestinationStatusEnum,
        resolve: (d) => d.status,
      }),
      createdAt: t.exposeString("createdAt"),
      lastTestAt: t.exposeString("lastTestAt", { nullable: true }),
      lastTestError: t.exposeString("lastTestError", { nullable: true }),

      provider: t.field({
        type: S3ProviderEnum,
        nullable: true,
        resolve: (d) => d.provider,
      }),
      endpoint: t.exposeString("endpoint", { nullable: true }),
      region: t.exposeString("region", { nullable: true }),
      bucket: t.exposeString("bucket", { nullable: true }),
      accessKeyMasked: t.exposeString("accessKeyMasked", { nullable: true }),
      allowPrivateEndpoint: t.exposeBoolean("allowPrivateEndpoint", {
        description:
          "Whether this bucket is allowed to live on a private address. " +
          "Instance-admin only to set.",
      }),
      s3ExtraArgs: t.exposeString("s3ExtraArgs", {
        nullable: true,
        description:
          "Advanced per-store quirk flags, as typed. Null when none. A server " +
          "whose agent is too old ignores them and Deplo says so.",
      }),
      encrypted: t.boolean({
        description:
          "Whether artifacts written here are encrypted. Always true for a " +
          "server destination, and for any bucket connected since bucket " +
          "artifacts started being encrypted.",
        resolve: (d) => Boolean(d.ageRecipient),
      }),

      serverId: t.exposeID("serverId", { nullable: true }),
      serverName: t.exposeString("serverName", { nullable: true }),
      path: t.exposeString("path", { nullable: true }),
      resolvedPath: t.exposeString("resolvedPath", { nullable: true }),
      // Float, not Int: a modern disk is well past 2^31 bytes.
      freeBytes: t.float({ nullable: true, resolve: (d) => d.lastFreeBytes }),
      totalBytes: t.float({ nullable: true, resolve: (d) => d.lastTotalBytes }),
      recoveryKeySavedAt: t.exposeString("recoveryKeySavedAt", {
        nullable: true,
      }),
    }),
  });

const BackupDestinationOptionRef = builder
  .objectRef<DestinationOption>("BackupDestinationOption")
  .implement({
    description:
      "A backup destination as a picker shows it. No credentials, no test " +
      "history: readable by anyone who may schedule or run a backup, including " +
      "a member scoped to one folder.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      kind: t.field({ type: DestinationKindEnum, resolve: (d) => d.kind }),
      where: t.exposeString("where"),
      status: t.field({
        type: DestinationStatusEnum,
        resolve: (d) => d.status,
      }),
      serverId: t.exposeID("serverId", { nullable: true }),
      encrypted: t.exposeBoolean("encrypted"),
      recoveryKeySavedAt: t.exposeString("recoveryKeySavedAt", {
        nullable: true,
      }),
    }),
  });

const DestinationRemovalImpactRef = builder
  .objectRef<{ schedules: number; runs: number; artifacts: number }>(
    "DestinationRemovalImpact",
  )
  .implement({
    description:
      "What deleting this destination takes with it: the schedules that point " +
      "at it, the run history, and how many stored backup files it holds.",
    fields: (t) => ({
      schedules: t.exposeInt("schedules"),
      runs: t.exposeInt("runs"),
      artifacts: t.exposeInt("artifacts"),
    }),
  });

// Mirror of `destinationWhere` in the data layer: the schema must not import a `server-only` module.
function destinationWhereField(d: DestinationDTO): string {
  if (d.kind === "s3") return d.endpoint ?? "";
  const server = d.serverName ?? "a removed server";
  const path = d.resolvedPath ?? d.path;
  return path ? `${server} · ${path}` : server;
}

const RecoveryKeyRef = builder
  .objectRef<{
    name: string;
    recipient: string;
    identity: string;
    where: string;
  }>("RecoveryKey")
  .implement({
    description:
      "The private key that decrypts a destination's artifacts. Save it " +
      "somewhere outside Deplo: it is the only way to read those backups if this " +
      "instance is lost. Fetching it is recorded in Activity.",
    fields: (t) => ({
      name: t.exposeString("name"),
      recipient: t.exposeString("recipient"),
      identity: t.exposeString("identity"),
      where: t.exposeString("where", {
        description:
          "Where the artifacts this key opens are stored, in one line. It goes " +
          "into the key file, because whoever reads that file has lost the " +
          "instance that knew the bucket or the folder.",
      }),
    }),
  });

const S3TestStepStatusEnum = builder.enumType("S3TestStepStatus", {
  values: ["passed", "failed", "skipped"] as const,
});

const S3TestStepRef = builder.objectRef<S3TestStep>("S3TestStep").implement({
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
    description:
      "A line of the connection-test log, with the level to render it at.",
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
      "the verdict. Callers MUST read `report.ok` - a failed probe is a normal " +
      "result, not a mutation error.",
    fields: (t) => ({
      destination: t.field({
        type: BackupDestinationRef,
        resolve: (r) => r.destination,
      }),
      report: t.field({ type: S3TestReportRef, resolve: (r) => r.report }),
    }),
  });

const CreateDestinationInputType = builder.inputType("CreateDestinationInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    kind: t.field({ type: DestinationKindEnum, required: true }),
    provider: t.field({ type: S3ProviderEnum, required: false }),
    endpoint: t.string({ required: false }),
    region: t.string({ required: false }),
    bucket: t.string({ required: false }),
    accessKey: t.string({ required: false }),
    secretKey: t.string({ required: false }),
    // Instance-admin only, checked in the data layer.
    allowPrivateEndpoint: t.boolean({ required: false }),
    s3ExtraArgs: t.string({ required: false }),
    // `path` is instance-admin only; null means the agent's own managed store.
    serverId: t.string({ required: false }),
    path: t.string({ required: false }),
  }),
});

builder.queryFields((t) => ({
  backupDestinations: t.field({
    type: [BackupDestinationRef],
    authScopes: { loggedIn: true },
    description: "All backup destinations in the active team, newest first.",
    resolve: () => listDestinations(),
  }),
  backupDestinationOptions: t.field({
    type: [BackupDestinationOptionRef],
    authScopes: { loggedIn: true },
    description:
      "The team's backup destinations as a picker needs them, newest first. " +
      "Unlike `backupDestinations` this is readable by a member scoped to part " +
      "of the team: they may hold `manage_backups` on an app and still need " +
      "somewhere to send its backups.",
    resolve: () => listDestinationOptions(),
  }),
  destinationRemovalImpact: t.field({
    type: DestinationRemovalImpactRef,
    authScopes: { loggedIn: true },
    description:
      "What deleting this destination would destroy. Read by the confirm " +
      "dialog, so it can name the schedules and restore points instead of " +
      "saying backups will 'stop running'.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => destinationRemovalImpact(id),
  }),
  destinationTestReport: t.field({
    type: S3TestReportRef,
    authScopes: { capability: "manage_backup_destinations" },
    description:
      "The STORED result of this destination's last connection test - reading it " +
      "never re-dials. `never` is true until the first test.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => destinationTestReport(id),
  }),
}));

builder.mutationFields((t) => ({
  createDestination: t.field({
    type: BackupDestinationRef,
    authScopes: { capability: "manage_backup_destinations" },
    args: {
      input: t.arg({ type: CreateDestinationInputType, required: true }),
    },
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
        allowPrivateEndpoint: input.allowPrivateEndpoint ?? false,
        s3ExtraArgs: input.s3ExtraArgs ?? null,
        serverId: input.serverId ?? null,
        path: input.path ?? null,
      }),
  }),
  testDestination: t.field({
    type: DestinationTestResultRef,
    authScopes: { capability: "manage_backup_destinations" },
    description:
      "Probe the destination through its agent - for a bucket, head/write/remove; " +
      "for a server, resolve the folder, check it is writable and report its free " +
      "space, and return BOTH the repainted destination and the verdict. A failed " +
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
      "`lastTestError` set - the call itself still resolves.",
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
      "Delete the destination, and with it every schedule and run record that " +
      "points at it. With `deleteArtifacts`, the stored backup files go too - " +
      "otherwise they stay where they are, which for a server destination means " +
      "on that disk with nothing left in Deplo that can name them. Returns true.",
    args: {
      id: t.arg.string({ required: true }),
      deleteArtifacts: t.arg.boolean({ required: false }),
    },
    resolve: async (_r, { id, deleteArtifacts }) => {
      await deleteDestination(id, {
        deleteArtifacts: deleteArtifacts ?? false,
      });
      return true;
    },
  }),
}));
