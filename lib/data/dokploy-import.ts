import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  databases as databasesTable,
  dokployImportItems as itemsTable,
  dokployImports as runsTable,
  domains as domainsTable,
  sharedEnvVars as sharedVarsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { newId, nowIso } from "../ids";
import { mapLimit } from "../utils";
import { getCurrentUser } from "../auth";
import {
  canExposePorts,
  canMountHostVolumes,
  requireActiveTeamId,
  requireCapability,
  requireInstanceAdmin,
  requireTeamWide,
} from "../membership";
import { assertSafeOutboundUrl } from "../outbound-url";
import {
  composeBuildReachesHost,
  composeClaimsReservedName,
  composeHasHostBindMount,
  composeJoinsForeignNetwork,
  composeMountsForeignStorage,
  composeNeedsHostPrivileges,
  composePublishesPorts,
  composeUsesExternalMerge,
} from "../deploy/compose-lint";
import type { BuildConfig, VolumeMount } from "../types";

import {
  DOKPLOY_DB_KINDS,
  activeOrganizationName,
  getApplication,
  getCompose,
  getConvertedCompose,
  getDatabase,
  listMembers,
  listProjects as listDokployProjects,
  listSchedules,
  listServers,
  normalizeDokployBaseUrl,
  type DokployApplication,
  type DokployCompose,
  type DokployCredential,
  type DokployDatabase,
  type DokployDbKind,
  type DokployEnvironment,
  type DokployProject,
} from "../dokploy/client";
import {
  deploEngineFor,
  envNeedsInterpolation,
  mapBuildSettings,
  mapDatabase,
  mapDomains,
  mapMounts,
  mapResources,
  mapSource,
  parseEnvBlob,
  portNotes,
  stripDokployNetwork,
  unsupportedNotes,
  type MappedDomain,
} from "../dokploy/map";

import { addBasicAuthUser } from "./basic-auth";
import { addExistingMember, mintRegistrationLink } from "./members";
import { createApp, isSecretKey, setAppVolumes, updateAppResources } from "./apps";
import { createCronJob } from "./crons";
import { createDatabase, updateDatabaseImage } from "./databases";
import { addDomain, updateDomain } from "./domains";
import { createEnvironment, listEnvironmentsForProject } from "./environments";
import { createProject, defaultEnvironmentFor, listProjects } from "./projects";
import { listServersForTeam } from "./servers";
import { saveSharedVar } from "./shared-vars";
import { recordActivity } from "./activity";

/**
 * Import a Dokploy instance's projects into this team.
 *
 * ONE source of truth: Dokploy's own HTTP API (`lib/dokploy/client.ts`). No SSH,
 * no reading its database, no shell on either host — which is what lets the same
 * code serve the remote case (Dokploy on another VPS) and the internal one
 * (Dokploy on this VPS, reached over the docker bridge). The source instance is
 * only ever READ: it keeps running, and stays the rollback.
 *
 * Three rules shape everything here:
 *
 *  1. **Nothing is deployed.** Every app is created with `deploy: false`. Dokploy
 *     is still answering those hostnames; deploying as they land would fight the
 *     live system for ports and for ACME.
 *  2. **One try/catch per object.** A refused gate, a hostname another team owns,
 *     a compose file that needs a grant — each becomes a row in the report and
 *     the import carries on. An import that dies on app seven is worse than one
 *     that tells you app seven needs attention.
 *  3. **Whatever cannot come across is SAID.** A `manual` report row is the only
 *     thing between "imported" and "silently half-imported": the private repo
 *     with no credential, the database whose host name changed, the published
 *     port deplo does not do. Nothing is dropped in silence.
 *
 * Authorization is deplo's normal boundary, unchanged: the entry gate is
 * `create_projects` on a team-wide principal, and every object then goes through
 * the SAME `lib/data` function the UI calls, so it re-checks its own capability
 * (`create_apps`, `create_databases`, `manage_domains`, `manage_env`, …). An
 * importer that bypassed those would be a second authorization path, and there
 * must never be one — so a caller missing `create_databases` gets databases in
 * the report as `failed`, not a privileged shortcut.
 *
 * Everything lands in the ACTIVE team. `requireActiveTeamId` is memoized per
 * request (React `cache`), so switching team mid-request would not be seen by the
 * calls that follow it; the wizard therefore switches team FIRST (the existing
 * `createTeam` / `switchTeam` mutations) and imports afterwards.
 */

/* ------------------------------------------------------------------ */
/* DTOs                                                               */
/* ------------------------------------------------------------------ */

/** What one Dokploy service would become here, and whether it can. */
export type PlanStatus = "new" | "exists" | "unsupported" | "needs_grant";

export interface PlanService {
  sourceId: string;
  /** `application` | `compose` | one of the five engine tables. */
  kind: string;
  name: string;
  /** `app` | `database`, or null when Deplo has no such thing. */
  targetKind: string | null;
  status: PlanStatus;
  /** The Dokploy server it runs on; empty string means Dokploy's own host. */
  sourceServerId: string;
  /** Hostnames that would be imported (the throwaway ones already dropped). */
  domains: string[];
  notes: string[];
}

export interface PlanEnvironment {
  sourceId: string;
  name: string;
  exists: boolean;
  services: PlanService[];
}

export interface PlanProject {
  sourceId: string;
  name: string;
  exists: boolean;
  environments: PlanEnvironment[];
}

export interface PlanServer {
  sourceId: string;
  name: string;
  ipAddress: string | null;
}

export interface PlanMember {
  email: string;
  name: string;
  /** The role they held on Dokploy, for the admin to act on. Not imported. */
  sourceRole: string;
  /** Already has a deplo account (matched on email). */
  hasAccount: boolean;
  /** Already a member of this team. */
  inTeam: boolean;
}

export interface DokployPlan {
  sourceUrl: string;
  orgName: string | null;
  projects: PlanProject[];
  servers: PlanServer[];
  members: PlanMember[];
}

export interface ImportItemDTO {
  path: string;
  sourceKind: string;
  sourceName: string;
  outcome: string;
  targetKind: string | null;
  targetId: string | null;
  message: string | null;
}

