/**
 * Read-only client for a Dokploy instance's HTTP API.
 *
 * The migration reads EVERYTHING through this API and never through Dokploy's
 * database or a shell on its host — which is what lets the same code serve both
 * the remote case (Dokploy on another VPS) and the internal one (Dokploy on this
 * VPS, reached over the docker bridge). Nothing here writes to Dokploy: the
 * source instance is left running and untouched, so it stays the rollback.
 *
 * Deliberately dependency-free (no `server-only`, no DB, no crypto) and shaped
 * after `lib/git/providers.ts` for the same reason: the caller hands over an
 * already-decrypted credential, so the fiddly parts — response shapes, error
 * text, the older-Dokploy fallbacks — unit-test without HTTP or a database.
 *
 * Dokploy's API is its tRPC router projected onto OpenAPI: every procedure is a
 * path (`/api/project.all`), queries are GET with query-string params, and auth
 * is one `x-api-key` header. An API key belongs to ONE organization and every
 * read is filtered by it, so one key == one Dokploy organization == one deplo
 * team. Reading a second organization means a second key.
 */

/** A Dokploy instance and the key that reads it. */
export interface DokployCredential {
  /** Origin with no trailing slash and no `/api`, e.g. https://dokploy.acme.com. */
  baseUrl: string;
  /** The `x-api-key` value, minted in Dokploy under Settings → Profile → API/CLI. */
  apiKey: string;
}

/* ------------------------------------------------------------------ */
/* Row shapes — only the fields the import actually maps               */
/* ------------------------------------------------------------------ */

/** Dokploy's build packs. `heroku_buildpacks`/`paketo_buildpacks` have no deplo twin. */
export type DokployBuildType =
  | "dockerfile"
  | "heroku_buildpacks"
  | "paketo_buildpacks"
  | "nixpacks"
  | "static"
  | "railpack";

/** Where an application's code comes from. `drop` is an uploaded archive. */
export type DokploySourceType =
  | "docker"
  | "git"
  | "github"
  | "gitlab"
  | "bitbucket"
  | "gitea"
  | "drop";

export interface DokployDomain {
  domainId: string;
  host: string;
  https?: boolean | null;
  port?: number | null;
  path?: string | null;
  stripPath?: boolean | null;
  serviceName?: string | null;
  domainType?: "application" | "compose" | "preview" | null;
  certificateType?: "letsencrypt" | "none" | "custom" | null;
  enabled?: boolean | null;
}

export interface DokployMount {
  mountId: string;
  type: "bind" | "volume" | "file";
  hostPath?: string | null;
  volumeName?: string | null;
  filePath?: string | null;
  content?: string | null;
  mountPath: string;
}

export interface DokployPort {
  portId: string;
  publishedPort: number;
  targetPort: number;
  protocol?: string | null;
}

/** One basic-auth credential. Dokploy stores the password in the clear. */
export interface DokploySecurity {
  securityId: string;
  username: string;
  password: string;
}

export interface DokployApplication {
  applicationId: string;
  /** OPTIONAL because `project.all` is a projection: its rows carry an id and
   *  sometimes a name, and a database row carries only the id. Anything that needs
   *  a real value reads the DETAIL row (`getService`). */
  name?: string | null;
  appName?: string | null;
  description?: string | null;
  env?: string | null;
  buildArgs?: string | null;
  sourceType: DokploySourceType;
  buildType: DokployBuildType;
  applicationStatus?: string | null;
  autoDeploy?: boolean | null;
  triggerType?: "push" | "tag" | null;
  watchPaths?: string[] | null;
  enableSubmodules?: boolean | null;
  replicas?: number | null;
  command?: string | null;
  // docker source
  dockerImage?: string | null;
  registryUrl?: string | null;
  registryId?: string | null;
  // dockerfile / static build settings
  dockerfile?: string | null;
  dockerContextPath?: string | null;
  dockerBuildStage?: string | null;
  publishDirectory?: string | null;
  isStaticSpa?: boolean | null;
  railpackVersion?: string | null;
  // github
  repository?: string | null;
  owner?: string | null;
  branch?: string | null;
  buildPath?: string | null;
  githubId?: string | null;
  // gitlab
  gitlabRepository?: string | null;
  gitlabOwner?: string | null;
  gitlabBranch?: string | null;
  gitlabBuildPath?: string | null;
  gitlabPathNamespace?: string | null;
  gitlabId?: string | null;
  // gitea
  giteaRepository?: string | null;
  giteaOwner?: string | null;
  giteaBranch?: string | null;
  giteaBuildPath?: string | null;
  giteaId?: string | null;
  // bitbucket
  bitbucketRepository?: string | null;
  bitbucketRepositorySlug?: string | null;
  bitbucketOwner?: string | null;
  bitbucketBranch?: string | null;
  bitbucketBuildPath?: string | null;
  bitbucketId?: string | null;
  // plain git
  customGitUrl?: string | null;
  customGitBranch?: string | null;
  customGitBuildPath?: string | null;
  customGitSSHKeyId?: string | null;
  // limits
  memoryLimit?: string | null;
  memoryReservation?: string | null;
  cpuLimit?: string | null;
  cpuReservation?: string | null;
  // placement
  serverId?: string | null;
  environmentId?: string | null;
  // relations, present on `application.one`
  domains?: DokployDomain[] | null;
  mounts?: DokployMount[] | null;
  ports?: DokployPort[] | null;
  security?: DokploySecurity[] | null;
  redirects?: { redirectId: string }[] | null;
  registry?: { registryId: string; registryName?: string | null } | null;
  /**
   * The git provider rows, with every credential column excluded server-side
   * (`columns: { accessToken: false, … }`). They carry the one thing the import
   * needs and cannot guess: the HOST of a self-hosted GitLab/Gitea.
   */
  github?: { githubId?: string; githubAppName?: string | null } | null;
  gitlab?: { gitlabId?: string; gitlabUrl?: string | null } | null;
  gitea?: { giteaId?: string; giteaUrl?: string | null } | null;
  bitbucket?: { bitbucketId?: string } | null;
}

