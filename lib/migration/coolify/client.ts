/**
 * Read-only client for a Coolify instance's HTTP API (`/api/v1`, bearer token).
 *
 * The one exception is the stop of a data cutover, exactly as it is for the other
 * adapter: the source stays a working rollback.
 */

import type { SourceCredential } from "../source";
import {
  REQUEST_TIMEOUT_MS,
  refuseRedirect,
  sendRequest,
  type PanelIdentity,
} from "../transport";

export const COOLIFY_PANEL: PanelIdentity = {
  name: "Coolify",
  portHint: ":8000",
};

/* ------------------------------------------------------------------ */
/* Row shapes - only the fields the import reads                       */
/* ------------------------------------------------------------------ */

export interface CoolifyProject {
  uuid: string;
  name?: string | null;
  description?: string | null;
}

export interface CoolifyEnvironment {
  id: number;
  uuid?: string | null;
  name?: string | null;
  project_id?: number | null;
}

export interface CoolifyServerSettings {
  is_reachable?: boolean | null;
  is_usable?: boolean | null;
  is_swarm_manager?: boolean | null;
  is_swarm_worker?: boolean | null;
  is_build_server?: boolean | null;
  wildcard_domain?: string | null;
}

export interface CoolifyServer {
  id?: number | null;
  uuid: string;
  name?: string | null;
  ip?: string | null;
  port?: number | null;
  settings?: CoolifyServerSettings | null;
}

/** One row of `GET /servers/{uuid}/resources` - the only reliable resource→server join. */
export interface CoolifyServerResource {
  uuid: string;
  name?: string | null;
  type?: string | null;
  status?: string | null;
}

export interface CoolifyApplicationSettings {
  is_static?: boolean | null;
  is_spa?: boolean | null;
  is_force_https_enabled?: boolean | null;
  is_preview_deployments_enabled?: boolean | null;
  is_raw_compose_deployment_enabled?: boolean | null;
  [key: string]: unknown;
}

export interface CoolifyApplication {
  uuid: string;
  name?: string | null;
  description?: string | null;
  environment_id?: number | null;
  status?: string | null;
  fqdn?: string | null;
  build_pack?: string | null;
  /**
   * `owner/repo` for an app behind a git SOURCE, a whole clone URL for a public
   * one. The host lives in the relation below - see `coolifyGitUrl`.
   */
  git_repository?: string | null;
  git_branch?: string | null;
  git_full_url?: string | null;
  /** `App\Models\GithubApp` | `App\Models\GitlabApp` | ... */
  source_type?: string | null;
  source?: { html_url?: string | null; api_url?: string | null } | null;
  docker_registry_image_name?: string | null;
  docker_registry_image_tag?: string | null;
  static_image?: string | null;
  install_command?: string | null;
  build_command?: string | null;
  start_command?: string | null;
  ports_exposes?: string | null;
  ports_mappings?: string | null;
  base_directory?: string | null;
  publish_directory?: string | null;
  dockerfile?: string | null;
  dockerfile_location?: string | null;
  dockerfile_target_build?: string | null;
  docker_compose?: string | null;
  docker_compose_raw?: string | null;
  docker_compose_domains?: string | null;
  docker_compose_location?: string | null;
  custom_labels?: string | null;
  custom_docker_run_options?: string | null;
  custom_network_aliases?: string | null;
  custom_nginx_configuration?: string | null;
  pre_deployment_command?: string | null;
  pre_deployment_command_container?: string | null;
  post_deployment_command?: string | null;
  post_deployment_command_container?: string | null;
  watch_paths?: string | null;
  redirect?: string | null;
  limits_memory?: string | null;
  limits_memory_reservation?: string | null;
  limits_memory_swap?: string | null;
  limits_cpus?: string | null;
  limits_cpuset?: string | null;
  health_check_enabled?: boolean | null;
  health_check_path?: string | null;
  health_check_port?: string | null;
  health_check_host?: string | null;
  health_check_method?: string | null;
  health_check_scheme?: string | null;
  health_check_return_code?: number | null;
  health_check_response_text?: string | null;
  health_check_interval?: number | null;
  health_check_timeout?: number | null;
  health_check_retries?: number | null;
  health_check_start_period?: number | null;
  health_check_type?: string | null;
  health_check_command?: string | null;
  is_http_basic_auth_enabled?: boolean | null;
  http_basic_auth_username?: string | null;
  http_basic_auth_password?: string | null;
  settings?: CoolifyApplicationSettings | null;
}