export interface ImportRunDTO {
  id: string;
  sourceUrl: string;
  orgName: string | null;
  actor: string;
  status: string;
  created: number;
  skipped: number;
  failed: number;
  manual: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ImportProjectResult {
  projectName: string;
  created: number;
  skipped: number;
  failed: number;
  manual: number;
  items: ImportItemDTO[];
}

export interface DokployInvite {
  email: string;
  name: string;
  /** The single-use registration link, or null when they were added directly. */
  link: string | null;
  outcome: string;
  message: string | null;
}

/** How a Dokploy server maps onto one of ours. `from: ""` is Dokploy's own host. */
export interface ServerChoice {
  from: string;
  to: string;
}

export interface ConnectInput {
  url: string;
  apiKey: string;
  /**
   * Reach an address `lib/outbound-url.ts` would refuse — which is what the
   * internal migration needs (`http://172.17.0.1:3000`). Instance admin only,
   * exactly like `allowPrivateEndpoint` on a git connection or an S3 endpoint.
   */
  allowPrivate?: boolean;
}

/* ------------------------------------------------------------------ */
/* Gates                                                              */
/* ------------------------------------------------------------------ */

/**
 * The entry gate. `create_projects` is the smallest capability that can produce
 * what an import produces, and `requireTeamWide` refuses a narrowed API token or
 * a member on a project-scoped role: an import writes across the whole team, so a
 * principal that only reaches one corner of it must not start one.
 */
async function assertImportGate(): Promise<{ teamId: string }> {
  await requireTeamWide("import from Dokploy");
  const { teamId } = await requireCapability("create_projects");
  return { teamId };
}

/**
 * Turn the typed address + key into a credential, refusing an address deplo must
 * not dial. Same shape as `connectGitProvider`: the private-address escape hatch
 * asserts instance admin AT the decision, never inherits it from a caller.
 */
async function credentialFor(input: ConnectInput): Promise<DokployCredential> {
  const baseUrl = normalizeDokployBaseUrl(input.url);
  if (input.allowPrivate) await requireInstanceAdmin();
  else await assertSafeOutboundUrl(baseUrl, "Dokploy address", { allowHttp: true });
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("Paste the Dokploy API key");
  return { baseUrl, apiKey };
}

/* ------------------------------------------------------------------ */
/* Reading the source tree                                            */
/* ------------------------------------------------------------------ */

/** One Dokploy service, flattened out of the per-kind arrays on an environment. */
interface SourceService {
  kind: "application" | "compose" | DokployDbKind;
  id: string;
  name: string;
  serverId: string;
}

function servicesOf(env: DokployEnvironment): SourceService[] {
  const out: SourceService[] = [];
  for (const a of env.applications ?? [])
    out.push({
      kind: "application",
      id: a.applicationId,
      name: a.name,
      serverId: a.serverId ?? "",
    });
  for (const c of env.compose ?? [])
    out.push({
      kind: "compose",
      id: c.composeId,
      name: c.name,
      serverId: c.serverId ?? "",
    });
  for (const kind of DOKPLOY_DB_KINDS)
    for (const row of (env[kind] ?? []) as DokployDatabase[]) {
      const id = row[`${kind}Id`];
      if (typeof id !== "string") continue;
      out.push({ kind, id, name: row.name, serverId: row.serverId ?? "" });
    }
  return out;
}

/** The detail call for one service — the only shape difference between kinds. */
async function loadService(
  c: DokployCredential,
  svc: SourceService,
): Promise<DokployApplication | DokployCompose | DokployDatabase> {
  if (svc.kind === "application") return getApplication(c, svc.id);
  if (svc.kind === "compose") return getCompose(c, svc.id);
  return getDatabase(c, svc.kind, svc.id);
}

/* ------------------------------------------------------------------ */
/* Scan                                                               */
/* ------------------------------------------------------------------ */

/**
 * Read the source instance and describe what an import would do — without
 * writing anything.
 *
 * The per-service detail calls run here, not only at import time, because the
 * preview has to be able to say the three things that would otherwise only
 * surface as a failure halfway through: this hostname belongs to another team,
 * this compose needs a grant you do not hold, this engine does not exist here.
 * The lint predicates run against the ALREADY-REWRITTEN compose, so the answer
 * the preview gives is the answer the import will get.
 */
export async function scanDokploy(input: ConnectInput): Promise<DokployPlan> {
  const { teamId } = await assertImportGate();
  const c = await credentialFor(input);

  const [orgName, servers, projects] = await Promise.all([
    activeOrganizationName(c),
    listServers(c).catch(() => []),
    listDokployProjects(c),
  ]);

  const existing = await existingNames(teamId);
  const mayMountHost = await canMountHostVolumes();
  const mayExposePorts = await canExposePorts();
  const foreignHosts = await hostnamesOwnedElsewhere(teamId);

  const planned: PlanProject[] = [];
  for (const p of projects) {
    const projectKey = p.name.trim().toLowerCase();
    const existingProject = existing.projects.get(projectKey) ?? null;
    const environments: PlanEnvironment[] = [];

    for (const env of p.environments ?? []) {
      const envKey = env.name.trim().toLowerCase();
      const existingEnv = existingProject
        ? (existing.environments.get(`${existingProject}:${envKey}`) ?? null)
        : null;

      const list = servicesOf(env);
      const services: PlanService[] = new Array(list.length);
      // `mapLimit` runs the callback for its side effects, so the slot is filled
      // by index — which is also what keeps the preview in Dokploy's own order.
      await mapLimit(
        list.map((svc, index) => ({ svc, index })),
        5,
        async ({ svc, index }) => {
        const line: PlanService = {
          sourceId: svc.id,
          kind: svc.kind,
          name: svc.name,
          targetKind:
            svc.kind === "compose" || svc.kind === "application"
              ? "app"
              : deploEngineFor(svc.kind)
                ? "database"
                : null,
          status: "new",
          sourceServerId: svc.serverId,
          domains: [],
          notes: [],
        };
        // An engine Deplo does not have is settled here, without a detail call:
        // asking about a libsql row we can do nothing with would turn a plain
        // fact into an HTTP 404 in the report.
        if (line.targetKind === null) {
          line.status = "unsupported";
          line.notes.push(`Deplo has no ${svc.kind} engine.`);
          services[index] = line;
          return;
        }

        let detail: DokployApplication | DokployCompose | DokployDatabase;
        try {
          detail = await loadService(c, svc);
        } catch (e) {
          line.status = "unsupported";
          line.notes.push(
            e instanceof Error ? e.message : "Dokploy would not return this service.",
          );
          services[index] = line;
          return;
        }

        if (line.targetKind === "database") {
          const key = svc.name.trim().toLowerCase();
          if (existing.databases.has(key)) line.status = "exists";
          line.notes.push(...mapDatabase(svc.kind as DokployDbKind, detail as DokployDatabase).notes);
          services[index] = line;
          return;
        }

        // Apps: name is unique per (project, environment) for our purposes.
        const homeKey = existingEnv ? `${existingEnv}:${svc.name.trim().toLowerCase()}` : null;
        if (homeKey && existing.apps.has(homeKey)) line.status = "exists";

        const isCompose = svc.kind === "compose";
        const domains = mapDomains(
          (detail as DokployApplication).domains,
          { isCompose },
        );
        line.domains = domains.value.map((d) => d.host);
        line.notes.push(...domains.notes);
        for (const host of line.domains)
          if (foreignHosts.has(host))
            line.notes.push(
              `${host} is already routed by another team on this Deplo - it will be skipped.`,
            );

        if (isCompose) {
          const yamlText = (detail as DokployCompose).composeFile ?? "";
          const rewritten = stripDokployNetwork(yamlText);
          const blocked = composeBlockers(rewritten.compose, {
            mayMountHost,
            mayExposePorts,
          });
          if (!yamlText.trim())
            line.notes.push(
              "The compose file lives in a git repository - Deplo will try to fetch the resolved file at import time.",
            );
          if (rewritten.changed)
            line.notes.push("Dokploy's shared network will be removed from the compose file.");
          if (blocked.length > 0 && line.status === "new") {
            line.status = "needs_grant";
            line.notes.push(...blocked);
          }
        } else {
          const app = detail as DokployApplication;
          line.notes.push(...mapSource(app).notes);
          line.notes.push(...mapBuildSettings(app).notes);
          line.notes.push(...portNotes(app));
          line.notes.push(...unsupportedNotes(app));
          if ((app.mounts ?? []).some((m) => m.type === "bind") && !mayMountHost) {
            line.status = line.status === "exists" ? "exists" : "needs_grant";
            line.notes.push(
              "Has a bind mount of a host folder, which needs the host-volumes grant.",
            );
          }
        }
        services[index] = line;
        },
      );

      environments.push({
        sourceId: env.environmentId,
        name: env.name,
        exists: existingEnv != null,
        services,
      });
    }

    planned.push({
      sourceId: p.projectId,
      name: p.name,
      exists: existingProject != null,
      environments,
    });
  }

  return {
    sourceUrl: c.baseUrl,
    orgName,
    projects: planned,
    servers: servers.map((s) => ({
      sourceId: s.serverId,
      name: s.name,
      ipAddress: s.ipAddress ?? null,
    })),
    members: await planMembers(c, teamId),
  };
}

/**
 * Which of deplo's compose gates this file would trip, as sentences.
 *
 * Deliberately the SAME predicates `createApp` runs (`lib/deploy/compose-lint.ts`),
 * because the preview has no business disagreeing with the write path. The two
 * hard refusals (`extends`/`include`/`label_file`, and claiming a reserved name on
 * the shared network) have no grant that lifts them and are reported as such.
 */
function composeBlockers(
  compose: string,
  grants: { mayMountHost: boolean; mayExposePorts: boolean },
): string[] {
  const out: string[] = [];
  const merge = composeUsesExternalMerge(compose);
  if (merge)
    out.push(
      `Uses \`${merge}\`, which Deplo refuses in a compose file - inline what it pulls in.`,
    );
  const reserved = composeClaimsReservedName(compose);
  if (reserved)
    out.push(
      `A service is called "${reserved}", a name Deplo's own infrastructure uses on the shared network - rename it.`,
    );
  if (!grants.mayExposePorts && composePublishesPorts(compose))
    out.push("Publishes host ports, which needs the expose-ports grant.");
  if (
    !grants.mayMountHost &&
    (composeHasHostBindMount(compose) ||
      composeNeedsHostPrivileges(compose) ||
      composeMountsForeignStorage(compose) ||
      composeBuildReachesHost(compose) ||
      composeJoinsForeignNetwork(compose))
  )
    out.push(
      "Reaches the host (a bind mount, a privilege, an external volume or network), which needs the host-volumes grant.",
    );
  return out;
}

/** Everything already in this team, by lowercase name, for the skip decision. */
async function existingNames(teamId: string): Promise<{
  projects: Map<string, string>;
  environments: Map<string, string>;
  apps: Map<string, string>;
  databases: Map<string, string>;
}> {
  const projects = new Map<string, string>();
  const environments = new Map<string, string>();
  for (const p of await listProjects()) {
    projects.set(p.name.trim().toLowerCase(), p.id);
    for (const e of await listEnvironmentsForProject(p.id))
      environments.set(`${p.id}:${e.name.trim().toLowerCase()}`, e.id);
  }

  const appRows = await getDb()
    .select({
      id: appsTable.id,
      name: appsTable.name,
      environmentId: appsTable.environmentId,
    })
    .from(appsTable)
    .where(eq(appsTable.teamId, teamId));
  const apps = new Map<string, string>();
  for (const a of appRows)
    if (a.environmentId)
      apps.set(`${a.environmentId}:${a.name.trim().toLowerCase()}`, a.id);

  const dbRows = await getDb()
    .select({ id: databasesTable.id, name: databasesTable.name })
    .from(databasesTable)
    .where(eq(databasesTable.teamId, teamId));
  const databases = new Map<string, string>();
  for (const d of dbRows) databases.set(d.name.trim().toLowerCase(), d.id);

  return { projects, environments, apps, databases };
}

/**
 * Every hostname on this instance that belongs to a DIFFERENT team.
 *
 * `addDomain` refuses those (`assertHostnameNotAnotherTeams` — a hostname belongs
 * to one team), and `createApp`'s auto-domain silently falls back to a generated
 * name instead. Knowing the set up front is what lets the preview say so before
 * anything is written.
 */
async function hostnamesOwnedElsewhere(teamId: string): Promise<Set<string>> {
  const rows = await getDb()
    .select({ name: domainsTable.name, teamId: appsTable.teamId })
    .from(domainsTable)
    .innerJoin(appsTable, eq(appsTable.id, domainsTable.appId));
  const out = new Set<string>();
  for (const r of rows)
    if (r.teamId !== teamId) out.add(r.name.trim().toLowerCase());
  return out;
}

/** Dokploy's members, told apart by whether they already exist here. */
async function planMembers(
  c: DokployCredential,
  teamId: string,
): Promise<PlanMember[]> {
  let rows: Awaited<ReturnType<typeof listMembers>>;
  try {
    rows = await listMembers(c);
  } catch {
    // A member-scoped key cannot list the organization. Not knowing who is on the
    // other side must not stop a project import.
    return [];
  }

  const people = rows
    .map((m) => ({
      email: (m.user?.email ?? m.email ?? "").trim().toLowerCase(),
      name: (m.user?.name ?? m.name ?? "").trim(),
      sourceRole: (m.role ?? "member").trim(),
    }))
    .filter((p) => p.email.includes("@"));
  if (people.length === 0) return [];

  const accounts = await getDb()
    .select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable)
    .where(
      inArray(
        sql`lower(${usersTable.email})`,
        people.map((p) => p.email),
      ),
    );
  const byEmail = new Map(accounts.map((a) => [a.email.toLowerCase(), a.id]));
  const memberIds = new Set(await teamMemberIds(teamId));