export interface DokployCompose {
  composeId: string;
  /** Optional for the same reason as {@link DokployApplication.name}. */
  name?: string | null;
  appName?: string | null;
  description?: string | null;
  env?: string | null;
  composeFile?: string | null;
  composeType?: "docker-compose" | "stack" | null;
  sourceType: "git" | "github" | "gitlab" | "bitbucket" | "gitea" | "raw";
  composePath?: string | null;
  suffix?: string | null;
  randomize?: boolean | null;
  isolatedDeployment?: boolean | null;
  command?: string | null;
  autoDeploy?: boolean | null;
  serverId?: string | null;
  environmentId?: string | null;
  // git fields, same per-provider spread as an application
  repository?: string | null;
  owner?: string | null;
  branch?: string | null;
  gitlabRepository?: string | null;
  gitlabOwner?: string | null;
  gitlabBranch?: string | null;
  giteaRepository?: string | null;
  giteaOwner?: string | null;
  giteaBranch?: string | null;
  bitbucketRepository?: string | null;
  bitbucketOwner?: string | null;
  bitbucketBranch?: string | null;
  customGitUrl?: string | null;
  customGitBranch?: string | null;
  domains?: DokployDomain[] | null;
  mounts?: DokployMount[] | null;
  github?: { githubId?: string; githubAppName?: string | null } | null;
  gitlab?: { gitlabId?: string; gitlabUrl?: string | null } | null;
  gitea?: { giteaId?: string; giteaUrl?: string | null } | null;
  bitbucket?: { bitbucketId?: string } | null;
}

/** The five database engines share one shape; only the id field's name differs. */
export interface DokployDatabase {
  /** Optional for the same reason as {@link DokployApplication.name} — and a
   *  database row from `project.all` really does carry NOTHING but its id. */
  name?: string | null;
  appName?: string | null;
  description?: string | null;
  dockerImage?: string | null;
  databaseName?: string | null;
  databaseUser?: string | null;
  databasePassword?: string | null;
  databaseRootPassword?: string | null;
  env?: string | null;
  command?: string | null;
  externalPort?: number | null;
  memoryLimit?: string | null;
  memoryReservation?: string | null;
  cpuLimit?: string | null;
  cpuReservation?: string | null;
  serverId?: string | null;
  environmentId?: string | null;
  mounts?: DokployMount[] | null;
  [idField: string]: unknown;
}

/** Which of Dokploy's per-engine tables a database row came from. */
export const DOKPLOY_DB_KINDS = [
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
  "libsql",
] as const;
export type DokployDbKind = (typeof DOKPLOY_DB_KINDS)[number];

export interface DokployEnvironment {
  environmentId: string;
  name: string;
  description?: string | null;
  env?: string | null;
  isDefault?: boolean | null;
  applications?: DokployApplication[] | null;
  compose?: DokployCompose[] | null;
  postgres?: DokployDatabase[] | null;
  mysql?: DokployDatabase[] | null;
  mariadb?: DokployDatabase[] | null;
  mongo?: DokployDatabase[] | null;
  redis?: DokployDatabase[] | null;
  libsql?: DokployDatabase[] | null;
}

