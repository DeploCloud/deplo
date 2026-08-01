import { builder } from "../builder";
import { S3ProviderEnum } from "./enums";
import {
  listS3,
  createS3,
  testS3,
  testAllS3,
  s3TestReport,
  deleteS3,
  type S3DestinationDTO,
  type S3TestResult,
} from "@/lib/data/s3";
import type {
  S3TestReport,
  S3TestStep,
  S3TestLogLine,
} from "@/lib/data/s3-test-report";
import type { S3Provider } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Enums (local — S3Status is not shared in enums.ts)                   */
/* ------------------------------------------------------------------ */

// Connectivity state of a destination. Local to this module because no other
// domain references it; the wire enum mirrors the S3Status TS union exactly.
const S3StatusEnum = builder.enumType("S3Status", {
  values: ["connected", "error", "unverified"] as const,
});

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

export const S3DestinationRef = builder
  .objectRef<S3DestinationDTO>("S3Destination")
  .implement({
    description:
      "An S3-compatible storage destination owned by a team (secrets masked).",
    fields: (t) => ({
      id: t.exposeID("id"),
      teamId: t.exposeID("teamId"),
      name: t.exposeString("name"),
      provider: t.field({ type: S3ProviderEnum, resolve: (s) => s.provider }),
      endpoint: t.exposeString("endpoint"),
      region: t.exposeString("region"),
      bucket: t.exposeString("bucket"),
      accessKeyMasked: t.exposeString("accessKeyMasked"),
      status: t.field({ type: S3StatusEnum, resolve: (s) => s.status }),
      createdAt: t.exposeString("createdAt"),
      // Last-test verdict, so a red badge can say WHY without opening the log.
      lastTestAt: t.exposeString("lastTestAt", { nullable: true }),
      lastTestError: t.exposeString("lastTestError", { nullable: true }),
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

const S3TestResultRef = builder
  .objectRef<S3TestResult>("S3TestResult")
  .implement({
    description:
      "A completed connection test: the destination with its badge repainted, plus " +
      "the verdict. Callers MUST read `report.ok` — a failed probe is a normal " +
      "result, not a mutation error.",
    fields: (t) => ({
      destination: t.field({
        type: S3DestinationRef,
        resolve: (r) => r.destination,
      }),
      report: t.field({ type: S3TestReportRef, resolve: (r) => r.report }),
    }),
  });

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const CreateS3InputType = builder.inputType("CreateS3Input", {
  fields: (t) => ({
    name: t.string({ required: true }),
    provider: t.field({ type: S3ProviderEnum, required: true }),
    endpoint: t.string({ required: true }),
    region: t.string({ required: false }),
    bucket: t.string({ required: true }),
    accessKey: t.string({ required: true }),
    secretKey: t.string({ required: true }),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  s3Destinations: t.field({
    type: [S3DestinationRef],
    authScopes: { loggedIn: true },
    description: "All S3 destinations in the active team, newest first.",
    resolve: () => listS3(),
  }),
  s3TestReport: t.field({
    type: S3TestReportRef,
    authScopes: { capability: "manage_infra" },
    description:
      "The STORED result of this destination's last connection test — reading it " +
      "never re-dials the bucket. `never` is true until the first test.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => s3TestReport(id),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations (every S3 server action)                                  */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  createS3: t.field({
    type: S3DestinationRef,
    authScopes: { capability: "manage_infra" },
    args: { input: t.arg({ type: CreateS3InputType, required: true }) },
    resolve: (_r, { input }) =>
      createS3({
        name: input.name,
        provider: input.provider as S3Provider,
        endpoint: input.endpoint,
        region: input.region ?? "auto",
        bucket: input.bucket,
        accessKey: input.accessKey,
        secretKey: input.secretKey,
      }),
  }),
  testS3: t.field({
    type: S3TestResultRef,
    authScopes: { capability: "manage_infra" },
    description:
      "Probe the bucket through a backup-capable agent (head, write, remove) and " +
      "return BOTH the repainted destination and the verdict. A failed probe " +
      "resolves normally with `report.ok = false` — check it rather than assuming " +
      "success, and show `report.error` verbatim.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => testS3(id),
  }),
  testS3Destinations: t.field({
    type: [S3DestinationRef],
    authScopes: { capability: "manage_infra" },
    description:
      "Re-probe EVERY destination in the active team and return them with their " +
      "badges repainted, newest first. For pickers that must show live " +
      "connectivity the moment they open, rather than a status that was true " +
      "hours ago. A destination whose probe fails comes back as `error` with " +
      "`lastTestError` set — the call itself still resolves.",
    resolve: () => testAllS3(),
  }),
  deleteS3: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description: "Delete the S3 destination and its backups. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteS3(id);
      return true;
    },
  }),
}));