export interface CoolifyService {
  uuid: string;
  name?: string | null;
  description?: string | null;
  environment_id?: number | null;
  server_id?: number | null;
  status?: string | null;
  docker_compose?: string | null;
  docker_compose_raw?: string | null;
  service_type?: string | null;
}

/**
 * Any of Coolify's eight standalone database tables. The per-engine credential
 * fields are read by name, so one loose shape beats eight.
 */
export interface CoolifyDatabase {
  uuid: string;
  name?: string | null;
  description?: string | null;
  environment_id?: number | null;
  status?: string | null;
  /**
   * `standalone-postgresql`, `standalone-redis`, ... The API spells it
   * `database_type` on BOTH the list and the detail endpoints; `type` is read
   * only because an older instance may still answer with it.
   */
  database_type?: string | null;
  type?: string | null;
  image?: string | null;
  is_public?: boolean | null;
  public_port?: number | null;
  limits_memory?: string | null;
  limits_memory_reservation?: string | null;
  limits_cpus?: string | null;
  init_scripts?: unknown;
  [field: string]: unknown;
}

export interface CoolifyEnv {
  key?: string | null;
  /** Present only for a token holding `read:sensitive`; that is how the scan
   *  detects the scope without a second call. */
  value?: string | null;
  real_value?: string | null;
  is_literal?: boolean | null;
  is_multiline?: boolean | null;
  /** The panel showed this value once and never answers with it again, whatever
   *  the token holds. */
  is_shown_once?: boolean | null;
  is_preview?: boolean | null;
  is_runtime?: boolean | null;
  is_buildtime?: boolean | null;
  is_shared?: boolean | null;
}

/** A `LocalPersistentVolume` row: `name` IS the volume's name on the host. */
export interface CoolifyStorage {
  uuid?: string | null;
  name?: string | null;
  mount_path?: string | null;
  host_path?: string | null;
  container_id?: string | null;
  is_directory?: boolean | null;
  /** File storages only, and only for a token holding `read:sensitive`. */
  content?: string | null;
}

export interface CoolifyStorages {
  persistent_storages?: CoolifyStorage[] | null;
  file_storages?: CoolifyStorage[] | null;
}

export interface CoolifyScheduledTask {
  uuid: string;
  name?: string | null;
  command?: string | null;
  frequency?: string | null;
  container?: string | null;
  timeout?: number | null;
  enabled?: boolean | null;
}

export interface CoolifyS3Storage {
  uuid: string;
  name?: string | null;
  description?: string | null;
  region?: string | null;
  bucket?: string | null;
  endpoint?: string | null;
  /** Both only for a token holding `read:sensitive`. */
  key?: string | null;
  secret?: string | null;
}

export interface CoolifyTeam {
  id?: number | null;
  name?: string | null;
  description?: string | null;
}

export interface CoolifyUser {
  id?: number | null;
  name?: string | null;
  email?: string | null;
}

/* ------------------------------------------------------------------ */
/* Rate limit                                                          */
/* ------------------------------------------------------------------ */

/**
 * Coolify allows 200 requests a minute. Deplo takes 150: a person is usually
 * using the same panel while a scan runs, and the budget is not ours alone.
 *
 * ponytail: one bucket per process; a multi-instance control plane wants it in
 * Postgres.
 */
const RATE_PER_MINUTE = 150;
const buckets = new Map<string, { tokens: number; refilledAt: number }>();

async function take(baseUrl: string): Promise<void> {
  for (;;) {
    const now = Date.now();
    const b = buckets.get(baseUrl) ?? {
      tokens: RATE_PER_MINUTE,
      refilledAt: now,
    };
    const refill = ((now - b.refilledAt) / 60_000) * RATE_PER_MINUTE;
    b.tokens = Math.min(RATE_PER_MINUTE, b.tokens + Math.max(0, refill));
    b.refilledAt = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      buckets.set(baseUrl, b);
      return;
    }
    buckets.set(baseUrl, b);
    await new Promise((r) =>
      setTimeout(r, Math.ceil(60_000 / RATE_PER_MINUTE)),
    );
  }
}

/** Tests drive many calls through one bucket; this puts it back. */
export function __resetCoolifyRateLimitForTest(): void {
  buckets.clear();
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

/**
 * A refusal Coolify ANSWERED with, carrying the status that says what it was.
 * A caller that probes (is this uuid a service?) has to tell a 404 from a 429.
 */
export class CoolifyHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CoolifyHttpError";
  }
}