export interface DokployProject {
  projectId: string;
  name: string;
  description?: string | null;
  env?: string | null;
  createdAt?: string | null;
  environments?: DokployEnvironment[] | null;
  /**
   * Pre-environments Dokploy hung services straight off the project. Kept so an
   * older instance still scans; `listProjects` folds them into a synthetic
   * environment.
   */
  applications?: DokployApplication[] | null;
  compose?: DokployCompose[] | null;
  postgres?: DokployDatabase[] | null;
  mysql?: DokployDatabase[] | null;
  mariadb?: DokployDatabase[] | null;
  mongo?: DokployDatabase[] | null;
  redis?: DokployDatabase[] | null;
  libsql?: DokployDatabase[] | null;
}

export interface DokployServer {
  serverId: string;
  name: string;
  ipAddress?: string | null;
  description?: string | null;
}

/** A member of the organization the API key belongs to. */
export interface DokployMember {
  id?: string;
  userId?: string;
  role?: string | null;
  user?: {
    id?: string;
    email?: string | null;
    name?: string | null;
    image?: string | null;
  } | null;
  email?: string | null;
  name?: string | null;
}

export interface DokploySchedule {
  scheduleId: string;
  name: string;
  cronExpression: string;
  shellType?: string | null;
  command?: string | null;
  script?: string | null;
  serviceName?: string | null;
  scheduleType?: string | null;
  enabled?: boolean | null;
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

/**
 * How long one Dokploy call may take. Same reasoning as the git providers: the
 * address points at a host we do not run, often behind someone's VPN, and the
 * scan sits on the path of a button the user is watching. Without a deadline an
 * unreachable box turns "Scan" into a two-minute hang.
 */
const REQUEST_TIMEOUT_MS = 15_000;

type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

let doFetch: FetchLike = (input, init) => fetch(input, init);

/** Swap the transport in tests (the import suite drives recorded fixtures). */
export function __setDokployFetchForTest(fn: FetchLike): void {
  doFetch = fn;
}

export function __resetDokployFetchForTest(): void {
  doFetch = (input, init) => fetch(input, init);
}

/** Origin with no trailing slash and no trailing `/api`, however it was typed. */
export function normalizeDokployBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const u = new URL(withScheme);
  if (u.username || u.password)
    throw new Error(
      "Put the key in the API key field, not in the address.",
    );
  const path = u.pathname.replace(/\/+$/, "").replace(/\/api$/i, "");
  return `${u.origin}${path}`;
}

/**
 * One GET against Dokploy, with a readable failure.
 *
 * Dokploy's own message is surfaced (truncated) rather than swallowed: the two
 * everyday failures are a key pasted from the wrong instance (401) and a key
 * belonging to a plain member, whose `accessedProjects` list is stale and whose
 * `*.one` calls answer 403. Both are things only the user can fix, and only if
 * we say which one happened.
 *
 * `redirect: "manual"` for the reason `lib/outbound-url.ts` documents: the
 * address is SSRF-checked once, and a 302 is the way out of that check.
 */
async function get<T>(
  c: DokployCredential,
  procedure: string,
  params: Record<string, string | undefined> = {},
): Promise<T> {
  const url = new URL(`${c.baseUrl}/api/${procedure}`);
  for (const [k, v] of Object.entries(params))
    if (v !== undefined) url.searchParams.set(k, v);

  const res = await doFetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "deplo",
      "x-api-key": c.apiKey,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get("location") ?? "";
    throw new Error(
      `Dokploy answered with a redirect (${res.status})` +
        (to ? ` to ${to.slice(0, 200)}` : "") +
        ". Deplo does not follow redirects here. Point this at the address that answers directly.",
    );
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300).trim();
    throw new Error(
      `Dokploy request failed (${res.status}) on ${procedure}` +
        (detail ? `: ${detail}` : ""),
    );
  }
  return (await res.json()) as T;
}

/**
 * One POST against Dokploy. The ONLY writes this client ever makes are the
 * `*.stop` calls of a data cutover — deliberately, so "the source instance is
 * only read" stays true of everything else and it keeps working as the rollback.
 */