  return people.map((p) => {
    const userId = byEmail.get(p.email) ?? null;
    return {
      ...p,
      name: p.name || p.email,
      hasAccount: userId != null,
      inTeam: userId != null && memberIds.has(userId),
    };
  });
}

async function teamMemberIds(teamId: string): Promise<string[]> {
  const rows = await getDb().execute<{ user_id: string }>(
    sql`select user_id from memberships where team_id = ${teamId}`,
  );
  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
  return (list as { user_id: string }[]).map((r) => r.user_id);
}

/* ------------------------------------------------------------------ */
/* The run + its report                                               */
/* ------------------------------------------------------------------ */

/**
 * Open a run. Any run this team left `running` is closed as failed first: the only
 * way one stays open is a tab that went away, and a history with two live runs in
 * it cannot be read. That is also why there is no boot reconcile to add.
 */
export async function beginDokployImport(input: {
  url: string;
  orgName?: string | null;
}): Promise<string> {
  const { teamId } = await assertImportGate();
  const user = await getCurrentUser();
  const db = getDb();
  const now = nowIso();

  await db
    .update(runsTable)
    .set({ status: "failed", error: "Interrupted", finishedAt: now })
    .where(and(eq(runsTable.teamId, teamId), eq(runsTable.status, "running")));

  const id = newId("dimp");
  await db.insert(runsTable).values({
    id,
    teamId,
    sourceUrl: normalizeDokployBaseUrl(input.url),
    orgName: input.orgName?.trim() || null,
    actor: user?.name ?? "someone",
    status: "running",
    created: 0,
    skipped: 0,
    failed: 0,
    manual: 0,
    error: null,
    startedAt: now,
    finishedAt: null,
  });
  return id;
}