/** Coolify's 4xx bodies are `{"message": "..."}` and mostly already actionable. */
function refusalMessage(status: number, body: string): string {
  let said = body.trim().slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string") said = parsed.message.trim();
  } catch {
    // Not JSON: whatever came back is still better than nothing.
  }
  const quoted = said ? ` (Coolify said: ${said})` : "";

  if (status === 403 && /API is disabled/i.test(said))
    return `Coolify's API is turned off on that instance. Turn it on in Settings, then try again.${quoted}`;
  if (status === 403 && /not allowed to access the API/i.test(said))
    return `Coolify only accepts API calls from an allowed IP, and this panel's address is not on that list. Add it in Coolify's settings.${quoted}`;
  if (status === 403 && /Missing required permissions/i.test(said))
    return `That token does not carry the permissions this needs. Mint one with read and read:sensitive.${quoted}`;
  if (status === 401 || status === 400)
    return said || `Coolify refused the token (${status}).`;
  if (status === 429)
    return `Coolify is rate limiting Deplo (200 requests a minute). Wait a moment and try again.${quoted}`;
  return `Coolify request failed (${status})${quoted}`;
}

function retryAfterMs(res: Response): number {
  const raw = res.headers.get("retry-after");
  const secs = raw ? Number(raw) : NaN;
  return Number.isFinite(secs) && secs > 0
    ? Math.min(secs * 1000, 30_000)
    : 2_000;
}

async function request(
  c: SourceCredential,
  method: "GET" | "POST",
  path: string,
  init: { params?: Record<string, string | undefined>; body?: unknown } = {},
): Promise<Response> {
  const url = new URL(`${c.baseUrl}/api/v1/${path.replace(/^\/+/, "")}`);
  for (const [k, v] of Object.entries(init.params ?? {}))
    if (v !== undefined) url.searchParams.set(k, v);

  const send = () => {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "deplo",
      Authorization: `Bearer ${c.apiKey}`,
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    return sendRequest(
      c.baseUrl,
      url.toString(),
      {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      COOLIFY_PANEL,
    );
  };

  await take(c.baseUrl);
  let res = await send();
  // One retry, because the budget is shared with whoever is using the panel.
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, retryAfterMs(res)));
    await take(c.baseUrl);
    res = await send();
  }
  refuseRedirect(res, COOLIFY_PANEL);
  return res;
}

async function get<T>(
  c: SourceCredential,
  path: string,
  params?: Record<string, string | undefined>,
): Promise<T> {
  const res = await request(c, "GET", path, { params });
  if (!res.ok)
    throw new CoolifyHttpError(
      res.status,
      refusalMessage(res.status, await res.text().catch(() => "")),
    );
  return (await res.json()) as T;
}

/** A read that a missing object must not fail the whole import over. */
async function getOr<T>(
  c: SourceCredential,
  path: string,
  fallback: T,
): Promise<T> {
  try {
    return await get<T>(c, path);
  } catch {
    return fallback;
  }
}

/**
 * The ONLY write this client makes: the stop of a data cutover.
 */
