/**
 * Coolify behind the one client interface.
 */

import { mapLimit } from "../../utils";
import type {
  MigrationSourceClient,
  RuntimeQuery,
  ServiceRuntime,
  SourceCredential,
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
  resourceStatus,
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
} from "./map";

/** How many reads run at once. Well under the 200/min the bucket already caps. */
const CONCURRENCY = 5;

/** How long a stop may take before the cutover gives up waiting for it. */
const STOP_DEADLINE_MS = 30_000;
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
  await mapLimit(projects, CONCURRENCY, async (p) => {
    const [envs, shared] = await Promise.all([
      listEnvironments(c, p.uuid),
      listSharedEnvs(c, { level: "project", projectUuid: p.uuid }),
    ]);
    envsByProject.set(p.uuid, envs);
    sharedByProject.set(p.uuid, coolifyEnvBlob(shared).blob);
    await mapLimit(envs, CONCURRENCY, async (e) => {
      const name = e.name?.trim() || String(e.uuid ?? e.id);
      sharedByEnv.set(
        `${p.uuid}/${e.id}`,
        coolifyEnvBlob(
          await listSharedEnvs(c, {
            level: "environment",
            projectUuid: p.uuid,
            environment: name,
          }),
        ).blob,
      );
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
        const kind = coolifyDbKindOf(d);
        if (!kind) continue;
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
      environments,
    };
  });
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
  const { mounts } = coolifyMounts(storages);
  // The MACHINE this resource runs on. Left out, everything looked like it was
  // on the panel's own host, and the data phase then asked that host for volumes
  // living on the second one - which answered "no such volume", and the report
  // called it a service that had never been started.
  const extras = {
    env: env.blob,
    mounts,
    serverId: index.serverOf.get(id) ?? "",
  };

  if (group === "databases") {
    const row = await getDatabase(c, id);
    const engine = coolifyDbKindOf(row) ?? (kind as SourceDbKind);
    return coolifyDatabase(row, engine, extras);
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
const READ_SENSITIVE_REFUSAL =
  "This token cannot read values. Coolify hides every variable value and every database password from a token without the read:sensitive scope, so the apps would arrive with their variables empty. Mint a token with read:sensitive (Coolify grants it to a team admin or owner) and connect again.";

async function assertReadable(c: SourceCredential): Promise<void> {
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
  const { mounts } = coolifyMounts(storages);
  const volumes = mounts
    .filter((m) => m.type === "volume" && m.volumeName)
    .map((m) => ({ name: m.volumeName!, mountPath: m.mountPath }));
  const hostMounts = mounts
    .filter((m) => m.type === "bind" && m.hostPath)
    .map((m) => ({ hostPath: m.hostPath!, mountPath: m.mountPath }));

  const status = await resourceStatus(c, group, svc.id);
  const running = status.startsWith("running");
  const notes: string[] = [];
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

  const deadline = Date.now() + STOP_DEADLINE_MS;
  for (;;) {
    const status = await resourceStatus(c, group, id);
    if (!status.startsWith("running")) return;
    if (Date.now() >= deadline)
      throw new Error(
        `Coolify accepted the stop for that service but it is still running ${STOP_DEADLINE_MS / 1000} seconds later. Stop it there, then move its data.`,
      );
    await new Promise((r) => setTimeout(r, STOP_POLL_MS));
  }
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

    organizationName: async () => (await currentTeam(c))?.name?.trim() || null,

    listSchedules: async (kind, id): Promise<SourceSchedule[]> => {
      const group = await resolveGroup(c, kind, id);
      if (group === "databases") return [];
      return (await listScheduledTasks(c, group, id)).map(coolifySchedule);
    },

    teamSharedEnv: async () =>
      coolifyEnvBlob(await listSharedEnvs(c, { level: "team" })).blob || null,

    listBackupDestinations: async () =>
      (await listS3Storages(c))
        .map(coolifyDestination)
        .filter((d): d is NonNullable<typeof d> => d != null),

    serviceRuntime: (svc) => serviceRuntime(c, svc),
    stopService: (kind, id) => stopService(c, kind, id),

    // Coolify puts every service of ONE stack on a network named after that
    // resource, so this is per-resource rather than a fixed name.
    platformNetworks: (svc) => [svc.id, "coolify"],
  };
}