/** Close a run. Idempotent: a finished run is left alone. */
export async function finishDokployImport(runId: string): Promise<void> {
  const { teamId } = await assertImportGate();
  await refreshCounts(runId, teamId);
  await getDb()
    .update(runsTable)
    .set({ status: "done", finishedAt: nowIso() })
    .where(
      and(
        eq(runsTable.id, runId),
        eq(runsTable.teamId, teamId),
        eq(runsTable.status, "running"),
      ),
    );
}

/** The open run of this team, as ids only — the writer's cheap ownership check. */
async function ownRun(runId: string, teamId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: runsTable.id })
    .from(runsTable)
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)));
  return rows.length > 0;
}

/** Recount the run's totals from its items, so the history is right even if the
 *  tab that started the import never came back. */
async function refreshCounts(runId: string, teamId: string): Promise<void> {
  const rows = await getDb()
    .select({ outcome: itemsTable.outcome })
    .from(itemsTable)
    .where(eq(itemsTable.runId, runId));
  const count = (o: string) => rows.filter((r) => r.outcome === o).length;
  await getDb()
    .update(runsTable)
    .set({
      created: count("created"),
      skipped: count("skipped"),
      failed: count("failed"),
      manual: count("manual"),
    })
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)));
}

/**
 * A report collector: rows go to the run AND come back to the caller.
 *
 * `at()` deepens the breadcrumb but SHARES the items array — the caller gets one
 * flat report for the whole project, in the order things happened. (A per-level
 * array would leave the returned report holding only the top level while the
 * database held everything, which is exactly the shape of bug that makes a
 * progress screen lie.)
 */
class Report {
  constructor(
    private readonly runId: string | null,
    private readonly path: string[] = [],
    readonly items: ImportItemDTO[] = [],
  ) {}

  /** A child collector one level deeper in the breadcrumb, same run, same list. */
  at(segment: string): Report {
    return new Report(this.runId, [...this.path, segment], this.items);
  }

  async add(entry: {
    path?: string;
    sourceKind: string;
    sourceName: string;
    outcome: "created" | "skipped" | "failed" | "manual" | "unsupported";
    targetKind?: string | null;
    targetId?: string | null;
    message?: string | null;
  }): Promise<void> {
    const row: ImportItemDTO = {
      path: entry.path ?? this.path.join(" / "),
      sourceKind: entry.sourceKind,
      sourceName: entry.sourceName,
      outcome: entry.outcome,
      targetKind: entry.targetKind ?? null,
      targetId: entry.targetId ?? null,
      message: entry.message ?? null,
    };
    this.items.push(row);
    if (!this.runId) return;
    await getDb()
      .insert(itemsTable)
      .values({ id: newId("dimi"), runId: this.runId, ...row });
  }

  /** Every note from a mapper, as its own `manual` line. */
  async notes(
    kind: string,
    name: string,
    notes: string[],
    target?: { kind: string; id: string },
  ): Promise<void> {
    for (const message of notes)
      await this.add({
        sourceKind: kind,
        sourceName: name,
        outcome: "manual",
        targetKind: target?.kind ?? null,
        targetId: target?.id ?? null,
        message,
      });
  }
}

/* ------------------------------------------------------------------ */
/* Import                                                             */
/* ------------------------------------------------------------------ */

export interface ImportProjectInput extends ConnectInput {
  runId: string;
  /** The Dokploy `projectId` to import. */
  projectId: string;
  /** Dokploy server id (or "") → deplo server id. Unmapped falls back to default. */
  servers?: ServerChoice[];
  /** Leave the databases alone (they provision containers as they are created). */
  skipDatabases?: boolean;
}

/**
 * Import ONE Dokploy project into the active team.
 *
 * One project per call on purpose: the wizard drives the loop, so progress is
 * real, every request is short, and an import interrupted halfway can be resumed
 * by running it again — the second pass skips what is already here.
 *
 * The source is re-read here rather than taken from the scan's result: the plan
 * the client holds is a rendering, and app configuration must never arrive from a
 * browser.
 */
