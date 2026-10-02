import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import { schema } from "../db/schema";

// Which key a re-keyed column is sealed with: lib/crypto's `secrets`, or Better Auth's own.
export type MoveKey = "secrets" | "better-auth";

export type TablePolicy =
  | {
      kind: "copy";
      // Opened on the old Deplo, sealed again under the new one's DEPLO_SECRET.
      rekey?: Readonly<Record<string, MoveKey>>;
      // The new Deplo keeps its own value: the table is merged by primary key, never wiped.
      keepTarget?: readonly string[];
      // Written NULL: the row they point at is not copied.
      nullOnCopy?: readonly string[];
      // Inserted NULL and set once every table is in: they close a foreign-key cycle.
      deferred?: readonly string[];
    }
  // Never copied; `clear` empties it on the new Deplo when the copy lands.
  | { kind: "skip"; clear?: boolean }
  // Belongs to the machine it is on: never copied, never wiped.
  | { kind: "local" };

const COPY: TablePolicy = { kind: "copy" };
const SECRET: MoveKey = "secrets";
const BA: MoveKey = "better-auth";

export const MOVE_TABLES: Readonly<Record<string, TablePolicy>> = {
  account: COPY,
  activities: COPY,
  api_token_apps: COPY,
  api_token_capabilities: COPY,
  api_token_folders: COPY,
  api_token_projects: COPY,
  api_token_teams: COPY,
  api_tokens: COPY,
  app_basic_auth_users: { kind: "copy", rekey: { password_enc: SECRET } },
  app_build: COPY,
  app_build_method_settings: COPY,
  app_environments: COPY,
  app_grants: COPY,
  app_mounts: COPY,
  app_ports: COPY,
  app_preview_env_vars: { kind: "copy", rekey: { value_enc: SECRET } },
  app_previews: { kind: "copy", deferred: ["latest_deployment_id"] },
  app_volumes: COPY,
  apps: {
    kind: "copy",
    rekey: { deploy_hook_token_enc: SECRET },
    deferred: ["latest_deployment_id"],
  },
  backup_destination: {
    kind: "copy",
    rekey: {
      access_key_enc: SECRET,
      secret_key_enc: SECRET,
      age_identity_enc: SECRET,
    },
  },
  backup_runs: COPY,
  backups: COPY,
  cron_job_env: { kind: "copy", rekey: { value_enc: SECRET } },
  cron_jobs: COPY,
  cron_runs: COPY,
  database_mounts: COPY,
  databases: { kind: "copy", rekey: { connection_string_enc: SECRET } },
  deplo_move_servers: { kind: "local" },
  deplo_moves: { kind: "local" },
  deployment_logs: COPY,
  deployments: COPY,
  docker_cleanup_excluded_servers: COPY,
  docker_cleanup_policy: COPY,
  docker_cleanup_policy_scopes: COPY,
  docker_cleanup_run_items: COPY,
  docker_cleanup_runs: COPY,
  domain_middlewares: COPY,
  domains: COPY,
  env_var_targets: COPY,
  env_vars: { kind: "copy", rekey: { value_enc: SECRET } },
  environment_grants: COPY,
  environments: COPY,
  folder_grants: COPY,
  folders: { kind: "copy", deferred: ["parent_id"] },
  git_connections: {
    kind: "copy",
    rekey: { token_enc: SECRET, webhook_secret_enc: SECRET },
  },
  github_apps: {
    kind: "copy",
    rekey: {
      client_secret_enc: SECRET,
      webhook_secret_enc: SECRET,
      private_key_enc: SECRET,
    },
  },
  github_installation: COPY,
  installed_plugins: COPY,
  instance_settings: {
    kind: "copy",
    rekey: { vapid_private_key_enc: SECRET },
    // What describes this machine and this install; the network sweep and agent rollout describe the fleet, which moves.
    keepTarget: [
      "panel_url",
      "panel_fallback_disabled",
      "booted_version",
      "takeover_platform",
      "takeover_state",
      "takeover_error",
      "takeover_run_id",
      "takeover_seen_external_at",
      "usage_reports_enabled",
      "usage_instance_id",
      "usage_instance_id_minted_at",
      "usage_report_sent_at",
      "welcome_seen_at",
    ],
  },
  invite_capabilities: COPY,
  invites: COPY,
  membership_capabilities: COPY,
  memberships: COPY,
  migration_run_db_hosts: COPY,
  migration_run_items: COPY,
  migration_run_members: COPY,
  migration_run_servers: COPY,
  migration_run_targets: COPY,
  migration_runs: { kind: "copy", rekey: { api_key_enc: SECRET } },
  migration_source_addresses: COPY,
  monitoring_settings: COPY,
  notification_alerts: COPY,
  notification_channels: {
    kind: "copy",
    rekey: { secret_enc: SECRET, secret2_enc: SECRET },
  },
  oauth_access_token: { kind: "copy", nullOnCopy: ["session_id"] },
  oauth_client: { kind: "copy", rekey: { client_secret: BA } },
  // A replay cache of assertion ids that expire within minutes.
  oauth_client_assertion: { kind: "skip" },
  oauth_client_resource: COPY,
  oauth_consent: COPY,
  oauth_refresh_token: {
    kind: "copy",
    rekey: { rotation_replay_response: BA },
    nullOnCopy: ["session_id"],
  },
  oauth_resource: COPY,
  passkey: COPY,
  pending_teardowns: COPY,
  project_grants: COPY,
  projects: COPY,
  push_subscriptions: COPY,
  rate_limits: { kind: "skip" },
  registration_link_team_capabilities: COPY,
  registration_link_teams: COPY,
  registration_links: { kind: "copy", rekey: { token_enc: SECRET } },
  registries: { kind: "copy", rekey: { password_enc: SECRET } },
  scheduler_lease: { kind: "skip" },
  server_teams: COPY,
  servers: COPY,
  // Signed with the old Deplo's key, so everyone signs in again on the new one.
  session: { kind: "skip", clear: true },
  shared_env_var_apps: COPY,
  shared_env_var_environments: COPY,
  shared_env_var_projects: COPY,
  shared_env_var_targets: COPY,
  shared_env_var_teams: COPY,
  shared_env_vars: { kind: "copy", rekey: { value_enc: SECRET } },
  team_app_order: COPY,
  team_database_order: COPY,
  team_folder_order: COPY,
  team_project_order: COPY,
  team_role_capabilities: COPY,
  team_role_scope_apps: COPY,
  team_role_scope_environments: COPY,
  team_role_scope_folders: COPY,
  team_role_scope_projects: COPY,
  team_roles: COPY,
  teams: COPY,
  two_factor: { kind: "copy", rekey: { secret: BA, backup_codes: BA } },
  users: COPY,
  verification: { kind: "skip", clear: true },
};