async function post<T>(
  c: SourceCredential,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await request(c, "POST", path, { body: body ?? {} });
  if (!res.ok)
    throw new CoolifyHttpError(
      res.status,
      refusalMessage(res.status, await res.text().catch(() => "")),
    );
  return (await res.json().catch(() => null)) as T;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export async function listProjects(
  c: SourceCredential,
): Promise<CoolifyProject[]> {
  return asArray<CoolifyProject>(await get<unknown>(c, "projects"));
}

export async function listEnvironments(
  c: SourceCredential,
  projectUuid: string,
): Promise<CoolifyEnvironment[]> {
  return asArray<CoolifyEnvironment>(
    await getOr<unknown>(c, `projects/${projectUuid}/environments`, []),
  );
}

export async function listApplications(
  c: SourceCredential,
): Promise<CoolifyApplication[]> {
  return asArray<CoolifyApplication>(await get<unknown>(c, "applications"));
}

export async function listServices(
  c: SourceCredential,
): Promise<CoolifyService[]> {
  return asArray<CoolifyService>(await get<unknown>(c, "services"));
}

export async function listDatabases(
  c: SourceCredential,
): Promise<CoolifyDatabase[]> {
  return asArray<CoolifyDatabase>(await get<unknown>(c, "databases"));
}

export async function listServers(
  c: SourceCredential,
): Promise<CoolifyServer[]> {
  return asArray<CoolifyServer>(await getOr<unknown>(c, "servers", []));
}

export async function listServerResources(
  c: SourceCredential,
  serverUuid: string,
): Promise<CoolifyServerResource[]> {
  return asArray<CoolifyServerResource>(
    await getOr<unknown>(c, `servers/${serverUuid}/resources`, []),
  );
}

export function getApplication(
  c: SourceCredential,
  uuid: string,
): Promise<CoolifyApplication> {
  return get<CoolifyApplication>(c, `applications/${uuid}`);
}

export function getService(
  c: SourceCredential,
  uuid: string,
): Promise<CoolifyService> {
  return get<CoolifyService>(c, `services/${uuid}`);
}

export function getDatabase(
  c: SourceCredential,
  uuid: string,
): Promise<CoolifyDatabase> {
  return get<CoolifyDatabase>(c, `databases/${uuid}`);
}

/** `applications` | `services` | `databases` - the path segment for a resource. */
export type CoolifyResourceGroup = "applications" | "services" | "databases";

export async function listEnvs(
  c: SourceCredential,
  group: CoolifyResourceGroup,
  uuid: string,
): Promise<CoolifyEnv[]> {
  return asArray<CoolifyEnv>(
    await getOr<unknown>(c, `${group}/${uuid}/envs`, []),
  );
}

export function listStorages(
  c: SourceCredential,
  group: CoolifyResourceGroup,
  uuid: string,
): Promise<CoolifyStorages> {
  return getOr<CoolifyStorages>(c, `${group}/${uuid}/storages`, {});
}

export async function listScheduledTasks(
  c: SourceCredential,
  group: "applications" | "services",
  uuid: string,
): Promise<CoolifyScheduledTask[]> {
  return asArray<CoolifyScheduledTask>(
    await getOr<unknown>(c, `${group}/${uuid}/scheduled-tasks`, []),
  );
}

export async function listS3Storages(
  c: SourceCredential,
): Promise<CoolifyS3Storage[]> {
  return asArray<CoolifyS3Storage>(await getOr<unknown>(c, "s3-storages", []));
}

export function currentTeam(c: SourceCredential): Promise<CoolifyTeam | null> {
  return getOr<CoolifyTeam | null>(c, "team", null);
}

export async function listTeamMembers(
  c: SourceCredential,
): Promise<CoolifyUser[]> {
  return asArray<CoolifyUser>(await getOr<unknown>(c, "team/members", []));
}

/** Shared variables, one level at a time. Serialised into an env blob upstream. */
export async function listSharedEnvs(
  c: SourceCredential,
  scope:
    | { level: "team" }
    | { level: "project"; projectUuid: string }
    | { level: "environment"; projectUuid: string; environment: string },
): Promise<CoolifyEnv[]> {
  const path =
    scope.level === "team"
      ? "team/envs"
      : scope.level === "project"
        ? `projects/${scope.projectUuid}/envs`
        : `projects/${scope.projectUuid}/environments/${encodeURIComponent(
            scope.environment,
          )}/envs`;
  return asArray<CoolifyEnv>(await getOr<unknown>(c, path, []));
}

/* ------------------------------------------------------------------ */
/* The one write                                                       */
/* ------------------------------------------------------------------ */

export function stopResource(
  c: SourceCredential,
  group: CoolifyResourceGroup,
  uuid: string,
): Promise<unknown> {
  return post<unknown>(c, `${group}/${uuid}/stop`);
}

/** The status Coolify reports for one resource, for the stop to poll. */
export async function resourceStatus(
  c: SourceCredential,
  group: CoolifyResourceGroup,
  uuid: string,
): Promise<string> {
  return (await resourceState(c, group, uuid)).status;
}

/** The status, plus the compose that says how many containers a stop has to
 *  bring down. Same one call the status already made. */
export async function resourceState(
  c: SourceCredential,
  group: CoolifyResourceGroup,
  uuid: string,
): Promise<{ status: string; compose: string }> {
  const row = await getOr<{
    status?: unknown;
    docker_compose_raw?: unknown;
    docker_compose?: unknown;
  } | null>(c, `${group}/${uuid}`, null);
  const compose =
    typeof row?.docker_compose_raw === "string"
      ? row.docker_compose_raw
      : typeof row?.docker_compose === "string"
        ? row.docker_compose
        : "";
  return {
    status: typeof row?.status === "string" ? row.status : "",
    compose,
  };
}

/**
 * The unauthenticated healthcheck. Only ever used to choose the WORDS of a
 * failure - a reverse proxy can answer 200 here, so it never decides anything.
 */
export async function panelAnswersHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await sendRequest(
      baseUrl,
      `${baseUrl}/api/health`,
      {
        method: "GET",
        headers: { Accept: "text/plain", "User-Agent": "deplo" },
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      COOLIFY_PANEL,
    );
    if (!res.ok) return false;
    const body = (await res.text().catch(() => "")).trim();
    // An HTML body is somebody's front page, not Coolify's healthcheck.
    return body.length > 0 && !body.startsWith("<");
  } catch {
    return false;
  }
}