export async function importDokployProject(
  input: ImportProjectInput,
): Promise<ImportProjectResult> {
  const { teamId } = await assertImportGate();
  const c = await credentialFor(input);
  if (!(await ownRun(input.runId, teamId)))
    throw new Error("That import run does not belong to this team.");

  const projects = await listDokployProjects(c);
  const source = projects.find((p) => p.projectId === input.projectId);
  if (!source) throw new Error("That project is no longer on the Dokploy instance.");

  const report = new Report(input.runId).at(source.name);
  const serverMap = await resolveServers(teamId, input.servers ?? [], report, source.name);

  const projectId = await ensureProject(source, report);
  if (!projectId)
    return { projectName: source.name, ...tally(report.items), items: report.items };

  for (const env of source.environments ?? []) {
    const envReport = report.at(env.name);
    const environmentId = await ensureEnvironment(projectId, env, envReport);
    if (!environmentId) continue;

    /** Apps landed in this environment — the link set for its shared vars. */
    const appIds: string[] = [];

    for (const svc of servicesOf(env)) {
      const svcReport = envReport.at(svc.name);
      try {
        if (svc.kind === "application" || svc.kind === "compose") {
          const appId = await importAppService(
            c,
            svc,
            { projectId, environmentId, serverId: serverMap.get(svc.serverId) },
            svcReport,
          );
          if (appId) appIds.push(appId);
        } else if (!input.skipDatabases) {
          await importDatabaseService(
            c,
            svc,
            serverMap.get(svc.serverId),
            svcReport,
          );
        } else {
          await svcReport.add({
            sourceKind: svc.kind,
            sourceName: svc.name,
            outcome: "skipped",
            targetKind: "database",
            message: "Databases were left out of this import.",
          });
        }
      } catch (e) {
        await svcReport.add({
          sourceKind: svc.kind,
          sourceName: svc.name,
          outcome: "failed",
          targetKind: svc.kind === "application" || svc.kind === "compose" ? "app" : "database",
          message: e instanceof Error ? e.message : "Import failed.",
        });
      }
    }

    await importSharedVars(env.env, {
      teamId,
      label: `${source.name} / ${env.name}`,
      environmentIds: [environmentId],
      projectIds: [],
      appIds,
      report: envReport,
    });
  }

  // The project-level blob is available to every app of the project, so it links
  // to all of them — the environment ones each linked their own slice above.
  const projectAppIds = await appIdsInProject(teamId, projectId);
  await importSharedVars(source.env, {
    teamId,
    label: source.name,
    environmentIds: [],
    projectIds: [projectId],
    appIds: projectAppIds,
    report,
  });

  await refreshCounts(input.runId, teamId);
  // Outside every transaction, like every other caller: `recordActivity` opens its
  // own connection and would deadlock pglite from inside one.
  await recordActivity(
    "project",
    `Imported ${source.name} from Dokploy`,
    (await getCurrentUser())?.name ?? "someone",
    null,
    teamId,
  );

  return { projectName: source.name, ...tally(report.items), items: report.items };
}

function tally(items: ImportItemDTO[]): {
  created: number;
  skipped: number;
  failed: number;
  manual: number;
} {
  const n = (o: string) => items.filter((i) => i.outcome === o).length;
  return {
    created: n("created"),
    skipped: n("skipped"),
    failed: n("failed"),
    manual: n("manual"),
  };
}

/** Dokploy server id (or "") → a deplo server this team can actually deploy to. */
async function resolveServers(
  teamId: string,
  choices: ServerChoice[],
  report: Report,
  projectName: string,
): Promise<Map<string, string | undefined>> {
  const usable = new Set(
    (await listServersForTeam(teamId))
      .filter((s) => !s.storageOnly && !s.buildOnly)
      .map((s) => s.id),
  );
  const out = new Map<string, string | undefined>();
  for (const { from, to } of choices) {
    if (usable.has(to)) out.set(from, to);
    else
      await report.add({
        path: projectName,
        sourceKind: "server",
        sourceName: from || "the Dokploy host",
        outcome: "manual",
        message:
          "The server picked for this Dokploy host is not one this team can deploy to - Deplo's default server was used instead.",
      });
  }
  return out;
}

async function ensureProject(
  source: DokployProject,
  report: Report,
): Promise<string | null> {
  const key = source.name.trim().toLowerCase();
  for (const p of await listProjects())
    if (p.name.trim().toLowerCase() === key) {
      await report.add({
        sourceKind: "project",
        sourceName: source.name,
        outcome: "skipped",
        targetKind: "project",
        targetId: p.id,
        message: "A project with this name is already here.",
      });
      return p.id;
    }
  try {
    const created = await createProject(source.name);
    await report.add({
      sourceKind: "project",
      sourceName: source.name,
      outcome: "created",
      targetKind: "project",
      targetId: created.id,
    });
    return created.id;
  } catch (e) {
    await report.add({
      sourceKind: "project",
      sourceName: source.name,
      outcome: "failed",
      targetKind: "project",
      message: e instanceof Error ? e.message : "Could not create the project.",
    });
    return null;
  }
}

/**
 * The deplo Environment for a Dokploy one.
 *
 * Matched by NAME against the three a new project already has (Development /
 * Preview / Production), because that is what a Dokploy "production" environment
 * means here — creating a second one beside it would leave every project with two
 * productions.
 */
async function ensureEnvironment(
  projectId: string,
  env: DokployEnvironment,
  report: Report,
): Promise<string | null> {
  const key = env.name.trim().toLowerCase();
  for (const e of await listEnvironmentsForProject(projectId))
    if (e.name.trim().toLowerCase() === key) {
      await report.add({
        sourceKind: "environment",
        sourceName: env.name,
        outcome: "skipped",
        targetKind: "environment",
        targetId: e.id,
        message: "This environment already exists in the project.",
      });
      return e.id;
    }
  try {
    const created = await createEnvironment(projectId, env.name);
    await report.add({
      sourceKind: "environment",
      sourceName: env.name,
      outcome: "created",
      targetKind: "environment",
      targetId: created.id,
    });
    return created.id;
  } catch (e) {
    // A name deplo reserves (`pr-<n>`) or a duplicate: fall back to the project's
    // default environment so the services still land somewhere sensible.
    const fallback = await defaultEnvironmentFor(projectId);
    await report.add({
      sourceKind: "environment",
      sourceName: env.name,
      outcome: fallback ? "manual" : "failed",
      targetKind: "environment",
      targetId: fallback?.id ?? null,
      message:
        (e instanceof Error ? e.message : "Could not create the environment.") +
        (fallback ? ` Its services went to ${fallback.name} instead.` : ""),
    });
    return fallback?.id ?? null;
  }
}

/** Every app currently filed under a project, for the shared-var link set. */
async function appIdsInProject(teamId: string, projectId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ id: appsTable.id })
    .from(appsTable)
    .where(and(eq(appsTable.teamId, teamId), eq(appsTable.projectId, projectId)));
  return rows.map((r) => r.id);
}

/* ---- applications and compose stacks -------------------------------- */

/**
 * One Dokploy application or compose stack → one deplo App, with its env vars,
 * config files, primary domain, extra domains, volumes, resource limits,
 * basic-auth users and crons.
 *
 * `createApp` does the first five in a single call (it is the same path a template
 * install takes), which is why it is worth passing everything through it rather
 * than assembling rows here: slug retries, the compose gates, placement and the
 * auto-domain all stay in one place.
 */
