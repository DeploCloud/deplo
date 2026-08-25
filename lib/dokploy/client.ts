/**
 * Read-only client for a Dokploy instance's HTTP API.
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
  "docker" | "git" | "github" | "gitlab" | "bitbucket" | "gitea" | "drop";

export interface DokployDomain {
  domainId: string;
  host: string;
  https?: boolean | null;
  port?: number | null;
  path?: string | null;
  stripPath?: boolean | null;
  /**
   * The path the request is rewritten TO before it reaches the container
   * (Dokploy's own middleware). Deplo strips a prefix or forwards it whole and has
   * no third answer, so a real rewrite is reported rather than silently dropped.
   */
  internalPath?: string | null;
  serviceName?: string | null;
  /** The Traefik entrypoint the route was bound to over there. Deplo has two
   *  (web, websecure), so anything else is reported, not silently replaced. */
  customEntrypoint?: string | null;
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
  /**
   * The service's icon, and ALWAYS a base64 data-URI rather than a URL: Dokploy
   * inlines a template's logo server-side when the service is created, an upload
   * is read with `FileReader`, and its bundled icon set is an SVG built in the
   * browser.
   */
  icon?: string | null;
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
  /** The docker-provider credentials typed onto the app itself. The password is
   *  excluded from the API, so only the fact that there IS one comes across. */
  username?: string | null;
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
  // preview deployments (deplo has the same feature)
  isPreviewDeploymentsActive?: boolean | null;
  previewPort?: number | null;
  previewLimit?: number | null;
  // swarm-only knobs, reported rather than imported
  healthCheckSwarm?: unknown;
  placementSwarm?: unknown;
  labelsSwarm?: unknown;
  ulimitsSwarm?: unknown;
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
  /**
   * The service's icon, and ALWAYS a base64 data-URI rather than a URL: Dokploy
   * inlines a template's logo server-side when the service is created, an upload
   * is read with `FileReader`, and its bundled icon set is an SVG built in the
   * browser.
   */
  icon?: string | null;
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
 * How long one Dokploy call may take.
 */
const REQUEST_TIMEOUT_MS = 15_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let doFetch: FetchLike = (input, init) => fetch(input, init);

/** Swap the transport in tests (the import suite drives recorded fixtures). */
export function __setDokployFetchForTest(fn: FetchLike): void {
  doFetch = fn;
}

export function __resetDokployFetchForTest(): void {
  doFetch = (input, init) => fetch(input, init);
}

/**
 * A transport failure, said out loud. All three read the same otherwise, so the
 * user is left guessing on the one screen where guessing costs the most.
 */
/**
 * An https URL whose host is a bare IP. Deliberately not "any IP": `http://` on an
 * IP is the everyday same-machine case, and the placeholder on that very field
 * suggests one.
 */
function isBareIpHttps(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "https:") return false;
    // `hostname` strips the brackets an IPv6 literal is written with.
    return (
      /^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) || u.hostname.includes(":")
    );
  } catch {
    return false;
  }
}

export function describeDokployTransportError(
  err: unknown,
  baseUrl: string,
): string {
  const at = `at ${baseUrl}`;
  if (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  )
    return `Dokploy did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds ${at}. It may be slow, or something on the way is dropping the connection.`;

  const cause =
    err instanceof Error
      ? (err.cause as { code?: string } | undefined)
      : undefined;
  const code = typeof cause?.code === "string" ? cause.code : "";
  const message = err instanceof Error ? err.message : String(err);

  switch (code) {
    case "ECONNREFUSED":
      return `Nothing is listening ${at}. Check the port - Dokploy serves :3000 unless it is behind a proxy.`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `That address does not resolve (${baseUrl}). Check the hostname.`;
    case "ECONNRESET":
    case "EPIPE":
      return `The connection to ${baseUrl} was cut before Dokploy answered. If Dokploy is on plain http there, use http:// rather than https://.`;
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      return `Could not reach ${baseUrl} - no route to it from this machine. If it is on a private network, an instance admin has to allow that.`;
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      // The trap, named.
      return isBareIpHttps(baseUrl)
        ? `${baseUrl} answered with a certificate this machine does not trust (${code}) - which is what an IP address gets, because the certificate is issued for the panel's NAME. Put the address you open Dokploy on in your browser here. The machine's own address is asked for at the next step, and it is not this field.`
        : `The https certificate ${at} is not one this machine trusts (${code}).`;
    case "ERR_SSL_WRONG_VERSION_NUMBER":
    case "EPROTO":
      return `${baseUrl} answered, but not over https. Try http:// instead.`;
    default:
      return `Could not reach Dokploy ${at}${code ? ` (${code})` : ""}: ${message}.`;
  }
}

