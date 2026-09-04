/**
 * Coolify behind the one client interface.
 */

import { mapLimit } from "../../utils";
import {
  composeServices,
  composeVolumeHostNames,
  composeVolumeMounts,
  deploFilesPath,
  isDataHostPath,
} from "../map";
import {
  StopAcceptedError,
  type MigrationSourceClient,
  type RuntimeQuery,
  type ServiceRuntime,
  type SourceCredential,
} from "../source";
import type {
  SourceApplication,
  SourceCompose,
  SourceDatabase,
  SourceDbKind,
  SourceEnvironment,
  SourceMember,
  SourceProject,
  SourceSchedule,
  SourceServer,
} from "../model";
import {
  COOLIFY_PANEL,
  CoolifyHttpError,
  currentTeam,
  getApplication,
  getDatabase,
  getService as getServiceRow,
  listApplications,
  canStop,
  listDatabaseBackups,
  listDatabases,
  listEnvironments,
  listEnvs,
  listProjects,
  listS3Storages,
  listScheduledTasks,
  listServerResources,
  listServers,
  listServices,
  listSharedEnvs,
  listStorages,
  listTeamMembers,
  resourceState,
  resourceStatus,
  startResource,
  stopResource,
  type CoolifyEnvironment,
  type CoolifyResourceGroup,
} from "./client";
import {
  coolifyApplication,
  coolifyCompose,
  coolifyDatabase,
  coolifyDbKindOf,
  coolifyDbSecretsVisible,
  coolifyDestination,
  coolifyEnvBlob,
  coolifyIsPanelHost,
  coolifyMember,
  coolifyMounts,
  coolifySchedule,
  coolifyServer,
  withoutPanelInternals,
} from "./map";

/** How many reads run at once. Well under the 200/min the bucket already caps. */
const CONCURRENCY = 5;

/** How long a stop may take before the cutover gives up. Coolify's `status` is
 *  not the container: the sentinel pushes it about once a minute, so a stop that
 *  took 5 s reads "running" for up to 60 s more (measured: 1 database in 5). */
const STOP_BASE_MS = 90_000;
const STOP_PER_CONTAINER_MS = 20_000;
const STOP_DEADLINE_CAP_MS = 240_000;
const STOP_POLL_MS = 1_500;

/* ------------------------------------------------------------------ */
/* Where each resource lives                                           */
/* ------------------------------------------------------------------ */

/**
 * Which Deplo-side server key each resource sits on. `GET /servers/{uuid}/resources`
 * is the only reliable join: an application carries a `destination_id`, and a
 * destination is a Docker network, not a machine.
 */
async function serverOfResource(
  c: SourceCredential,
): Promise<Map<string, string>> {
  const servers = await listServers(c);
  const out = new Map<string, string>();
  await mapLimit(servers, CONCURRENCY, async (s) => {
    const key = coolifyIsPanelHost(s) ? "" : s.uuid;
    for (const r of await listServerResources(c, s.uuid)) out.set(r.uuid, key);
  });
  return out;
}

/** Where every resource lives and which of them are one-click services. */
interface ResourceIndex {
  serverOf: Map<string, string>;
  serviceIds: Set<string>;
}

/**
 * Read once per scan rather than per resource: the data phase asks about the
 * placement of every service it touches, and the answer cannot differ between
 * two questions a minute apart.
 */
const INDEX_TTL_MS = 60_000;
const indexes = new Map<
  string,
  { at: number; value: Promise<ResourceIndex> }
>();

function resourceIndex(c: SourceCredential): Promise<ResourceIndex> {
  const key = JSON.stringify([c.baseUrl, c.apiKey]);
  const hit = indexes.get(key);
  if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.value;
  const value = (async (): Promise<ResourceIndex> => {
    const [serverOf, services] = await Promise.all([
      serverOfResource(c),
      listServices(c),
    ]);
    return { serverOf, serviceIds: new Set(services.map((s) => s.uuid)) };
  })();
  indexes.set(key, { at: Date.now(), value });
  // A read that failed must not be the answer for the next minute.
  value.catch(() => indexes.delete(key));
  return value;
}

/** Tests drive several panels through one module; this puts it back. */
export function __resetCoolifyIndexForTest(): void {
  indexes.clear();
}