async function importAppService(
  c: DokployCredential,
  svc: SourceService,
  home: { projectId: string; environmentId: string; serverId: string | undefined },
  report: Report,
): Promise<string | null> {
  const isCompose = svc.kind === "compose";
  const detail = (await loadService(c, svc)) as DokployApplication & DokployCompose;

  // Already here? Leave it completely alone — a second pass must not re-write
  // someone's configuration behind their back.
  const existing = await getDb()
    .select({ id: appsTable.id, name: appsTable.name })
    .from(appsTable)
    .where(eq(appsTable.environmentId, home.environmentId));
  const match = existing.find(
    (a) => a.name.trim().toLowerCase() === svc.name.trim().toLowerCase(),
  );
  if (match) {
    await report.add({
      sourceKind: svc.kind,
      sourceName: svc.name,
      outcome: "skipped",
      targetKind: "app",
      targetId: match.id,
      message: "An app with this name is already in this environment.",
    });
    return match.id;
  }

  const notes: string[] = [];

  // Env: the service's own blob, plus its build args, which deplo passes to the
  // build as ordinary variables (agent >= 1.9.0) rather than as a second channel.
  const envEntries = parseEnvBlob(detail.env);
  const argEntries = parseEnvBlob((detail as DokployApplication).buildArgs).filter(
    (a) => !envEntries.some((e) => e.key === a.key),
  );
  const env = [...envEntries, ...argEntries];
  if (argEntries.length > 0)
    notes.push(
      `${argEntries.length} build argument(s) were imported as environment variables, which is how Deplo passes values to a build.`,
    );
  const interpolated = envNeedsInterpolation(env);
  if (interpolated.length > 0)
    notes.push(
      `These variables use Dokploy's \`\${{...}}\` templating, which Deplo does not resolve: ${interpolated.join(", ")}. Put the real values in.`,
    );

  const domains = mapDomains(detail.domains, { isCompose });
  notes.push(...domains.notes);
  const primary = domains.value[0] ?? null;
  const mounts = mapMounts(detail.mounts);
  notes.push(...mounts.notes);

  // What createApp needs to know about the source.
  let source: Parameters<typeof createApp>[0]["source"] = "upload";
  let repo: Parameters<typeof createApp>[0]["repo"] = null;
  let dockerImage: string | null = null;
  let compose: string | null = null;
  const build: Partial<BuildConfig> = {};

  if (isCompose) {
    source = "compose";
    const inline = (detail.composeFile ?? "").trim();
    const yamlText = inline || (await getConvertedCompose(c, svc.id)) || "";
    if (!yamlText.trim()) {
      await report.add({
        sourceKind: svc.kind,
        sourceName: svc.name,
        outcome: "failed",
        targetKind: "app",
        message:
          "The compose file is in a git repository and Dokploy would not hand over the resolved file. Create the app and paste the compose in.",
      });
      return null;
    }
    if (!inline)
      notes.push(
        "The compose file came from Dokploy's resolved copy of the repository - Deplo keeps it inline from now on, so changes in the repo will not follow.",
      );
    const rewritten = stripDokployNetwork(yamlText);
    compose = rewritten.compose;
    if (rewritten.changed)
      notes.push(
        "Dokploy's shared network was removed from the compose file - Deplo attaches the services to its own.",
      );
    if (detail.isolatedDeployment)
      notes.push(
        "Ran as an isolated deployment on Dokploy (its own network and volume namespace). Deplo namespaces every stack anyway, but check the service names it talks to.",
      );
  } else {
    const app = detail as DokployApplication;
    const mapped = mapSource(app);
    notes.push(...mapped.notes);
    if (mapped.value.kind === "git") {
      source = mapped.value.repo.provider === "github" ? "github" : "git";
      repo = mapped.value.repo;
    } else if (mapped.value.kind === "docker-image") {
      source = "docker-image";
      dockerImage = mapped.value.image;
    } else {
      // Nothing deployable came across (an uploaded archive, an image reference
      // deplo will not take). The app is still worth creating: its variables,
      // domains, mounts and limits are the part that takes an afternoon to retype.
      source = "upload";
      notes.push("Set the source under the app's Source settings before deploying.");
    }
    const mappedBuild = mapBuildSettings(app);
    notes.push(...mappedBuild.notes);
    Object.assign(build, mappedBuild.value);
    notes.push(...portNotes(app));
    notes.push(...unsupportedNotes(app));
  }

  // Routing port: Dokploy keeps it on the domain, deplo on the build config (a
  // domain may still override it). Taking the primary domain's port keeps the two
  // consistent from the start.
  if (primary?.port) build.port = primary.port;

  const created = await createApp({
    name: svc.name,
    source,
    repo,
    dockerImage,
    compose,
    env,
    serverId: home.serverId,
    projectId: home.projectId,
    environmentId: home.environmentId,
    build,
    autoDeploy: detail.autoDeploy ?? true,
    autoDomain: primary?.host ?? null,
    composeService: isCompose ? primary?.service ?? null : null,
    composePort: isCompose ? primary?.port ?? null : null,
    mounts: mounts.value.files.length > 0 ? mounts.value.files : null,
    deploy: false,
  });

  await report.add({
    sourceKind: svc.kind,
    sourceName: svc.name,
    outcome: "created",
    targetKind: "app",
    targetId: created.id,
    message: `${env.length} variable(s), ${mounts.value.files.length} config file(s).`,
  });
  const target = { kind: "app", id: created.id };

  // The primary domain is minted inside createApp, which falls back to a
  // generated hostname when the one we asked for is taken. Saying so is the whole
  // point: the app is up, but not on the name it used to answer.
  if (primary) {
    const landed = await getDb()
      .select({ id: domainsTable.id, name: domainsTable.name, certProvider: domainsTable.certProvider })
      .from(domainsTable)
      .where(and(eq(domainsTable.appId, created.id), eq(domainsTable.isPrimary, true)));
    if (landed[0] && landed[0].name.toLowerCase() !== primary.host)
      notes.push(
        `${primary.host} could not be taken (another team routes it, or it is not a name Deplo accepts) - the app answers on ${landed[0].name} instead.`,
      );
    else if (landed[0] && landed[0].certProvider !== primary.certProvider) {
      // createApp mints the primary domain itself and decides its certificate the
      // way a template would (`blueprintWantsTls`), so the choice made on Dokploy
      // has to be applied afterwards. It IS explicit intent - certificates are
      // opt-in here, and someone who had one over there asked for it - and doing
      // it now is the difference between an import and a to-do list of boxes to
      // re-tick on every app.
      try {
        await updateDomain(landed[0].id, { certProvider: primary.certProvider });
      } catch (e) {
        notes.push(
          `${primary.host} kept no certificate: ${e instanceof Error ? e.message : "refused"}. Pick one under Domains.`,
        );
      }
    }
  }

  for (const d of domains.value.slice(1)) await addExtraDomain(created.id, d, notes);

  if (mounts.value.volumes.length > 0) {
    try {
      await setAppVolumes(
        created.id,
        mounts.value.volumes.map((v) => ({ ...v, id: newId("vol") }) as VolumeMount),
      );
    } catch (e) {
      notes.push(
        `Volumes were not imported: ${e instanceof Error ? e.message : "refused"}. Add them under Storage.`,
      );
    }
  }

  const resources = mapResources(detail);
  notes.push(...resources.notes);
  if (resources.value) {
    try {
      await updateAppResources(created.id, resources.value);
    } catch (e) {
      notes.push(
        `Resource limits were not imported: ${e instanceof Error ? e.message : "refused"}.`,
      );
    }
  }

  for (const s of (detail as DokployApplication).security ?? []) {
    try {
      await addBasicAuthUser(created.id, s.username, s.password);
    } catch (e) {
      notes.push(
        `Basic-auth user "${s.username}" was not imported: ${e instanceof Error ? e.message : "refused"}. Deplo checks these passwords against its policy and against known breaches.`,
      );
    }
  }

  await importCrons(c, isCompose ? "compose" : "application", svc.id, created.id, notes);

  await report.notes(svc.kind, svc.name, notes, target);
  return created.id;
}