/** Every call goes out through here so no caller can leak a bare "fetch failed". */
async function send(
  baseUrl: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await doFetch(url, init);
  } catch (e) {
    throw new Error(describeDokployTransportError(e, baseUrl));
  }
}

/** Origin with no trailing slash and no trailing `/api`, however it was typed. */
export function normalizeDokployBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const u = new URL(withScheme);
  if (u.username || u.password)
    throw new Error("Put the key in the API key field, not in the address.");
  const path = u.pathname.replace(/\/+$/, "").replace(/\/api$/i, "");
  return `${u.origin}${path}`;
}

/**
 * One GET against Dokploy, with a readable failure.
 */
async function get<T>(
  c: DokployCredential,
  procedure: string,
  params: Record<string, string | undefined> = {},
): Promise<T> {
  const url = new URL(`${c.baseUrl}/api/${procedure}`);
  for (const [k, v] of Object.entries(params))
    if (v !== undefined) url.searchParams.set(k, v);

  const res = await send(c.baseUrl, url.toString(), {
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
  const res = await send(c.baseUrl, `${c.baseUrl}/api/${procedure}`, {
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

const SERVICE_KEYS = ["applications", "compose", ...DOKPLOY_DB_KINDS] as const;

/** True when a project row carries services directly (pre-environments Dokploy). */
function hasLooseServices(p: DokployProject): boolean {
  return SERVICE_KEYS.some((k) => {
    const v = p[k as keyof DokployProject];
    return Array.isArray(v) && v.length > 0;
  });
}

/**
 * Every project of the key's organization, with environments and their services.
 */
export async function listProjects(
  c: DokployCredential,
): Promise<DokployProject[]> {
  const projects = await get<DokployProject[]>(c, "project.all");
  if (!Array.isArray(projects)) return [];
  return projects.map((p) => {
    const envs = Array.isArray(p.environments) ? p.environments : [];
    if (envs.length > 0 || !hasLooseServices(p))
      return { ...p, environments: envs };
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

/**
 * One environment's own row, for the variable blob `project.all` never carries.
 */
export async function getEnvironment(
  c: DokployCredential,
  environmentId: string,
): Promise<DokployEnvironment | null> {
  try {
    return await get<DokployEnvironment>(c, "environment.one", {
      environmentId,
    });
  } catch {
    // An older Dokploy has no environments at all (the tree is synthesised), and
    // a member key can be refused here. Neither is worth failing an import over.
    return null;
  }
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
 * A compose body only counts when it declares services.
 */
function composeOrNull(body: string): string | null {
  const yaml = body.trim();
  return yaml && /^\s*services\s*:/m.test(yaml) ? yaml : null;
}

/**
 * The compose file Dokploy would actually deploy, for a stack whose YAML lives in
 * a git repo rather than in the database. deplo holds compose YAML inline, so a
 * repo-backed stack has nothing to import without this.
 */
export async function getConvertedCompose(
  c: DokployCredential,
  composeId: string,
): Promise<string | null> {
  try {
    const body = await get<unknown>(c, "compose.getConvertedCompose", {
      composeId,
    });
    if (typeof body === "string") return composeOrNull(body);
    if (body && typeof body === "object") {
      for (const v of Object.values(body as Record<string, unknown>)) {
        const yaml = typeof v === "string" ? composeOrNull(v) : null;
        if (yaml) return yaml;
      }
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
 * How a Dokploy service's containers are found.
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
 * Stop a service on the SOURCE instance, and leave it stopped. The UI says so
 * before the button is pressed.
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