export interface ForeignKey {
  table: string;
  columns: string[];
  foreignTable: string;
  foreignColumns: string[];
  onDelete: string;
}

// Constraints that exist only in the SQL migrations, so drizzle's schema cannot report them.
export const SQL_ONLY_FOREIGN_KEYS: readonly ForeignKey[] = [
  {
    table: "api_tokens",
    columns: ["oauth_client_id"],
    foreignTable: "oauth_client",
    foreignColumns: ["client_id"],
    onDelete: "cascade",
  },
];

export interface TableShape {
  name: string;
  columns: string[];
  notNull: Set<string>;
  primaryKey: string[];
}

let shapes: Map<string, TableShape> | null = null;
let fks: ForeignKey[] | null = null;
let order: string[] | null = null;

function pgTables(): PgTable[] {
  return (Object.values(schema) as unknown[]).filter((v): v is PgTable =>
    is(v, PgTable),
  );
}

export function tableShapes(): Map<string, TableShape> {
  if (shapes) return shapes;
  shapes = new Map();
  for (const t of pgTables()) {
    const c = getTableConfig(t);
    const primaryKey = c.primaryKeys[0]?.columns.map((col) => col.name) ?? [];
    shapes.set(c.name, {
      name: c.name,
      columns: c.columns.map((col) => col.name),
      notNull: new Set(
        c.columns.filter((col) => col.notNull).map((col) => col.name),
      ),
      primaryKey: primaryKey.length
        ? primaryKey
        : c.columns.filter((col) => col.primary).map((col) => col.name),
    });
  }
  return shapes;
}

export function foreignKeys(): ForeignKey[] {
  if (fks) return fks;
  fks = [...SQL_ONLY_FOREIGN_KEYS];
  for (const t of pgTables()) {
    const c = getTableConfig(t);
    for (const fk of c.foreignKeys) {
      const ref = fk.reference();
      fks.push({
        table: c.name,
        columns: ref.columns.map((col) => col.name),
        foreignTable: getTableConfig(ref.foreignTable).name,
        foreignColumns: ref.foreignColumns.map((col) => col.name),
        onDelete: fk.onDelete ?? "no action",
      });
    }
  }
  return fks;
}

export function policyOf(table: string): TablePolicy {
  const p = MOVE_TABLES[table];
  if (!p) throw new Error(`Table ${table} has no Deplo move policy.`);
  return p;
}

export function copyPolicy(table: string) {
  const p = policyOf(table);
  if (p.kind !== "copy") throw new Error(`Table ${table} is not copied.`);
  return p;
}

// A foreign key the copy order honours: both ends copied, not a self-reference, no deferred column.
export function orderingEdge(fk: ForeignKey): boolean {
  if (fk.table === fk.foreignTable) return false;
  const from = MOVE_TABLES[fk.table];
  const to = MOVE_TABLES[fk.foreignTable];
  if (from?.kind !== "copy" || to?.kind !== "copy") return false;
  return !fk.columns.some((c) => from.deferred?.includes(c));
}

// Parents before children; ties broken by name, so both Deplos compute the same list.
export function copyOrder(): string[] {
  if (order) return order;
  const tables = [...tableShapes().keys()]
    .filter((t) => MOVE_TABLES[t]?.kind === "copy")
    .sort();
  const parents = new Map(tables.map((t) => [t, new Set<string>()]));
  for (const fk of foreignKeys())
    if (orderingEdge(fk)) parents.get(fk.table)!.add(fk.foreignTable);
  const out: string[] = [];
  const placed = new Set<string>();
  while (out.length < tables.length) {
    const next = tables.find(
      (t) => !placed.has(t) && [...parents.get(t)!].every((p) => placed.has(p)),
    );
    if (!next) {
      const rest = tables.filter((t) => !placed.has(t));
      throw new Error(
        `Foreign keys form a cycle between ${rest.join(", ")}: defer one of the columns in lib/deplo-move/tables.ts.`,
      );
    }
    out.push(next);
    placed.add(next);
  }
  order = out;
  return out;
}

// The foreign-key columns of a merged table that point into copied tables: NULL while the copy runs.
export function mergeForeignColumns(table: string): string[] {
  return foreignKeys()
    .filter(
      (fk) =>
        fk.table === table && MOVE_TABLES[fk.foreignTable]?.kind === "copy",
    )
    .flatMap((fk) => fk.columns);
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