/** An extra (non-primary) hostname, with everything Dokploy knew about it. */
async function addExtraDomain(
  appId: string,
  d: MappedDomain,
  notes: string[],
): Promise<void> {
  try {
    await addDomain(appId, d.host, {
      port: d.port,
      pathPrefix: d.pathPrefix,
      stripPrefix: d.stripPrefix,
      certProvider: d.certProvider,
      entrypoint: d.entrypoint,
      service: d.service ?? undefined,
    });
  } catch (e) {
    notes.push(
      `${d.host} was not imported: ${e instanceof Error ? e.message : "refused"}.`,
    );
  }
}

/** Dokploy's schedules for one service → deplo cron jobs. */
async function importCrons(
  c: DokployCredential,
  scheduleType: "application" | "compose",
  sourceId: string,
  appId: string,
  notes: string[],
): Promise<void> {
  for (const s of await listSchedules(c, scheduleType, sourceId)) {
    const command = (s.command ?? s.script ?? "").trim();
    if (!command) {
      notes.push(`Cron "${s.name}" had no command on Dokploy - not imported.`);
      continue;
    }
    try {
      await createCronJob("app", appId, {
        name: s.name,
        schedule: s.cronExpression,
        command,
        service: s.serviceName?.trim() || null,
        enabled: s.enabled !== false,
      });
    } catch (e) {
      notes.push(
        `Cron "${s.name}" was not imported: ${e instanceof Error ? e.message : "refused"}.`,
      );
    }
  }
}

/* ---- databases ------------------------------------------------------- */

/**
 * One Dokploy database → one deplo Database.
 *
 * Unlike an app, this one really starts: deplo has no notion of a database that
 * exists but is not provisioned, so `createDatabase` brings a container up with an
 * empty volume. That is the useful end state — something to restore a dump into —
 * but it means two things get said out loud: the host name changes (the connection
 * strings in the imported variables still point at Dokploy's), and the data does
 * not come with it.
 */
async function importDatabaseService(
  c: DokployCredential,
  svc: SourceService,
  serverId: string | undefined,
  report: Report,
): Promise<void> {
  // Decided before the detail call, exactly like the scan does it: an engine deplo
  // does not have is not a request worth making, and a 404 would report itself as
  // an HTTP problem rather than as the plain fact that there is no such engine.
  if (!deploEngineFor(svc.kind as DokployDbKind)) {
    await report.add({
      sourceKind: svc.kind,
      sourceName: svc.name,
      outcome: "unsupported",
      targetKind: "database",
      message: `Deplo has no ${svc.kind} engine.`,
    });
    return;
  }
  const row = (await loadService(c, svc)) as DokployDatabase;
  const mapped = mapDatabase(svc.kind as DokployDbKind, row);
  const notes = [...mapped.notes];
  if (!mapped.value) {
    await report.add({
      sourceKind: svc.kind,
      sourceName: svc.name,
      outcome: "unsupported",
      targetKind: "database",
      message: notes.join(" ") || "Deplo has no such engine.",
    });
    return;
  }
  const spec = mapped.value;

  const clash = await getDb()
    .select({ id: databasesTable.id })
    .from(databasesTable)
    .where(
      and(
        eq(databasesTable.teamId, await requireActiveTeamId()),
        sql`lower(${databasesTable.name}) = ${spec.name.trim().toLowerCase()}`,
      ),
    );
  if (clash.length > 0) {
    await report.add({
      sourceKind: svc.kind,
      sourceName: svc.name,
      outcome: "skipped",
      targetKind: "database",
      targetId: clash[0].id,
      message: "A database with this name is already in this team.",
    });
    return;
  }

  // The password is carried over on purpose (see mapDatabase). deplo's own policy
  // may still refuse it, and then the apps' connection strings no longer match —
  // which is exactly the kind of thing that must be shouted, not logged.
  let created: Awaited<ReturnType<typeof createDatabase>>;
  const base = {
    name: spec.name,
    type: spec.type,
    version: spec.version ?? "",
    serverId,
    username: spec.username ?? undefined,
    dbName: spec.dbName ?? undefined,
  };
  const withPort = spec.exposedPort
    ? { exposedPublicly: true, exposedPort: spec.exposedPort }
    : {};
  try {
    created = await createDatabase({
      ...base,
      ...withPort,
      password: spec.password ?? undefined,
    });
  } catch (e) {
    const first = e instanceof Error ? e.message : "refused";
    // Two things can fail here and both have a useful fallback: the port is still
    // held by the live Dokploy, or the password does not pass deplo's policy.
    try {
      created = await createDatabase(base);
      if (spec.exposedPort)
        notes.push(
          `Port ${spec.exposedPort} was not published (${first}). Publish it under the database's settings once the old instance has let it go.`,
        );
      notes.push(
        `The original password was refused (${first}), so Deplo generated one. Every imported connection string still spells out the OLD password - update them, or rotate this database's password to match.`,
      );
    } catch (e2) {
      await report.add({
        sourceKind: svc.kind,
        sourceName: svc.name,
        outcome: "failed",
        targetKind: "database",
        message: e2 instanceof Error ? e2.message : "Could not create the database.",
      });
      return;
    }
  }

  await report.add({
    sourceKind: svc.kind,
    sourceName: svc.name,
    outcome: "created",
    targetKind: "database",
    targetId: created.id,
  });

  if (spec.customImage) {
    try {
      await updateDatabaseImage(created.id, { customImage: spec.customImage });
    } catch (e) {
      notes.push(
        `The image ${spec.customImage} could not be kept: ${e instanceof Error ? e.message : "refused"}.`,
      );
    }
  }

  notes.push(
    `The database is empty and reachable inside Deplo as "${created.host}", not as "${row.appName}" - update the connection strings in the apps that use it, then restore your data.`,
  );
  await report.notes(svc.kind, svc.name, notes, {
    kind: "database",
    id: created.id,
  });
}

/* ---- project / environment level variables --------------------------- */

/**
 * A Dokploy project's or environment's own env blob → a deplo shared variable
 * per key, scoped there AND linked to the apps that were in it.
 *
 * The link is the load-bearing half: under ADR-0012 a shared variable's scope only
 * makes it AVAILABLE, and injection is solely the per-app link. Scoping without
 * linking would look right in the UI and inject nothing, which is how a stack
 * comes up missing exactly the variables the old platform had always supplied.
 */
