import * as z from "zod";
import { appId, databaseId, page, tool, type McpToolDef } from "./tool-def";

export const BACKUPS: McpToolDef[] = [
  tool({
    name: "list_backups",
    title: "List backup schedules",
    description: "Every backup schedule in the team, with its last result.",
    group: "Backups",
    requires: "view",
    readOnly: true,
    idempotent: true,
    paginate: true,
    input: z.object({ ...page }),
    query: /* GraphQL */ `
      query McpListBackups {
        backups {
          id
          name
          targetKind
          appId
          databaseId
          destinationId
          destinationName
          schedule
          timezone
          enabled
          retentionCount
          lastRunAt
          lastStatus
        }
      }
    `,
  }),
  tool({
    name: "list_backup_runs",
    title: "List backup runs",
    description: "Backup history for one app or database, newest first.",
    group: "Backups",
    requires: "view",
    readOnly: true,
    idempotent: true,
    paginate: true,
    input: z.object({
      appId: appId.optional(),
      databaseId: databaseId.optional(),
      ...page,
    }),
    query: /* GraphQL */ `
      query McpListBackupRuns($appId: String, $databaseId: String) {
        backupRuns(appId: $appId, databaseId: $databaseId) {
          id
          backupId
          status
          startedAt
          finishedAt
          sizeBytes
          verified
          error
        }
      }
    `,
  }),
  tool({
    name: "run_backup",
    title: "Back up now",
    description:
      "Take a backup right now: of an app, of a database, or by running an existing schedule ahead of its time.",
    group: "Backups",
    requires: "manage_backups",
    input: z.object({
      kind: z
        .enum(["app", "database", "schedule"])
        .describe("What the id names."),
      id: z.string().describe("The app's, database's or schedule's id."),
      destinationId: z
        .string()
        .optional()
        .describe(
          "Where to store it, from list_destinations. Not used for a schedule, which carries its own.",
        ),
    }),
    variables: (a) => {
      if (a.kind !== "schedule" && !a.destinationId)
        throw new Error(
          "Backing up an app or a database needs a destinationId; see list_destinations.",
        );
      return {
        id: a.id,
        destinationId: a.destinationId ?? "",
        isApp: a.kind === "app",
        isDatabase: a.kind === "database",
        isSchedule: a.kind === "schedule",
      };
    },
    query: /* GraphQL */ `
      mutation McpRunBackup(
        $id: String!
        $destinationId: String!
        $isApp: Boolean!
        $isDatabase: Boolean!
        $isSchedule: Boolean!
      ) {
        runAppBackup(appId: $id, destinationId: $destinationId)
          @include(if: $isApp)
        runDatabaseBackup(databaseId: $id, destinationId: $destinationId)
          @include(if: $isDatabase)
        runBackup(id: $id) @include(if: $isSchedule)
      }
    `,
  }),
  tool({
    name: "restore_backup",
    title: "Restore a backup",
    description:
      "Restore an artifact in place. This OVERWRITES the live app or database with the backup's contents.",
    group: "Backups",
    requires: "restore_backups",
    destructive: true,
    input: z.object({
      runId: z.string().describe("The backup run's id, from list_backup_runs."),
    }),
    query: /* GraphQL */ `
      mutation McpRestoreBackup($runId: String!) {
        restoreBackup(runId: $runId)
      }
    `,
  }),
  tool({
    name: "list_destinations",
    title: "List backup destinations",
    description: "Where backups can be stored: a bucket or a server's disk.",
    group: "Backups",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpListDestinations {
        backupDestinations {
          id
          name
          kind
          where
          status
          bucket
          endpoint
          region
          path
          serverId
          serverName
          encrypted
          freeBytes
          totalBytes
          lastTestAt
          lastTestError
        }
      }
    `,
  }),
];

export const BACKUP_SCHEDULES: McpToolDef[] = [
  tool({
    name: "set_backup_schedule",
    title: "Create or edit a backup schedule",
    description:
      "Set up a recurring backup, or change one that exists by passing its id. Pass enabled on its own to just turn one on or off.",
    group: "Backups",
    requires: "manage_backups",
    input: z.object({
      id: z
        .string()
        .optional()
        .describe("An existing schedule, from list_backups. Omit to create."),
      name: z.string().optional(),
      appId: z.string().optional().describe("Back up an app. Create only."),
      databaseId: z
        .string()
        .optional()
        .describe("Back up a database. Create only."),
      destinationId: z
        .string()
        .optional()
        .describe("Where it is stored, from list_destinations."),
      schedule: z.string().optional().describe("5-field cron, e.g. 0 3 * * *."),
      retentionCount: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("How many artifacts to keep."),
      timezone: z.string().optional().describe("IANA zone, e.g. Europe/Rome."),
      enabled: z.boolean().optional().describe("Turn a schedule on or off."),
    }),
    variables: (a) => {
      const toggleOnly =
        Boolean(a.id) &&
        a.enabled !== undefined &&
        !a.name &&
        !a.destinationId &&
        !a.schedule &&
        a.retentionCount === undefined;
      if (!a.id) {
        if (!a.name || !a.destinationId || !a.schedule)
          throw new Error(
            "Creating a schedule needs name, destinationId and schedule.",
          );
        if (!a.appId && !a.databaseId)
          throw new Error(
            "Creating a schedule needs an appId or a databaseId.",
          );
      } else if (!toggleOnly && (!a.name || !a.destinationId || !a.schedule)) {
        throw new Error(
          "Editing a schedule needs name, destinationId and schedule; pass enabled alone to only switch it on or off.",
        );
      }
      const fields = {
        name: a.name ?? "",
        destinationId: a.destinationId ?? "",
        schedule: a.schedule ?? "",
        retentionCount: a.retentionCount ?? 7,
        timezone: a.timezone,
      };
      return {
        id: a.id ?? "",
        enabled: a.enabled ?? true,
        create: { ...fields, appId: a.appId, databaseId: a.databaseId },
        update: fields,
        isCreate: !a.id,
        isUpdate: Boolean(a.id) && !toggleOnly,
        isToggle: Boolean(a.id) && a.enabled !== undefined,
      };
    },
    query: /* GraphQL */ `
      mutation McpSetBackupSchedule(
        $id: String!
        $enabled: Boolean!
        $create: CreateBackupInput!
        $update: UpdateBackupInput!
        $isCreate: Boolean!
        $isUpdate: Boolean!
        $isToggle: Boolean!
      ) {
        createBackup(input: $create) @include(if: $isCreate)
        updateBackup(id: $id, input: $update) @include(if: $isUpdate)
        toggleBackup(id: $id, enabled: $enabled) @include(if: $isToggle)
      }
    `,
  }),
  tool({
    name: "delete_backup_schedule",
    title: "Delete a backup schedule",
    description:
      "Stop a recurring backup and forget its schedule. Artifacts already stored are left where they are.",
    group: "Backups",
    requires: "manage_backups",
    destructive: true,
    input: z.object({ id: z.string().describe("From list_backups.") }),
    query: /* GraphQL */ `
      mutation McpDeleteBackupSchedule($id: String!) {
        deleteBackup(id: $id)
      }
    `,
  }),
];

export const BACKUPS_ADMIN: McpToolDef[] = [
  tool({
    name: "cancel_backup_run",
    title: "Cancel a running backup",
    description: "Stop a backup that is in progress.",
    group: "Backups",
    requires: "manage_backups",
    input: z.object({ runId: z.string().describe("From list_backup_runs.") }),
    query: /* GraphQL */ `
      mutation McpCancelBackupRun($runId: String!) {
        cancelBackupRun(runId: $runId)
      }
    `,
  }),
  tool({
    name: "delete_backup_run",
    title: "Delete a backup",
    description: "Delete one backup run and the artifact it stored.",
    group: "Backups",
    requires: "delete_backups",
    destructive: true,
    input: z.object({ runId: z.string().describe("From list_backup_runs.") }),
    query: /* GraphQL */ `
      mutation McpDeleteBackupRun($runId: String!) {
        deleteBackupRun(runId: $runId)
      }
    `,
  }),
  tool({
    name: "delete_backup_artifacts",
    title: "Delete every backup of an app or database",
    description: "Remove all stored backups of one app or database at once.",
    group: "Backups",
    requires: "delete_backups",
    destructive: true,
    input: z.object({
      targetId: z.string().describe("The app's or database's id."),
      targetKind: z.enum(["app", "database"]),
    }),
    query: /* GraphQL */ `
      mutation McpDeleteBackupArtifacts(
        $targetId: String!
        $targetKind: BackupTargetKind!
      ) {
        deleteBackupArtifacts(targetId: $targetId, targetKind: $targetKind)
      }
    `,
  }),
  tool({
    name: "list_backup_destination_options",
    title: "List where a backup can go",
    description:
      "The destinations a new backup schedule may pick, with whether each is encrypted and healthy.",
    group: "Backups",
    requires: "manage_backups",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpDestinationOptions {
        backupDestinationOptions {
          id
          name
          kind
          where
          status
          encrypted
          recoveryKeySavedAt
        }
      }
    `,
  }),
];