async function post<T>(
  c: DokployCredential,
  procedure: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await doFetch(`${c.baseUrl}/api/${procedure}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "deplo",
      "x-api-key": c.apiKey,
    },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300).trim();
    throw new Error(
      `Dokploy request failed (${res.status}) on ${procedure}` +
        (detail ? `: ${detail}` : ""),
    );
  }
  return (await res.json().catch(() => null)) as T;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

const SERVICE_KEYS = [
  "applications",
  "compose",
  ...DOKPLOY_DB_KINDS,
] as const;

/** True when a project row carries services directly (pre-environments Dokploy). */
function hasLooseServices(p: DokployProject): boolean {
  return SERVICE_KEYS.some((k) => {
    const v = p[k as keyof DokployProject];
    return Array.isArray(v) && v.length > 0;
  });
}

/**
 * Every project of the key's organization, with environments and their services.
 *
 * ONE call for the whole tree — `project.all` loads projects → environments →
 * {applications, compose, and each database table}. The rows are shallow (no
 * domains/mounts/ports), which is what the per-service `*.one` calls below are
 * for.
 *
 * A Dokploy old enough to predate environments hangs services off the project
 * instead; those are folded into one synthetic "production" environment so the
 * rest of the import has a single shape to walk.
 */
export async function listProjects(
  c: DokployCredential,
): Promise<DokployProject[]> {
  const projects = await get<DokployProject[]>(c, "project.all");
  if (!Array.isArray(projects)) return [];
  return projects.map((p) => {
    const envs = Array.isArray(p.environments) ? p.environments : [];
    if (envs.length > 0 || !hasLooseServices(p)) return { ...p, environments: envs };
    const synthetic: DokployEnvironment = {
      environmentId: `legacy-${p.projectId}`,
      name: "production",
      isDefault: true,
      env: "",
      applications: p.applications ?? [],
      compose: p.compose ?? [],
      postgres: p.postgres ?? [],
      mysql: p.mysql ?? [],
      mariadb: p.mariadb ?? [],
      mongo: p.mongo ?? [],
      redis: p.redis ?? [],
      libsql: p.libsql ?? [],
    };
    return { ...p, environments: [synthetic] };
  });
}

/** One application WITH its domains, mounts, ports and basic-auth users. */
export function getApplication(
  c: DokployCredential,
  applicationId: string,
): Promise<DokployApplication> {
  return get<DokployApplication>(c, "application.one", { applicationId });
}

/** One compose stack WITH its domains and mounts. */
export function getCompose(
  c: DokployCredential,
  composeId: string,
): Promise<DokployCompose> {
  return get<DokployCompose>(c, "compose.one", { composeId });
}

/** One database WITH its mounts. `kind` picks the table and the id parameter. */
export function getDatabase(
  c: DokployCredential,
  kind: DokployDbKind,
  id: string,
): Promise<DokployDatabase> {
  return get<DokployDatabase>(c, `${kind}.one`, { [`${kind}Id`]: id });
}

/**
 * The detail call for any kind of service, picked by kind.
 *
 * Worth having in one place because **`project.all` is a projection, not the
 * rows**: measured against a real instance it returns
 * `{applicationId, name, applicationStatus}` for an application, and for a
 * database only `{postgresId}` — no name, no `appName`, no `serverId`. Everything
 * authoritative therefore comes from here, and anything that reads a field off the
 * tree instead is reading a field that may simply not be there.
 */
export function getService(
  c: DokployCredential,
  kind: string,
  id: string,
): Promise<DokployApplication | DokployCompose | DokployDatabase> {
  if (kind === "application") return getApplication(c, id);
  if (kind === "compose") return getCompose(c, id);
  return getDatabase(c, kind as DokployDbKind, id);
}

/** The display name of a service, from its detail row, however it is shaped. */
export function serviceDisplayName(
  detail: { name?: string | null } | null | undefined,
  fallback: string,
): string {
  const name = detail?.name?.trim();
  return name || fallback;
}

/**
 * The compose file Dokploy would actually deploy, for a stack whose YAML lives
 * in a git repo rather than in the database.
 *
 * deplo holds compose YAML inline, so a repo-backed stack has nothing to import
 * without this. It only answers once Dokploy has cloned the repo on its host, so
 * a failure is expected and NOT an error: the caller reports "paste the compose"
 * instead of creating a broken app.
 */
export async function getConvertedCompose(
  c: DokployCredential,
  composeId: string,
): Promise<string | null> {
  try {
    const body = await get<unknown>(c, "compose.getConvertedCompose", {
      composeId,
    });
    if (typeof body === "string") return body.trim() || null;
    if (body && typeof body === "object") {
      for (const v of Object.values(body as Record<string, unknown>))
        if (typeof v === "string" && v.includes("services:")) return v;
    }
    return null;
  } catch {
    return null;
  }
}

/** The fleet the source instance deploys to. `serverId: null` on a service means
 *  Dokploy's own host, which has no row here. */
export async function listServers(
  c: DokployCredential,
): Promise<DokployServer[]> {
  const rows = await get<DokployServer[]>(c, "server.all");
  return Array.isArray(rows) ? rows : [];
}

/** Everyone in the key's organization, for the registration-link step. */
export async function listMembers(
  c: DokployCredential,
): Promise<DokployMember[]> {
  const rows = await get<DokployMember[]>(c, "user.all");
  return Array.isArray(rows) ? rows : [];
}

/**
 * The name of the organization this key reads, so the wizard can say what it is
 * about to pull. Best-effort: an older instance has no such procedure, and not
 * knowing the name must not stop an import.
 */
export async function activeOrganizationName(
  c: DokployCredential,
): Promise<string | null> {
  try {
    const org = await get<{ name?: string | null } | null>(
      c,
      "organization.active",
    );
    const name = org?.name?.trim();
    return name ? name : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* The data cutover                                                    */
/* ------------------------------------------------------------------ */

/** One running container of a service, as Dokploy's `docker ps` wrapper parses it. */
export interface DokployContainer {
  containerId: string;
  name: string;
  state: string;
}

/**
 * How a Dokploy service's containers are found. Exactly two values: the endpoint
 * REFUSES anything else (`Invalid option: expected one of "standalone"|"swarm"`),
 * so a third would be a 400 rather than a miss.
 *
 *  - `swarm` filters on `com.docker.swarm.service.name` — an application or a
 *    database, both of which Dokploy runs as swarm services;
 *  - `standalone` filters on the container NAME — a compose stack, whose
 *    containers are `<appName>-<service>-1`.
 *
 * Verified against a live instance: a compose stack answers on `standalone` and
 * nothing on `swarm`, a database the other way round.
 */
export type DokployRuntime = "swarm" | "standalone";

/** The containers of one service, by its `appName`. */
export async function listAppContainers(
  c: DokployCredential,
  appName: string,
  type: DokployRuntime,
): Promise<DokployContainer[]> {
  const rows = await get<DokployContainer[] | null>(
    c,
    "docker.getContainersByAppLabel",
    { appName, type },
  );
  return Array.isArray(rows) ? rows : [];
}

/** What `docker inspect` says, reduced to the two things a data move reads. */
export interface DokployInspect {
  Name?: string;
  State?: { Running?: boolean; Status?: string };
  Mounts?: {
    Type?: string;
    Name?: string;
    Source?: string;
    Destination?: string;
  }[];
}

/**
 * `docker inspect <id>` on the source host, through Dokploy's own API
 * (`docker.getConfig` is literally that command).
 *
 * This is what makes the data move exact instead of a guess: the REAL volume
 * names and the paths they are mounted at come from the container that is using
 * them, so none of Dokploy's naming conventions have to be reproduced here.
 */
export function inspectContainer(
  c: DokployCredential,
  containerId: string,
): Promise<DokployInspect> {
  return get<DokployInspect>(c, "docker.getConfig", { containerId });
}

/** Which procedure stops one kind of service, and what it calls its id. */
const STOP_PROCEDURE: Record<string, string> = {
  application: "application.stop",
  compose: "compose.stop",
  postgres: "postgres.stop",
  mysql: "mysql.stop",
  mariadb: "mariadb.stop",
  mongo: "mongo.stop",
  redis: "redis.stop",
};

/**
 * Stop a service on the SOURCE instance, and leave it stopped.
 *
 * The one write this client makes, and the point of no return of a cutover: a
 * volume read while its container is writing produces an archive nothing can be
 * trusted from (`ExportVolume`'s contract is that the caller has quiesced the
 * source). The UI says so before the button is pressed.
 */
export async function stopService(
  c: DokployCredential,
  kind: string,
  id: string,
): Promise<void> {
  const procedure = STOP_PROCEDURE[kind];
  if (!procedure) throw new Error(`Deplo cannot stop a ${kind} on Dokploy.`);
  await post(c, procedure, { [`${kind}Id`]: id });
}

/** The cron jobs attached to one service. Best-effort, same reasoning as above. */
export async function listSchedules(
  c: DokployCredential,
  scheduleType: string,
  id: string,
): Promise<DokploySchedule[]> {
  try {
    const rows = await get<DokploySchedule[]>(c, "schedule.list", {
      scheduleType,
      id,
    });
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}
