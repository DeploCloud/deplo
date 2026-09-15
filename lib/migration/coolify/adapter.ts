import { mapLimit } from "../../utils";
import { composeServices } from "../map/compose-read";
import { deploFilesPath } from "../map/source-platform";
import {
  composeVolumeHostNames,
  composeVolumeMounts,
  isDataHostPath,
} from "../map/volume-discovery";
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
  SourceSharedEnv,
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
  type CoolifyEnv,
  type CoolifyEnvironment,
  type CoolifyResourceGroup,
} from "./client";
import { coolifyApplication } from "./map/applications";
import { coolifyCompose } from "./map/compose";
import {
  coolifyDatabase,
  coolifyDbKindOf,
  coolifyDbSecretsVisible,
} from "./map/databases";
import { coolifyEnvBlob, withoutPanelInternals } from "./map/env";
import {
  coolifyDestination,
  coolifyIsPanelHost,
  coolifyMember,
  coolifySchedule,
  coolifyServer,
} from "./map/instance";
import { coolifyMounts } from "./map/mounts";

const CONCURRENCY = 5;

const STOP_BASE_MS = 90_000;
const STOP_PER_CONTAINER_MS = 20_000;
const STOP_DEADLINE_CAP_MS = 240_000;
const STOP_POLL_MS = 1_500;

// GET /servers/{uuid}/resources is the only reliable join: an application's destination_id is a network, not a machine.
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

interface ResourceIndex {
  serverOf: Map<string, string>;
  serviceIds: Set<string>;
}

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
  value.catch(() => indexes.delete(key));
  return value;
}

export function __resetCoolifyIndexForTest(): void {
  indexes.clear();
}

function groupOfKind(kind: string): CoolifyResourceGroup | null {
  if (kind === "application") return "applications";
  if (kind === "compose") return null;
  return "databases";
}

async function resolveGroup(
  c: SourceCredential,
  kind: string,
  id: string,
): Promise<CoolifyResourceGroup> {
  const known = groupOfKind(kind);
  if (known) return known;
  const { serviceIds } = await resourceIndex(c);
  if (serviceIds.has(id)) return "services";
  try {
    await getServiceRow(c, id);
    return "services";
  } catch (e) {
    if (e instanceof CoolifyHttpError && e.status === 404)
      return "applications";
    throw e;
  }
}

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
  const sharedByProject = new Map<string, SourceSharedEnv | null>();
  const sharedByEnv = new Map<string, SourceSharedEnv | null>();
  const notesByProject = new Map<string, string[]>();
  const notesByEnv = new Map<string, string[]>();
  await mapLimit(projects, CONCURRENCY, async (p) => {
    const envs = await listEnvironments(c, p.uuid);
    envsByProject.set(p.uuid, envs);
    try {
      sharedByProject.set(
        p.uuid,
        sharedRead(
          await listSharedEnvs(c, { level: "project", projectUuid: p.uuid }),
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
          sharedRead(
            await listSharedEnvs(c, {
              level: "environment",
              projectUuid: p.uuid,
              environment: name,
            }),
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
        env: sharedByEnv.get(`${p.uuid}/${e.id}`)?.env ?? null,
        secretEnvKeys:
          sharedByEnv.get(`${p.uuid}/${e.id}`)?.secretEnvKeys ?? null,
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
        if (a.build_pack === "dockercompose")
          env.compose!.push(coolifyCompose(a, extras(a.uuid)).value);
        else env.applications!.push(coolifyApplication(a, extras(a.uuid)));
      }
      for (const s of services)
        if (here(s.environment_id))
          env.compose!.push(coolifyCompose(s, extras(s.uuid)).value);
      for (const d of databases) {
        if (!here(d.environment_id)) continue;
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
      env: sharedByProject.get(p.uuid)?.env ?? null,
      secretEnvKeys: sharedByProject.get(p.uuid)?.secretEnvKeys ?? null,
      platformNotes: notesByProject.get(p.uuid) ?? null,
      environments,
    };
  });
}

function sharedLevelNote(
  level: "team" | "project" | "environment" | "server",
  name: string,
  e: unknown,
): string {
  const why = e instanceof Error ? e.message : "it refused the request";
  const what = name ? `${level} "${name}"` : `${level}`;
  return `{panel} would not answer for the ${what} shared variables (${why}), so none of them came across. Copy them in under Variables.`;
}

function sharedRead(rows: CoolifyEnv[]): SourceSharedEnv | null {
  const read = coolifyEnvBlob(rows);
  const env = withoutPanelInternals(read.blob);
  return env ? { env, secretEnvKeys: read.secretKeys } : null;
}

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
  const envNotes = [
    ...(env.unreadableKeys.length > 0
      ? [
          `${env.unreadableKeys.join(", ")} arrived empty: {panel} shows those values once and does not answer with them again. Set them under Variables before deploying.`,
        ]
      : []),
    ...(env.interpolatedKeys.length > 0
      ? [
          `${env.interpolatedKeys.join(", ")} came across exactly as written, dollar signs included. {panel} had them interpolated at deploy (not marked literal), so the app there may have seen a different value - check them under Variables.`,
        ]
      : []),
  ];
  const extras = {
    env: env.blob,
    envNotes,
    sharedRefs: env.sharedRefs,
    secretEnvKeys: env.secretKeys,
    mounts,
    serverId: index.serverOf.get(id) ?? "",
    stackDir: `/data/coolify/${group}/${id}`,
  };

  if (group === "databases") {
    const row = await getDatabase(c, id);
    const engine = coolifyDbKindOf(row) ?? (kind as SourceDbKind);
    const unread: string[] = [];
    const [schedules, stores] = await Promise.all([
      listDatabaseBackups(c, id).catch((e) => {
        unread.push(
          `{panel} would not answer for its backup schedules (${e instanceof Error ? e.message : "refused"}), so none came across - set them under Backups.`,
        );
        return [];
      }),
      listS3Storages(c).catch((e) => {
        unread.push(
          `{panel} would not answer for its S3 storages (${e instanceof Error ? e.message : "refused"}), so its backup destination could not be named.`,
        );
        return [];
      }),
    ]);
    envNotes.push(...unread);
    const storeFor = (b: { s3_storage_id?: number | null }) =>
      stores.find((st) => st.id != null && st.id === b.s3_storage_id)?.name ??
      (stores.length === 1 ? (stores[0].name ?? null) : null);
    const backups = schedules
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

const TOKEN_RECIPE =
  "Mint a new token with root ticked, from an admin or owner, and connect again.";

const READ_SENSITIVE_REFUSAL = `This token cannot read values, so every variable and every database password would arrive empty. ${TOKEN_RECIPE}`;

const STOP_REFUSAL = `This token cannot stop a service, and the data step stops each one before it copies its data. ${TOKEN_RECIPE}`;

async function assertReadable(c: SourceCredential): Promise<void> {
  await assertValuesReadable(c);
  await assertComposeReadable(c);
  if (!(await canStop(c))) throw new Error(STOP_REFUSAL);
}

async function assertComposeReadable(c: SourceCredential): Promise<void> {
  const services = await listServices(c);
  if (services.length === 0) return;
  const row = await getServiceRow(c, services[0].uuid).catch(() => null);
  if (!row) return;
  if (row.docker_compose_raw?.trim() || row.docker_compose?.trim()) return;
  throw new Error(COMPOSE_REFUSAL);
}

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
  return !cls || !type || type.endsWith(cls);
}

const COMPOSE_REFUSAL = `This token cannot read compose files, so every one-click service would arrive with nothing to deploy. ${TOKEN_RECIPE}`;

async function assertValuesReadable(c: SourceCredential): Promise<void> {
  const databases = (await listDatabases(c)).filter((d) => coolifyDbKindOf(d));
  if (databases.length > 0) {
    const visible = databases.some((d) =>
      coolifyDbSecretsVisible(d, coolifyDbKindOf(d)!),
    );
    if (!visible) throw new Error(READ_SENSITIVE_REFUSAL);
    return;
  }

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
          (m.type === "file" &&
            svc.kind === "compose" &&
            m.hostPath.startsWith("/") &&
            isDataHostPath(m.hostPath) &&
            deploFilesPath(m.hostPath) == null)),
    )
    .map((m) => ({ hostPath: m.hostPath!, mountPath: m.mountPath }));
  for (const m of svc.declaredBindMounts)
    if (m.stackRelative && !hostMounts.some((h) => h.mountPath === m.mountPath))
      hostMounts.push(m);

  const status = await resourceStatus(c, group, svc.id);
  const running = status.startsWith("running");
  const notes: string[] = [];
  // Coolify renames every volume a stack declares to <uuid>_<key>, honouring neither external: true nor a pinned name:.
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
    if (!allowed)
      allowed = stopDeadlineMs(composeServices(state.compose).length);
    if (Date.now() - started >= allowed)
      throw new StopAcceptedError(
        `Coolify accepted the stop for that service but still reported it running ${Math.round(allowed / 1000)} seconds later.`,
      );
    await new Promise((r) => setTimeout(r, STOP_POLL_MS));
  }
}

