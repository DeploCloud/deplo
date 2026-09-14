import * as z from "zod";
import { CRON_KIND, tool, type McpToolDef } from "./tool-def";

const CRON_FIELDS = /* GraphQL */ `
  id
  name
  description
  command
  schedule
  timezone
  enabled
  service
  lastRunAt
  lastStatus
  nextRunAt
`;

export const CRON: McpToolDef[] = [
  tool({
    name: "list_cron_jobs",
    title: "List cron jobs",
    description:
      "Scheduled commands for one app or database, with the master switch and the containers a job can run in.",
    group: "Cron",
    requires: "manage_crons",
    readOnly: true,
    idempotent: true,
    input: z.object({
      id: z.string().describe("The app's or database's id."),
      kind: CRON_KIND,
    }),
    variables: (a) => ({ id: a.id, isDatabase: a.kind === "database" }),
    query: /* GraphQL */ `
      query McpListCronJobs($id: ID!, $isDatabase: Boolean!) {
        appCronJobs(appId: $id) @skip(if: $isDatabase) { enabled targetId services jobs { ${CRON_FIELDS} } }
        databaseCronJobs(databaseId: $id) @include(if: $isDatabase) { enabled targetId services jobs { ${CRON_FIELDS} } }
      }
    `,
  }),
  tool({
    name: "create_cron_job",
    title: "Create a cron job",
    description:
      "Schedule a command inside an app's or a database's container. The schedule is standard cron syntax.",
    group: "Cron",
    requires: "manage_crons",
    input: z.object({
      id: z.string().describe("The app's or database's id."),
      kind: CRON_KIND,
      name: z.string(),
      command: z.string(),
      schedule: z.string().describe('Cron syntax, e.g. "0 3 * * *".'),
      timezone: z.string().optional().describe("IANA zone, e.g. Europe/Rome."),
      description: z.string().optional(),
      service: z
        .string()
        .optional()
        .describe(
          "Multi-container app: the compose service to run the command in. Omitted, the job runs in the app's own container - the service its domain routes to.",
        ),
    }),
    query: /* GraphQL */ `
      mutation McpCreateCronJob($targetId: ID!, $targetKind: String!, $input: CronJobInput!) {
        createCronJob(targetId: $targetId, targetKind: $targetKind, input: $input) { ${CRON_FIELDS} }
      }
    `,
    variables: (a) => ({
      targetId: a.id,
      targetKind: a.kind ?? "app",
      input: {
        name: a.name,
        command: a.command,
        schedule: a.schedule,
        timezone: a.timezone,
        description: a.description,
        service: a.service,
        enabled: true,
      },
    }),
  }),
  tool({
    name: "run_cron_job_now",
    title: "Run a cron job now",
    description: "Fire a scheduled job immediately, off its schedule.",
    group: "Cron",
    requires: "manage_crons",
    input: z.object({ id: z.string().describe("The job's id.") }),
    query: /* GraphQL */ `
      mutation McpRunCronNow($id: ID!) {
        runCronJobNow(id: $id) {
          id
          status
          startedAt
          finishedAt
          exitCode
        }
      }
    `,
  }),
  tool({
    name: "delete_cron_job",
    title: "Delete a cron job",
    description: "Delete a scheduled job and its run history.",
    group: "Cron",
    requires: "manage_crons",
    destructive: true,
    input: z.object({ id: z.string() }),
    query: /* GraphQL */ `
      mutation McpDeleteCronJob($id: ID!) {
        deleteCronJob(id: $id)
      }
    `,
  }),
];

export const CRON_ADMIN: McpToolDef[] = [
  tool({
    name: "update_cron_job",
    title: "Edit a cron job",
    description:
      "Change any field of a scheduled command: schedule, command, container, timezone, retries, timeout.",
    group: "Cron",
    requires: "manage_crons",
    idempotent: true,
    input: z.object({
      id: z.string().describe("From list_cron_jobs."),
      name: z.string().optional(),
      description: z.string().optional(),
      schedule: z.string().optional().describe("5-field cron."),
      command: z.string().optional(),
      service: z.string().optional().describe("Container it runs in."),
      timezone: z.string().optional(),
      enabled: z.boolean().optional(),
      timeoutSeconds: z.number().int().optional(),
      maxAttempts: z.number().int().optional(),
      keepRuns: z.number().int().optional(),
      overlap: z.string().optional().describe("skip | queue | allow."),
      shell: z.string().optional(),
      user: z.string().optional(),
      workdir: z.string().optional(),
    }),
    variables: ({ id, ...input }) => ({ id, input }),
    query: /* GraphQL */ `
      mutation McpUpdateCronJob($id: ID!, $input: CronJobInput!) {
        updateCronJob(id: $id, input: $input) {
          id
          name
          schedule
          command
          service
          enabled
          nextRunAt
        }
      }
    `,
  }),
  tool({
    name: "set_cron_enabled",
    title: "Turn cron on or off for an app or database",
    description:
      "The master switch over every cron job of one app or database.",
    group: "Cron",
    requires: "manage_crons",
    idempotent: true,
    input: z.object({
      targetId: z.string().describe("The app's or database's id."),
      targetKind: z.enum(["app", "database"]),
      enabled: z.boolean(),
    }),
    query: /* GraphQL */ `
      mutation McpSetCronEnabled(
        $targetId: ID!
        $targetKind: String!
        $enabled: Boolean!
      ) {
        setCronEnabled(
          targetId: $targetId
          targetKind: $targetKind
          enabled: $enabled
        )
      }
    `,
  }),
  tool({
    name: "list_cron_runs",
    title: "List a cron job's runs",
    description:
      "Past and running executions of one job, with exit code, output and errors, newest first.",
    group: "Cron",
    requires: "manage_crons",
    readOnly: true,
    idempotent: true,
    input: z.object({
      jobId: z.string().describe("From list_cron_jobs."),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    query: /* GraphQL */ `
      query McpCronRuns($jobId: ID!, $limit: Int) {
        cronRuns(jobId: $jobId, limit: $limit) {
          id
          status
          trigger
          attempt
          maxAttempts
          exitCode
          scheduledFor
          startedAt
          finishedAt
          error
          stdout
          stderr
        }
      }
    `,
  }),
  tool({
    name: "cancel_cron_run",
    title: "Cancel a running cron job",
    description: "Stop one execution that is still running.",
    group: "Cron",
    requires: "manage_crons",
    input: z.object({
      id: z.string().describe("A run id, from list_cron_runs."),
    }),
    query: /* GraphQL */ `
      mutation McpCancelCronRun($id: ID!) {
        cancelCronRun(id: $id)
      }
    `,
  }),
];
