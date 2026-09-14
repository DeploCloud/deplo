import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

import { isoTimestamptz } from "../columns";
import { teams } from "./identity";

// migrationRunTargets - what a person chose to migrate, so the runner can carry it out without them.
export const migrationRunTargets = pgTable(
  "migration_run_targets",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    projectId: text("project_id").notNull(),
    // Shown while the run works through it; the API is not re-read for a name.
    projectName: text("project_name").notNull(),
    serviceId: text("service_id").notNull(),
    // Where it LANDS. Where its data is READ from is derived, never chosen.
    serverId: text("server_id"),
    buildServerId: text("build_server_id"),
    exposedPort: integer("exposed_port"),
    // Whether `exposedPort` is an instruction at all. The field is TRI-state -
    // absent keeps the source's own port, null publishes nothing, a number
    // publishes there - and one nullable column can only say two of the three.
    exposedPortSet: boolean("exposed_port_set").notNull().default(false),
    // `'pending'` | `'done'` | `'failed'`.
    state: text("state").notNull().default("pending"),
    // The service's kind on the source, written only once the data phase has
    // actually STOPPED it over there. Backing out of a takeover starts exactly
    // these again; a target that was never stopped is not one of them.
    stoppedKind: text("stopped_kind"),
    stoppedAt: isoTimestamptz("stopped_at"),
  },
  (t) => [index("migration_run_targets_run_idx").on(t.runId, t.seq)],
);

// migrationRunServers - which Deplo server a source machine's services land on. `fromId` '' is the panel's own host.
export const migrationRunServers = pgTable(
  "migration_run_servers",
  {
    runId: text("run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "cascade" }),
    fromId: text("from_id").notNull(),
    toId: text("to_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.fromId] })],
);

// migrationSourceAddresses - where Deplo dials a machine it imports FROM, remembered across attempts.
export const migrationSourceAddresses = pgTable(
  "migration_source_addresses",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    // The panel origin, normalised: no trailing slash, no `/api`.
    sourceUrl: text("source_url").notNull(),
    // The panel's machine id; `''` is the host the panel runs on.
    sourceId: text("source_id").notNull(),
    // What Deplo dials: an IP, or a name that points straight at the machine.
    address: text("address").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.sourceUrl, t.sourceId] })],
);

// migrationRuns - one run of the importer, kept: a long operation whose outcome outlives the tab.
export const migrationRuns = pgTable(
  "migration_runs",
  {
    id: text("id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    // Origin of the source instance, no key, no path.
    sourceUrl: text("source_url").notNull(),
    // The source team or organization the token read, when it would say.
    orgName: text("org_name"),
    // `'dokploy'` | `'coolify'`. Decided once at Connect and never re-derived: the
    // runner resumes hours later from this row, and a detection that answered
    // differently would point the data cutover at the wrong API.
    platform: text("platform").notNull().default("dokploy"),
    actor: text("actor").notNull(),
    // `'running'` | `'done'` | `'failed'`.
    status: text("status").notNull(),
    created: integer("created").notNull(),
    skipped: integer("skipped").notNull(),
    failed: integer("failed").notNull(),
    manual: integer("manual").notNull(),
    error: text("error"),
    startedAt: isoTimestamptz("started_at").notNull(),
    finishedAt: isoTimestamptz("finished_at"),
    // The source panel's API token, encrypted, for as long as the run needs it - NULL
    // the moment it leaves `running`. A deliberate reversal of "the key is never
    // stored".
    apiKeyEnc: text("api_key_enc"),
    // Progress the SERVER owns, so every viewer sees the same numbers.
    totalSteps: integer("total_steps").notNull().default(0),
    doneSteps: integer("done_steps").notNull().default(0),
    // What it is on right now, as a person would say it.
    stepLabel: text("step_label"),
    // `'config'` | `'data'` | `'done'`.
    phase: text("phase").notNull().default("config"),
    // Stop is a REQUEST: the thing that stops runs elsewhere and checks between steps.
    stopRequested: boolean("stop_requested").notNull().default(false),
    // More teams of the same panel are still to come, so this run must NOT take
    // Deplo's agents off the source machines when it ends - the next team reads the
    // same disks. False on the last run of a series.
    keepSources: boolean("keep_sources").notNull().default(false),
    // When the person who started it closed its report - and NULL for as long as
    // they have not.
    reportSeenAt: isoTimestamptz("report_seen_at"),
    // Liveness of whichever process is driving it; cold means take it over.
    heartbeatAt: isoTimestamptz("heartbeat_at"),
    runnerOwner: text("runner_owner"),
    // WHO started it, as an id - `actor` is the display name for the trail. The
    // runner re-enters every normal gate under this identity via
    // `runWithIdentity`, the same way the deploy hook and the MCP server do.
    actorUserId: text("actor_user_id"),
    // The runs of ONE walk of the wizard, grouped: several teams of the same
    // panel are several runs, and the id of the first is what says so. NULL on
    // every run made before the queue moved out of the browser tab.
    sessionId: text("session_id"),
  },
  (t) => [
    index("migration_runs_team_started_idx").on(
      t.teamId,
      t.startedAt.desc(),
      t.seq.desc(),
    ),
    index("migration_runs_session_idx").on(t.sessionId, t.seq),
  ],
);

// migrationRunMembers - one person the panel listed on a migrated team, and what became of them here.
export const migrationRunMembers = pgTable(
  "migration_run_members",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name").notNull(),
    // What they were over there, for the note that says to grant it here.
    sourceRole: text("source_role").notNull().default(""),
    // `'created'` | `'manual'` | `'skipped'` | `'failed'` - as the report reads it.
    outcome: text("outcome").notNull(),
    message: text("message"),
    // The single-use link minted for them, when they had no account here. ONE per
    // person per session: a second team of the same panel adds itself to this link
    // rather than minting a second one.
    linkId: text("link_id"),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("migration_run_members_run_email_uq").on(t.runId, t.email),
  ],
);

// migrationRunDbHosts - `old host -> new host` for every database a run created, kept across its projects.
export const migrationRunDbHosts = pgTable(
  "migration_run_db_hosts",
  {
    runId: text("run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "cascade" }),
    sourceHost: text("source_host").notNull(),
    targetHost: text("target_host").notNull(),
    // The Environment the database landed in - a rewrite across two is a note.
    environmentId: text("environment_id"),
  },
  (t) => [primaryKey({ columns: [t.runId, t.sourceHost] })],
);

// migrationRunItems - one line of a run's report: created, skipped, refused, or manual.
export const migrationRunItems = pgTable(
  "migration_run_items",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    // `Project / Environment / service`, as the user saw it on the panel.
    path: text("path").notNull(),
    // What it was over there: `application` | `compose` | `postgres` | `domain` | ...
    sourceKind: text("source_kind").notNull(),
    sourceName: text("source_name").notNull(),
    // When it happened. A report read afterwards is a list; read WHILE it runs
    // it is a log, and a log with no times is not one.
    at: isoTimestamptz("at"),
    // The source service id this row came from, when the row IS a service. Null
    // on the rows that are not a service (a project, a domain, a note) and on
    // every row written before it existed.
    sourceId: text("source_id"),
    // `'created'` | `'skipped'` | `'failed'` | `'manual'`.
    outcome: text("outcome").notNull(),
    // What it became here: `app` | `database` | `project` | `environment` | ...
    targetKind: text("target_kind"),
    targetId: text("target_id"),
    message: text("message"),
  },
  (t) => [index("migration_run_items_run_idx").on(t.runId, t.seq)],
);