async function importSharedVars(
  blob: string | null | undefined,
  opts: {
    teamId: string;
    label: string;
    environmentIds: string[];
    projectIds: string[];
    appIds: string[];
    report: Report;
  },
): Promise<void> {
  const entries = parseEnvBlob(blob);
  if (entries.length === 0) return;

  // Same rule as everything else on a re-run: a key that is already here is left
  // exactly as it is. `saveSharedVar` mints a new row when given no id, so
  // without this a second pass would duplicate every shared variable - and
  // overwriting would silently undo a value someone had corrected by hand.
  const already = new Set(
    (
      await getDb()
        .select({ key: sharedVarsTable.key })
        .from(sharedVarsTable)
        .where(eq(sharedVarsTable.teamId, opts.teamId))
    ).map((r) => r.key),
  );

  for (const { key, value } of entries) {
    if (already.has(key)) {
      await opts.report.add({
        path: opts.label,
        sourceKind: "shared-var",
        sourceName: key,
        outcome: "skipped",
        targetKind: "shared-var",
        message: "A shared variable with this name is already in this team.",
      });
      continue;
    }
    try {
      await saveSharedVar({
        key,
        value,
        type: isSecretKey(key) ? "secret" : "plain",
        teamWide: false,
        environmentIds: opts.environmentIds,
        projectIds: opts.projectIds,
        appIds: opts.appIds,
      });
      await opts.report.add({
        path: opts.label,
        sourceKind: "shared-var",
        sourceName: key,
        outcome: "created",
        targetKind: "shared-var",
        message:
          opts.appIds.length === 0
            ? "Nothing is linked to it yet - no app was imported into this scope."
            : null,
      });
    } catch (e) {
      await opts.report.add({
        path: opts.label,
        sourceKind: "shared-var",
        sourceName: key,
        outcome: "failed",
        targetKind: "shared-var",
        message: e instanceof Error ? e.message : "Could not create the variable.",
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Members                                                            */
/* ------------------------------------------------------------------ */

/**
 * Bring the Dokploy organization's people over.
 *
 * Passwords are not migratable in either direction: Dokploy's API never exposes
 * them and its hashes are not deplo's. So each person gets what deplo already
 * has for this — a single-use registration link pre-assigned to this team — and
 * someone who already has an account is simply added to the team.
 *
 * Everyone lands as a plain **member**, whatever they were on Dokploy: a
 * registration link may not carry ownership (`mintRegistrationLink` refuses it),
 * and inferring "admin" into deplo's capability set from another platform's role
 * name is exactly the kind of guess that quietly hands out more access than
 * anyone asked for. The report says who was an owner or admin over there so an
 * admin can promote them on purpose.
 */
export async function importDokployMembers(
  input: ConnectInput & { runId: string },
): Promise<DokployInvite[]> {
  const { teamId } = await assertImportGate();
  await requireInstanceAdmin();
  const c = await credentialFor(input);
  if (!(await ownRun(input.runId, teamId)))
    throw new Error("That import run does not belong to this team.");

  const report = new Report(input.runId).at("Members");
  const people = await planMembers(c, teamId);
  const out: DokployInvite[] = [];

  const accounts = new Map<string, string>();
  if (people.length > 0)
    for (const a of await getDb()
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable)
      .where(
        inArray(
          sql`lower(${usersTable.email})`,
          people.map((p) => p.email),
        ),
      ))
      accounts.set(a.email.toLowerCase(), a.id);

  for (const p of people) {
    const roleNote =
      p.sourceRole && p.sourceRole !== "member"
        ? ` Was ${p.sourceRole} on Dokploy - promote them in Members if that should carry over.`
        : "";

    if (p.inTeam) {
      const entry = {
        ...p,
        link: null,
        outcome: "skipped",
        message: "Already a member of this team.",
      };
      out.push(entry);
      await report.add({
        sourceKind: "member",
        sourceName: p.email,
        outcome: "skipped",
        message: entry.message,
      });
      continue;
    }

    const userId = accounts.get(p.email);
    try {
      if (userId) {
        await addExistingMember({ userId, role: "member" });
        out.push({
          ...p,
          link: null,
          outcome: "created",
          message: `Added to the team as a member.${roleNote}`,
        });
        await report.add({
          sourceKind: "member",
          sourceName: p.email,
          outcome: "created",
          targetKind: "member",
          targetId: userId,
          message: `Added to the team as a member.${roleNote}`,
        });
      } else {
        const { link } = await mintRegistrationLink({
          mode: "existing_teams",
          teamAssignments: [{ teamId, role: "member" }],
        });
        out.push({
          ...p,
          link,
          outcome: "manual",
          message: `Send them this link to create their account.${roleNote}`,
        });
        await report.add({
          sourceKind: "member",
          sourceName: p.email,
          outcome: "manual",
          targetKind: "registration-link",
          message: `A registration link was created for ${p.email}.${roleNote}`,
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not be invited.";
      out.push({ ...p, link: null, outcome: "failed", message });
      await report.add({
        sourceKind: "member",
        sourceName: p.email,
        outcome: "failed",
        message,
      });
    }
  }

  await refreshCounts(input.runId, teamId);
  return out;
}

/* ------------------------------------------------------------------ */
/* History                                                            */
/* ------------------------------------------------------------------ */

export async function listDokployImports(): Promise<ImportRunDTO[]> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(runsTable)
    .where(eq(runsTable.teamId, teamId));
  return rows
    .sort((a, b) =>
      a.startedAt === b.startedAt ? b.seq - a.seq : a.startedAt < b.startedAt ? 1 : -1,
    )
    .map(toRunDTO);
}

export async function getDokployImport(
  id: string,
): Promise<(ImportRunDTO & { items: ImportItemDTO[] }) | null> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(runsTable)
    .where(and(eq(runsTable.id, id), eq(runsTable.teamId, teamId)));
  if (rows.length === 0) return null;
  const items = await getDb()
    .select()
    .from(itemsTable)
    .where(eq(itemsTable.runId, id));
  return {
    ...toRunDTO(rows[0]),
    items: items
      .sort((a, b) => a.seq - b.seq)
      .map((i) => ({
        path: i.path,
        sourceKind: i.sourceKind,
        sourceName: i.sourceName,
        outcome: i.outcome,
        targetKind: i.targetKind,
        targetId: i.targetId,
        message: i.message,
      })),
  };
}

function toRunDTO(r: typeof runsTable.$inferSelect): ImportRunDTO {
  return {
    id: r.id,
    sourceUrl: r.sourceUrl,
    orgName: r.orgName,
    actor: r.actor,
    status: r.status,
    created: r.created,
    skipped: r.skipped,
    failed: r.failed,
    manual: r.manual,
    error: r.error,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}