// No polling on the way back: Coolify's status reads exited for minutes after the container is up again.
async function startService(
  c: SourceCredential,
  kind: string,
  id: string,
): Promise<void> {
  await startResource(c, await resolveGroup(c, kind, id), id);
}

export function stopDeadlineMs(containers: number): number {
  return Math.min(
    STOP_DEADLINE_CAP_MS,
    STOP_BASE_MS + Math.max(1, containers) * STOP_PER_CONTAINER_MS,
  );
}

export function coolifyClient(c: SourceCredential): MigrationSourceClient {
  return {
    platform: "coolify",
    baseUrl: c.baseUrl,
    displayName: COOLIFY_PANEL.name,

    assertReadable: () => assertReadable(c),
    listProjects: () => tree(c),

    getEnvironment: async () => null,

    getService: (kind, id) => detail(c, kind, id),

    getResolvedCompose: async () => null,

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
    otherTeams: async () => null,

    listSchedules: async (kind, id): Promise<SourceSchedule[]> => {
      const group = await resolveGroup(c, kind, id);
      if (group === "databases") return [];
      return (await listScheduledTasks(c, group, id)).map(coolifySchedule);
    },

    teamSharedEnv: async () =>
      sharedRead(await listSharedEnvs(c, { level: "team" })),

    serverSharedEnv: async (sourceServerId) => {
      const uuid = (await listServers(c)).find(
        (s) => (coolifyIsPanelHost(s) ? "" : s.uuid) === sourceServerId,
      )?.uuid;
      if (!uuid) return null;
      return sharedRead(
        await listSharedEnvs(c, { level: "server", serverUuid: uuid }),
      );
    },

    listBackupDestinations: async () =>
      (await listS3Storages(c))
        .map(coolifyDestination)
        .filter((d): d is NonNullable<typeof d> => d != null),

    serviceRuntime: (svc) => serviceRuntime(c, svc),
    stopService: (kind, id) => stopService(c, kind, id),
    startService: (kind, id) => startService(c, kind, id),

    platformNetworks: (svc) => [svc.id, "coolify"],
  };
}