const DESTINATION_FIELDS = /* GraphQL */ `
  id
  name
  kind
  where
  status
  encrypted
  serverName
  bucket
  endpoint
  region
  path
  lastTestAt
  lastTestError
`;

export const DESTINATIONS: McpToolDef[] = [
  tool({
    name: "create_destination",
    title: "Add a backup destination",
    description:
      "Where backups are stored: an S3-compatible bucket (with credentials) or a directory on one of the fleet's servers.",
    group: "Backups",
    requires: "manage_backup_destinations",
    input: z.object({
      name: z.string(),
      kind: z.enum(["s3", "server"]),
      serverId: z.string().optional().describe("For kind server."),
      path: z.string().optional().describe("For kind server."),
      provider: z
        .enum([
          "AWS",
          "BACKBLAZE_B2",
          "CLOUDFLARE_R2",
          "DIGITALOCEAN",
          "MINIO",
          "OTHER",
          "WASABI",
        ])
        .optional(),
      endpoint: z.string().optional(),
      region: z.string().optional(),
      bucket: z.string().optional(),
      accessKey: z.string().optional(),
      secretKey: z.string().optional(),
      s3ExtraArgs: z.string().optional(),
    }),
    variables: (a) => ({ input: a }),
    query: /* GraphQL */ `
      mutation McpCreateDestination($input: CreateDestinationInput!) {
        createDestination(input: $input) { ${DESTINATION_FIELDS} }
      }
    `,
  }),
  tool({
    name: "test_destination",
    title: "Test a backup destination",
    description:
      "Write and read a probe object to prove the destination works.",
    group: "Backups",
    requires: "manage_backup_destinations",
    idempotent: true,
    input: z.object({ id: z.string().describe("From list_destinations.") }),
    query: /* GraphQL */ `
      mutation McpTestDestination($id: String!) {
        testDestination(id: $id) {
          destination { ${DESTINATION_FIELDS} }
        }
      }
    `,
  }),
  tool({
    name: "delete_destination",
    title: "Delete a backup destination",
    description:
      "Remove a destination. Refused while schedules point at it; deleteArtifacts also removes the backups it holds.",
    group: "Backups",
    requires: "manage_backup_destinations",
    destructive: true,
    input: z.object({
      id: z.string().describe("From list_destinations."),
      deleteArtifacts: z.boolean().optional(),
    }),
    query: /* GraphQL */ `
      mutation McpDeleteDestination($id: String!, $deleteArtifacts: Boolean) {
        deleteDestination(id: $id, deleteArtifacts: $deleteArtifacts)
      }
    `,
  }),
];