/** `application` | `compose` | one of the engines → the API path segment. */
function groupOfKind(kind: string): CoolifyResourceGroup | null {
  if (kind === "application") return "applications";
  if (kind === "compose") return null; // ambiguous, see resolveGroup
  return "databases";
}

/**
 * A `compose` service is either a one-click SERVICE or an application built from a
 * compose file, and the shared model calls both the same thing.
 *
 * Settled from the service LIST, never from a probe whose every failure meant
 * "not a service": a timeout or a 429 then sent the cutover's stop to
 * `applications/{uuid}/stop`, which answers 404, and the data was not copied.
 */
async function resolveGroup(
  c: SourceCredential,
  kind: string,
  id: string,
): Promise<CoolifyResourceGroup> {
  const known = groupOfKind(kind);
  if (known) return known;
  const { serviceIds } = await resourceIndex(c);
  if (serviceIds.has(id)) return "services";
  // Not in the list is not proof on its own - a service created since the index
  // was read is not there either. One probe settles that, and only a refusal
  // Coolify ANSWERED with counts as "no".
  try {
    await getServiceRow(c, id);
    return "services";
  } catch (e) {
    if (e instanceof CoolifyHttpError && e.status === 404)
      return "applications";
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* The tree                                                            */
/* ------------------------------------------------------------------ */

async function tree(c: SourceCredential): Promise<SourceProject[]> {
  const [projects, applications, services, databases, serverOf] =
    await Promise.all([
      listProjects(c),
      listApplications(c),
      listServices(c),
      listDatabases(c),
      serverOfResource(c),
    ]);

  const envsByProject = new Map<string, CoolifyEnvironment[]>();
  const sharedByProject = new Map<string, string>();
  const sharedByEnv = new Map<string, string>();
  // A level the panel will not answer for is a REPORT LINE, never a silence: an
  // older build has no such endpoint, and swallowing the 404 is how a whole set
  // of shared variables vanished with nothing said.
  const notesByProject = new Map<string, string[]>();
  const notesByEnv = new Map<string, string[]>();
  await mapLimit(projects, CONCURRENCY, async (p) => {
    const envs = await listEnvironments(c, p.uuid);
    envsByProject.set(p.uuid, envs);
    try {
      sharedByProject.set(
        p.uuid,
        withoutPanelInternals(
          coolifyEnvBlob(
            await listSharedEnvs(c, { level: "project", projectUuid: p.uuid }),
          ).blob,
        ),
      );
    } catch (e) {
      notesByProject.set(p.uuid, [sharedLevelNote("project", p.name ?? "", e)]);
    }
    await mapLimit(envs, CONCURRENCY, async (e) => {
      const name = e.name?.trim() || String(e.uuid ?? e.id);
      try {
        sharedByEnv.set(
          `${p.uuid}/${e.id}`,
          withoutPanelInternals(
            coolifyEnvBlob(
              await listSharedEnvs(c, {
                level: "environment",
                projectUuid: p.uuid,
                environment: name,
              }),
            ).blob,
          ),
        );
      } catch (err) {
        notesByEnv.set(`${p.uuid}/${e.id}`, [
          sharedLevelNote("environment", name, err),
        ]);
      }
    });
  });

  return projects.map((p) => {
    const environments: SourceEnvironment[] = (
      envsByProject.get(p.uuid) ?? []
    ).map((e) => {
      const env: SourceEnvironment = {
        environmentId: String(e.uuid ?? e.id),
        name: e.name?.trim() || "production",
        env: sharedByEnv.get(`${p.uuid}/${e.id}`) || null,
        platformNotes: notesByEnv.get(`${p.uuid}/${e.id}`) ?? null,
        applications: [],
        compose: [],
      };
      const here = (id: number | null | undefined) => id === e.id;
      const extras = (uuid: string) => ({
        serverId: serverOf.get(uuid) ?? "",
        environmentId: env.environmentId,
      });

      for (const a of applications) {
        if (!here(a.environment_id)) continue;
        // A compose-built application is a STACK, not a single-image app - the
        // shared importer branches on this and nothing else.
        if (a.build_pack === "dockercompose")
          env.compose!.push(coolifyCompose(a, extras(a.uuid)).value);
        else env.applications!.push(coolifyApplication(a, extras(a.uuid)));
      }
      for (const s of services)
        if (here(s.environment_id))
          env.compose!.push(coolifyCompose(s, extras(s.uuid)).value);
      for (const d of databases) {
        if (!here(d.environment_id)) continue;
        // Named by neither column: it still reaches the plan, as a database
        // nobody can import. Dropping it here is how one disappeared in silence.
        const kind = coolifyDbKindOf(d) ?? "unknown";
        const list = (env[kind] ??= []) as SourceDatabase[];
        list.push(coolifyDatabase(d, kind, extras(d.uuid)));
      }
      return env;
    });

    return {
      projectId: p.uuid,
      name: p.name?.trim() || p.uuid,
      description: p.description ?? null,
      env: sharedByProject.get(p.uuid) || null,
      platformNotes: notesByProject.get(p.uuid) ?? null,
      environments,
    };
  });
}

/** One line for a shared-variable level the panel would not answer for. */
function sharedLevelNote(
  level: "team" | "project" | "environment" | "server",
  name: string,
  e: unknown,
): string {
  const why = e instanceof Error ? e.message : "it refused the request";
  const what = name ? `${level} "${name}"` : `${level}`;
  return `{panel} would not answer for the ${what} shared variables (${why}), so none of them came across. Copy them in under Variables.`;
}

/* ------------------------------------------------------------------ */
/* One resource, in full                                               */
/* ------------------------------------------------------------------ */

async function detail(
  c: SourceCredential,
  kind: string,
  id: string,
): Promise<SourceApplication | SourceCompose | SourceDatabase> {
  const group = await resolveGroup(c, kind, id);
  const [envRows, storages, index] = await Promise.all([
    listEnvs(c, group, id),
    listStorages(c, group, id),
    resourceIndex(c),
  ]);
  const env = coolifyEnvBlob(envRows);
  const { mounts } = coolifyMounts(storages, id);
  // A variable the panel would not answer for arrives EMPTY. Said here, or the
  // report reads as a clean import of nine variables when four of them are gone.
  const envNotes = [
    ...(env.unreadableKeys.length > 0
      ? [
          `${env.unreadableKeys.join(", ")} arrived empty: {panel} shows those values once and does not answer with them again. Set them under Variables before deploying.`,
        ]
      : []),
  ];
  // The MACHINE this resource runs on. Left out, everything looked like it was
  // on the panel's own host, and the data phase then asked that host for volumes
  // living on the second one - which answered "no such volume", and the report
  // called it a service that had never been started.
  const extras = {
    env: env.blob,
    envNotes,
    sharedRefs: env.sharedRefs,
    mounts,
    serverId: index.serverOf.get(id) ?? "",
    // Where Coolify puts a resource's own files - and therefore what every `./x`
    // bind in its compose resolves to. It is the app's real state directory:
    // nothing in the storage rows names it, so the copy never saw it.
    stackDir: `/data/coolify/${group}/${id}`,
  };

  if (group === "databases") {
    const row = await getDatabase(c, id);
    const engine = coolifyDbKindOf(row) ?? (kind as SourceDbKind);
    // Only the schedules that save to a store: a local-only one has nowhere to
    // land here, and the report says so through the same note.
    const [schedules, stores] = await Promise.all([
      listDatabaseBackups(c, id),
      listS3Storages(c).catch(() => []),
    ]);
    // The store a schedule saves to: by id when the list carries one, else the
    // only store there is - the API lists stores without their id (4.3.16).
    const storeFor = (b: { s3_storage_id?: number | null }) =>
      stores.find((st) => st.id != null && st.id === b.s3_storage_id)?.name ??
      (stores.length === 1 ? (stores[0].name ?? null) : null);
    const backups = schedules
      // Coolify filters by database_id ALONE, so a postgres schedule comes back
      // for the mysql whose row shares the number; the morph class tells them apart.
      .filter((b) => coolifyBackupIsFor(b, engine))
      .filter((b) => b.frequency?.trim())
      .map((b) => ({
        schedule: b.frequency!.trim(),
        enabled: b.enabled !== false,
        keepLatestCount: b.database_backup_retention_amount_s3 || null,
        destination: b.save_s3 ? { name: storeFor(b) } : null,
      }));
    return coolifyDatabase(row, engine, { ...extras, backups });
  }
  if (group === "services") {
    const row = await getServiceRow(c, id);
    return coolifyCompose(row, extras).value;
  }

  const row = await getApplication(c, id);
  if (row.build_pack === "dockercompose")
    return coolifyCompose(row, extras).value;
  return coolifyApplication(row, {
    ...extras,
    previewEnv: env.previewBlob || undefined,
    basicAuth:
      row.is_http_basic_auth_enabled &&
      row.http_basic_auth_username &&
      row.http_basic_auth_password
        ? {
            username: row.http_basic_auth_username,
            password: row.http_basic_auth_password,
          }
        : null,
  });
}

/**
 * Whether this token can read values at all.
 *
 * Coolify does not refuse a token without `read:sensitive` - it drops the fields
 * from the JSON. So the probe is the absence of a key, and it runs ONCE, before
 * anything is created here or stopped over there.
 */
/** The one recipe, said the same way in every refusal: Coolify's dialog clears the
 *  list when deploy is ticked, so the order is the whole trick. */
const TOKEN_RECIPE =
  "Mint the token with deploy ticked FIRST, then read and read:sensitive (Coolify grants those to a team admin or owner), and connect again.";

const READ_SENSITIVE_REFUSAL = `This token cannot read values. Coolify hides every variable value and every database password from a token without the read:sensitive scope, so the apps would arrive with their variables empty. ${TOKEN_RECIPE}`;

/**
 * Measured on a two-machine Coolify: a token with read and read:sensitive imported
 * every service and then could not stop a single one, so every copy failed with
 * "would not stop". The stop is the data step's one write, and it is `deploy`.
 */
const STOP_REFUSAL = `This token cannot stop a service. The data step stops each service on Coolify before it copies its data, and Coolify allows that only with the deploy permission. ${TOKEN_RECIPE}`;

async function assertReadable(c: SourceCredential): Promise<void> {
  await assertValuesReadable(c);
  await assertComposeReadable(c);
  if (!(await canStop(c))) throw new Error(STOP_REFUSAL);
}

/**
 * A one-click SERVICE is DEFINED by a compose file, so one that hands over none
 * is the same missing scope showing up somewhere else - and the failure it made
 * downstream read as a git problem, which sent people to the wrong settings page.
 * One service answering is enough: the token is fine.
 */
async function assertComposeReadable(c: SourceCredential): Promise<void> {
  const services = await listServices(c);
  if (services.length === 0) return;
  const row = await getServiceRow(c, services[0].uuid).catch(() => null);
  if (!row) return;
  if (row.docker_compose_raw?.trim() || row.docker_compose?.trim()) return;
  throw new Error(COMPOSE_REFUSAL);
}

/** `database_type` on a backup row is the morph class of the database it belongs to. */
const BACKUP_CLASS: Record<string, string> = {
  postgres: "StandalonePostgresql",
  mysql: "StandaloneMysql",
  mariadb: "StandaloneMariadb",
  mongo: "StandaloneMongodb",
  redis: "StandaloneRedis",
  clickhouse: "StandaloneClickhouse",
  keydb: "StandaloneKeydb",
  dragonfly: "StandaloneDragonfly",
};

function coolifyBackupIsFor(
  b: { database_type?: string | null },
  engine: string,
): boolean {
  const cls = BACKUP_CLASS[engine];
  const type = b.database_type?.trim();
  // A row that does not say which engine it is for is kept: better a schedule
  // too many than a silent none.
  return !cls || !type || type.endsWith(cls);
}

const COMPOSE_REFUSAL = `This token cannot read compose files. Coolify hides a stack's compose from a token without the read:sensitive scope, so every one-click service would arrive with nothing to deploy. ${TOKEN_RECIPE}`;

async function assertValuesReadable(c: SourceCredential): Promise<void> {
  // A database is the sharpest probe: without the scope its password column is not
  // blank, it is ABSENT from the JSON.
  const databases = (await listDatabases(c)).filter((d) => coolifyDbKindOf(d));
  if (databases.length > 0) {
    const visible = databases.some((d) =>
      coolifyDbSecretsVisible(d, coolifyDbKindOf(d)!),
    );
    if (!visible) throw new Error(READ_SENSITIVE_REFUSAL);
    return;
  }

  // No database to ask, so ask one resource for its variables instead. An empty
  // list proves nothing, and a token that may be fine is never accused.
  const [applications, services] = await Promise.all([
    listApplications(c),
    listServices(c),
  ]);
  const probe: { group: CoolifyResourceGroup; uuid: string } | null =
    applications[0]
      ? { group: "applications", uuid: applications[0].uuid }
      : services[0]
        ? { group: "services", uuid: services[0].uuid }
        : null;
  if (!probe) return;
  if (coolifyEnvBlob(await listEnvs(c, probe.group, probe.uuid)).masked)
    throw new Error(READ_SENSITIVE_REFUSAL);
}

/* ------------------------------------------------------------------ */
/* Runtime and stop                                                    */
/* ------------------------------------------------------------------ */

/**
 * What a service mounts, straight from Coolify's own storage rows: `name` IS the
 * volume's name on the host, so there is nothing to inspect and nothing to guess.
 */
async function serviceRuntime(
  c: SourceCredential,
  svc: RuntimeQuery,
): Promise<ServiceRuntime> {
  const group = await resolveGroup(c, svc.kind, svc.id);
  const storages = await listStorages(c, group, svc.id);
  const { mounts } = coolifyMounts(storages, svc.id);
  const volumes = mounts
    .filter((m) => m.type === "volume" && m.volumeName)
    .map((m) => ({ name: m.volumeName!, mountPath: m.mountPath }));
  const hostMounts = mounts
    .filter(
      (m) =>
        m.hostPath &&
        (m.type === "bind" ||
          // A stack binds the path its YAML names, so a config file sitting on a
          // real host path is data the copy has to carry - the same rule the
          // Storage row is written by (`mapMounts`). Said here too, or the file
          // lands mounted and empty with no line to show for it.
          (m.type === "file" &&
            svc.kind === "compose" &&
            m.hostPath.startsWith("/") &&
            isDataHostPath(m.hostPath) &&
            deploFilesPath(m.hostPath) == null)),
    )
    .map((m) => ({ hostPath: m.hostPath!, mountPath: m.mountPath }));
  // A `./x` bind is nowhere in the storage rows, and it is the stack's real state
  // directory: without this the report said the service "mounts nothing" over a
  // directory holding every file it had.
  for (const m of svc.declaredBindMounts)
    if (m.stackRelative && !hostMounts.some((h) => h.mountPath === m.mountPath))
      hostMounts.push(m);

  const status = await resourceStatus(c, group, svc.id);
  const running = status.startsWith("running");
  const notes: string[] = [];
  // {panel} renames EVERY volume a stack declares to its own `<uuid>_<key>` and
  // honours neither `external: true` nor a pinned `name:` - so the volume the
  // file names is not the one that was running, and it holds data that is
  // somebody else's to move. Said out loud: unsaid, an operator who put their
  // data in it reads "holds nothing" as Deplo losing it.
  const pinnedPaths = new Map(
    composeVolumeMounts(svc.composeFile ?? "").map((m) => [
      m.name,
      m.mountPath,
    ]),
  );
  for (const [alias, name] of composeVolumeHostNames(svc.composeFile ?? "")) {
    const mountPath = pinnedPaths.get(alias);
    if (!mountPath || volumes.some((v) => v.name === name)) continue;
    notes.push(
      `The compose file mounts "${name}" at ${mountPath}, but {panel} ignored that and gave ${svc.appName} a volume of its own there - so whatever is in "${name}" was never this stack's data, and Deplo does not copy it.`,
    );
  }
  if (volumes.length + hostMounts.length === 0)
    notes.push(
      `{panel} says ${svc.appName} mounts nothing, so there is nothing to copy.`,
    );
  else if (!running)
    notes.push(
      `${svc.appName} is already stopped on {panel}, which is exactly the state its data has to be read in.`,
    );

  return { volumes, hostMounts, running, notes };
}

/**
 * Stop it, and WAIT. Coolify's stop returns 200 the moment the job is queued, and
 * a volume read while its container is still writing cannot be trusted.
 */
async function stopService(
  c: SourceCredential,
  kind: string,
  id: string,
): Promise<void> {
  const group = await resolveGroup(c, kind, id);
  await stopResource(c, group, id);

  const started = Date.now();
  let allowed = 0;
  for (;;) {
    const state = await resourceState(c, group, id);
    if (!state.status.startsWith("running")) return;
    // Read from the row the poll already fetched, so knowing the size costs
    // nothing: a stack of eight gets eight containers' worth of patience.
    if (!allowed)
      allowed = stopDeadlineMs(composeServices(state.compose).length);
    if (Date.now() - started >= allowed)
      throw new StopAcceptedError(
        `Coolify accepted the stop for that service but still reported it running ${Math.round(allowed / 1000)} seconds later.`,
      );
    await new Promise((r) => setTimeout(r, STOP_POLL_MS));
  }
}

/**
 * Undo that stop. No polling on the way back: nothing is reading the volume any
 * more, and Coolify's `status` stays `exited` for minutes after the container is
 * up again, so waiting on it would only invent a failure.
 */
async function startService(
  c: SourceCredential,
  kind: string,
  id: string,
): Promise<void> {
  await startResource(c, await resolveGroup(c, kind, id), id);
}

/** 30 seconds, plus 20 for every container in the stack, capped at three minutes. */
export function stopDeadlineMs(containers: number): number {
  return Math.min(
    STOP_DEADLINE_CAP_MS,
    STOP_BASE_MS + Math.max(1, containers) * STOP_PER_CONTAINER_MS,
  );
}

/* ------------------------------------------------------------------ */

export function coolifyClient(c: SourceCredential): MigrationSourceClient {
  return {
    platform: "coolify",
    baseUrl: c.baseUrl,
    displayName: COOLIFY_PANEL.name,

    assertReadable: () => assertReadable(c),
    listProjects: () => tree(c),

    // Coolify keeps no environment-level blob of its own beyond the shared
    // variables, which the importer reads separately.
    getEnvironment: async () => null,

    getService: (kind, id) => detail(c, kind, id),

    // Coolify hands over the compose in the resource's own row, so there is never
    // a second call to resolve one.
    getResolvedCompose: async () => null,

    // The panel's OWN host is left out: the importer puts it in itself, keyed
    // `""`, and deriving its address from the panel URL is the only way to reach
    // it (Coolify records it as `host.docker.internal`).
    listServers: async (): Promise<SourceServer[]> =>
      (await listServers(c))
        .filter((s) => !coolifyIsPanelHost(s))
        .map(coolifyServer),

    listMembers: async (): Promise<SourceMember[]> =>
      (await listTeamMembers(c)).map(coolifyMember),

    sourceTeam: async () => {
      const t = await currentTeam(c);
      return {
        id: t?.id != null ? String(t.id) : null,
        name: t?.name?.trim() || null,
      };
    },
    // `/v1/teams` is filtered down to the token's own team, so the others are not
    // merely hidden from this token - they cannot be counted either.
    otherTeams: async () => null,

    listSchedules: async (kind, id): Promise<SourceSchedule[]> => {
      const group = await resolveGroup(c, kind, id);
      if (group === "databases") return [];
      return (await listScheduledTasks(c, group, id)).map(coolifySchedule);
    },

    // Coolify's own `COOLIFY_*` bookkeeping is dropped at every shared level: it
    // names the machine and the panel being left, and a team variable nobody can
    // act on survives the revert.
    teamSharedEnv: async () =>
      withoutPanelInternals(
        coolifyEnvBlob(await listSharedEnvs(c, { level: "team" })).blob,
      ) || null,

    // Coolify's fourth level: a variable scoped to a MACHINE, referenced as
    // `{{server.KEY}}`. Deplo has no server scope, so the importer offers it to
    // the project instead and says so.
    serverSharedEnv: async (sourceServerId) => {
      // The importer keys the panel's own host `""` (see `serverOfResource`).
      const uuid = (await listServers(c)).find(
        (s) => (coolifyIsPanelHost(s) ? "" : s.uuid) === sourceServerId,
      )?.uuid;
      if (!uuid) return null;
      return (
        withoutPanelInternals(
          coolifyEnvBlob(
            await listSharedEnvs(c, { level: "server", serverUuid: uuid }),
          ).blob,
        ) || null
      );
    },

    listBackupDestinations: async () =>
      (await listS3Storages(c))
        .map(coolifyDestination)
        .filter((d): d is NonNullable<typeof d> => d != null),

    serviceRuntime: (svc) => serviceRuntime(c, svc),
    stopService: (kind, id) => stopService(c, kind, id),
    startService: (kind, id) => startService(c, kind, id),

    // Coolify puts every service of ONE stack on a network named after that
    // resource, so this is per-resource rather than a fixed name.
    platformNetworks: (svc) => [svc.id, "coolify"],
  };
}
