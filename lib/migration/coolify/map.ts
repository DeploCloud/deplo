/**
 * Coolify's rows → the shared source model. Pure: no network, no database.
 *
 * Everything downstream (the mappers in `../map`, the importer, the cutover) then
 * works exactly as it does for the other platform.
 */

import { HEALTH_CHECK_DEFAULTS } from "../../deploy/health-check";
import type { HealthCheck } from "../../types";
import { composeServices, parseEnvBlob } from "../map";
import type {
  SourceApplication,
  SourceBuildType,
  SourceCompose,
  SourceDatabase,
  SourceDbKind,
  SourceDomain,
  SourceMember,
  SourceMount,
  SourceOrigin,
  SourcePort,
  SourceSchedule,
  SourceServer,
} from "../model";
import type {
  CoolifyApplication,
  CoolifyDatabase,
  CoolifyEnv,
  CoolifyS3Storage,
  CoolifyScheduledTask,
  CoolifyServer,
  CoolifyService,
  CoolifyStorages,
  CoolifyUser,
} from "./client";

/* ------------------------------------------------------------------ */
/* Engines                                                             */
/* ------------------------------------------------------------------ */

/**
 * Coolify's engine name → Deplo's spelling of the same engine. `standalone-` is
 * the prefix the list endpoints put in front of it.
 */
const DB_KIND: Record<string, SourceDbKind> = {
  postgresql: "postgres",
  postgres: "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
  mongodb: "mongo",
  mongo: "mongo",
  redis: "redis",
  clickhouse: "clickhouse",
  keydb: "keydb",
  dragonfly: "dragonfly",
};

/**
 * The engine of one database ROW. `database_type` is what the API answers with -
 * reading `type` alone found nothing and dropped every database in silence.
 */
export function coolifyDbKindOf(
  row: Pick<CoolifyDatabase, "database_type" | "type">,
): SourceDbKind | null {
  return coolifyDbKind(row.database_type ?? row.type);
}

export function coolifyDbKind(
  type: string | null | undefined,
): SourceDbKind | null {
  const t = (type ?? "")
    .trim()
    .toLowerCase()
    .replace(/^standalone-/, "");
  return DB_KIND[t] ?? null;
}

/** Where each engine keeps its credentials. Read by name, never guessed. */
const DB_FIELDS: Record<
  SourceDbKind,
  { user?: string[]; password?: string[]; database?: string[]; root?: string[] }
> = {
  postgres: {
    user: ["postgres_user"],
    password: ["postgres_password"],
    database: ["postgres_db"],
  },
  mysql: {
    user: ["mysql_user"],
    password: ["mysql_password"],
    database: ["mysql_database"],
    root: ["mysql_root_password"],
  },
  mariadb: {
    user: ["mariadb_user"],
    password: ["mariadb_password"],
    database: ["mariadb_database"],
    root: ["mariadb_root_password"],
  },
  mongo: {
    user: ["mongo_initdb_root_username"],
    password: ["mongo_initdb_root_password"],
    database: ["mongo_initdb_database"],
  },
  redis: { user: ["redis_username"], password: ["redis_password"] },
  clickhouse: {
    user: ["clickhouse_admin_user"],
    password: ["clickhouse_admin_password"],
  },
  keydb: { password: ["keydb_password"] },
  dragonfly: { password: ["dragonfly_password"] },
  libsql: {},
};

/**
 * Whether this row still CARRIES its engine's password column.
 *
 * Coolify does not blank a secret for a token that may not read it - it drops the
 * key from the JSON entirely. So the presence of the key, not its value, is what
 * says whether the token holds `read:sensitive`.
 */
export function coolifyDbSecretsVisible(
  row: CoolifyDatabase,
  kind: SourceDbKind,
): boolean {
  const f = DB_FIELDS[kind];
  return [...(f.password ?? []), ...(f.root ?? [])].some((k) => k in row);
}

function pick(row: CoolifyDatabase, keys: string[] | undefined): string | null {
  for (const k of keys ?? []) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Domains                                                             */
/* ------------------------------------------------------------------ */

/** `{"app":{"domain":"https://x.com:3000"}}`, or an array of the same pairs. */
function composeDomainPairs(
  raw: string | null | undefined,
): [string, string][] {
  const text = raw?.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const out: [string, string][] = [];
  const add = (name: unknown, domain: unknown) => {
    if (typeof name === "string" && typeof domain === "string" && domain.trim())
      out.push([name, domain]);
  };
  if (Array.isArray(parsed))
    for (const e of parsed) {
      const r = e as { name?: unknown; domain?: unknown };
      add(r?.name, r?.domain);
    }
  else if (parsed && typeof parsed === "object")
    for (const [name, v] of Object.entries(parsed as Record<string, unknown>))
      add(name, (v as { domain?: unknown })?.domain ?? v);
  return out;
}

/**
 * Coolify's `fqdn` is a comma-separated list of URLs, each of which may carry the
 * CONTAINER port it routes to and a path prefix.
 */
export function parseCoolifyFqdns(
  fqdn: string | null | undefined,
  perService?: string | null,
  extra: { url: string; service: string | null; port?: number | null }[] = [],
): SourceDomain[] {
  const entries: {
    url: string;
    service: string | null;
    port?: number | null;
  }[] = [];
  for (const raw of (fqdn ?? "").split(","))
    if (raw.trim()) entries.push({ url: raw.trim(), service: null });
  for (const [service, domains] of composeDomainPairs(perService))
    for (const raw of domains.split(","))
      if (raw.trim()) entries.push({ url: raw.trim(), service });
  entries.push(...extra);

  const out: SourceDomain[] = [];
  const seen = new Set<string>();
  for (const [i, e] of entries.entries()) {
    let u: URL;
    try {
      u = new URL(/^https?:\/\//i.test(e.url) ? e.url : `https://${e.url}`);
    } catch {
      continue;
    }
    const host = u.hostname.toLowerCase();
    const path = u.pathname === "/" ? null : u.pathname.replace(/\/+$/, "");
    const key = `${host}${path ?? ""}${e.service ?? ""}`;
    if (!host || seen.has(key)) continue;
    seen.add(key);
    const https = u.protocol === "https:";
    out.push({
      domainId: `cool-fqdn-${i}`,
      host,
      https,
      port: u.port ? Number(u.port) : (e.port ?? null),
      path,
      // Coolify adds no strip-prefix middleware of its own: the path reaches the
      // container as it was requested.
      stripPath: false,
      internalPath: null,
      serviceName: e.service,
      customEntrypoint: null,
      domainType: e.service ? "compose" : "application",
      certificateType: https ? "letsencrypt" : "none",
      enabled: true,
    });
  }
  return out;
}

/**
 * `SERVICE_FQDN_<ID>` and `SERVICE_FQDN_<ID>_<PORT>`: where a one-click SERVICE
 * keeps its address. Coolify's `services` table carries no `fqdn` column at all,
 * so without this every service arrived with no domain while its own variables
 * spelled one out.
 *
 * The id half names the compose service, written without its separators
 * (`it-tools` -> `ITTOOLS`); an id that matches nothing leaves the service
 * unset and Deplo routes to the one that exposes a port.
 */
const SERVICE_FQDN_KEY = /^SERVICE_FQDN_(.+?)(?:_(\d+))?$/;

export function coolifyServiceFqdns(
  env: string | null | undefined,
  serviceNames: string[],
): { url: string; service: string | null; port: number | null }[] {
  const bare = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  const byBare = new Map(serviceNames.map((n) => [bare(n), n]));
  const out: { url: string; service: string | null; port: number | null }[] =
    [];
  for (const { key, value } of parseEnvBlob(env)) {
    const m = SERVICE_FQDN_KEY.exec(key);
    if (!m || !value.trim()) continue;
    const port = m[2] ? Number(m[2]) : null;
    out.push({
      url: value.trim(),
      service: byBare.get(bare(m[1])) ?? null,
      port: Number.isFinite(port) && port ? port : null,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

/**
 * `GET /{kind}/{uuid}/storages` → the mounts the shared mapper reads. A row with
 * a `host_path` is a bind mount; without one, `name` is already the volume's real
 * name on the host, which is more than the other platform hands over.
 */
export function coolifyMounts(st: CoolifyStorages | null | undefined): {
  mounts: SourceMount[];
  notes: string[];
} {
  const mounts: SourceMount[] = [];
  const notes: string[] = [];
  let n = 0;

  for (const s of st?.persistent_storages ?? []) {
    const mountPath = s.mount_path?.trim();
    if (!mountPath) continue;
    const hostPath = s.host_path?.trim();
    mounts.push(
      hostPath
        ? {
            mountId: s.uuid ?? `cool-mnt-${n++}`,
            type: "bind",
            hostPath,
            mountPath,
          }
        : {
            mountId: s.uuid ?? `cool-mnt-${n++}`,
            type: "volume",
            volumeName: s.name?.trim() || null,
            mountPath,
          },
    );
  }

  for (const f of st?.file_storages ?? []) {
    const mountPath = f.mount_path?.trim();
    if (!mountPath) continue;
    if (f.is_directory) {
      // A directory is not a file: its bytes travel in the data phase, not here.
      notes.push(
        `${mountPath} is a mounted DIRECTORY on {panel}, not a file - its contents come across with the data, not as a config file.`,
      );
      continue;
    }
    if (typeof f.content !== "string") {
      notes.push(
        `The file mounted at ${mountPath} did not come with its contents - re-add it under Storage.`,
      );
      continue;
    }
    mounts.push({
      mountId: f.uuid ?? `cool-file-${n++}`,
      type: "file",
      filePath: mountPath.split("/").pop() || null,
      content: f.content,
      mountPath,
    });
  }

  return { mounts, notes };
}

/* ------------------------------------------------------------------ */
/* Environment variables                                               */
/* ------------------------------------------------------------------ */

/** `{{team.KEY}}` and friends: a reference to a shared variable, not a value. */
const SHARED_REF = /\{\{\s*(team|project|environment)\.([A-Za-z0-9_]+)\s*\}\}/g;

export interface CoolifyEnvRead {
  /** `KEY=value` lines, in the shape `parseEnvBlob` reads. */
  blob: string;
  /** Keys carried only for a preview deployment - deliberately left behind. */
  previewKeys: string[];
  /** Keys that were build-time only over there. */
  buildOnlyKeys: string[];
  /** Shared variables this resource referenced, by their bare key. */
  sharedRefs: string[];
  /**
   * True when the rows arrived with no `value` at all, which is what Coolify does
   * for a token without `read:sensitive`. Importing then would land empty
   * variables, so the scan refuses instead.
   */
  masked: boolean;
}

export function coolifyEnvBlob(rows: CoolifyEnv[]): CoolifyEnvRead {
  const lines: string[] = [];
  const previewKeys: string[] = [];
  const buildOnlyKeys: string[] = [];
  const sharedRefs = new Set<string>();
  let sawValue = false;

  for (const r of rows) {
    const key = r.key?.trim();
    if (!key) continue;
    // `real_value` is the resolved one: Coolify's magic SERVICE_* variables are
    // generated once and kept, and the resolved value is what the container saw.
    const raw = r.real_value ?? r.value;
    if (typeof raw === "string") sawValue = true;
    const value = typeof raw === "string" ? raw : "";
    for (const m of value.matchAll(SHARED_REF)) sharedRefs.add(m[2]);
    if (r.is_preview) {
      previewKeys.push(key);
      continue;
    }
    if (r.is_buildtime && !r.is_runtime) buildOnlyKeys.push(key);
    lines.push(`${key}=${value}`);
  }

  return {
    blob: lines.join("\n"),
    previewKeys,
    buildOnlyKeys,
    sharedRefs: [...sharedRefs],
    masked: rows.length > 0 && !sawValue,
  };
}

/* ------------------------------------------------------------------ */
/* Ports, build packs, resources                                       */
/* ------------------------------------------------------------------ */

/** `"8080:80,9000:9000/udp"` → the published-port rows the shared mapper reports. */
export function coolifyPorts(
  mappings: string | null | undefined,
): SourcePort[] {
  const out: SourcePort[] = [];
  for (const [i, raw] of (mappings ?? "").split(",").entries()) {
    const spec = raw.trim();
    if (!spec) continue;
    const [ports, protocol] = spec.split("/");
    const parts = ports.split(":");
    const published = Number(parts[0]);
    const target = Number(parts[1] ?? parts[0]);
    if (!Number.isFinite(published) || !Number.isFinite(target)) continue;
    out.push({
      portId: `cool-port-${i}`,
      publishedPort: published,
      targetPort: target,
      protocol: protocol?.trim() || null,
    });
  }
  return out;
}

const BUILD_PACK: Record<string, SourceBuildType> = {
  nixpacks: "nixpacks",
  static: "static",
  dockerfile: "dockerfile",
};

/** The first port of `ports_exposes` - what a domain with no port routes to. */
function firstExposed(ports: string | null | undefined): number | null {
  for (const raw of (ports ?? "").split(",")) {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Git                                                                 */
/* ------------------------------------------------------------------ */

/** Which host each of Coolify's git source models lives on by default. */
const SOURCE_HOSTS: Record<string, string> = {
  githubapp: "https://github.com",
  gitlabapp: "https://gitlab.com",
  bitbucketapp: "https://bitbucket.org",
  giteaapp: "https://gitea.com",
};

/**
 * The clone URL for a Coolify application.
 *
 * `git_repository` is a whole URL for a PUBLIC repository and a bare
 * `owner/repo` for one behind a source - Coolify keeps the host on the source
 * relation and joins the two at deploy time. Taken literally, `owner/repo` is
 * what `git clone` refuses with "repository does not exist", which is every git
 * app a migration brought over.
 */
export function coolifyGitUrl(row: CoolifyApplication): {
  url: string | null;
  assumed: boolean;
} {
  const raw = row.git_repository?.trim() ?? "";
  const full = row.git_full_url?.trim() ?? "";
  if (/^(https?|ssh|git):\/\//i.test(raw) || /^[^/]+@[^/]+:/.test(raw))
    return { url: raw, assumed: false };
  if (full) return { url: full, assumed: false };
  if (!raw) return { url: null, assumed: false };

  const declared = row.source?.html_url?.trim();
  const kind = (row.source_type ?? "").split("\\").pop()?.toLowerCase() ?? "";
  const host = declared || SOURCE_HOSTS[kind];
  const path = raw.replace(/^\/+/, "").replace(/\.git$/i, "");
  return {
    url: `${(host ?? SOURCE_HOSTS.githubapp).replace(/\/+$/, "")}/${path}.git`,
    assumed: !host,
  };
}

/* ------------------------------------------------------------------ */
/* Applications                                                        */
/* ------------------------------------------------------------------ */

/** Everything about a resource that came from a call other than its own row. */
export interface CoolifyExtras {
  env?: string;
  mounts?: SourceMount[];
  serverId?: string;
  environmentId?: string;
  basicAuth?: { username: string; password: string } | null;
}

/**
 * One Coolify application → the shared application shape.
 *
 * Its git side always arrives as PLAIN git: Coolify hands over a clone URL and a
 * branch, never a provider connection Deplo could reuse, so pretending it is a
 * GitHub App connection would produce an app that cannot deploy.
 */
export function coolifyApplication(
  row: CoolifyApplication,
  extras: CoolifyExtras = {},
): SourceApplication {
  const isImage = row.build_pack === "dockerimage";
  const image = row.docker_registry_image_name?.trim()
    ? `${row.docker_registry_image_name.trim()}${
        row.docker_registry_image_tag?.trim()
          ? `:${row.docker_registry_image_tag.trim()}`
          : ""
      }`
    : null;
  const sourceType: SourceOrigin = isImage ? "docker" : "git";
  const git = coolifyGitUrl(row);

  return {
    applicationId: row.uuid,
    platformNotes: [
      ...coolifyNotes(row),
      ...(git.assumed
        ? [
            `{panel} kept ${row.git_repository?.trim()} without the server it is on, so it arrives as ${git.url}. Change it under Source if the repository lives somewhere else.`,
          ]
        : []),
    ],
    healthCheck: coolifyHealthCheck(row),
    name: row.name ?? null,
    appName: row.name ?? null,
    description: row.description ?? null,
    env: extras.env ?? null,
    icon: null,
    sourceType,
    buildType: BUILD_PACK[row.build_pack ?? ""] ?? "nixpacks",
    applicationStatus: row.status ?? null,
    watchPaths: (row.watch_paths ?? "")
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean),
    command: row.start_command ?? null,
    dockerImage: image,
    dockerfile: row.dockerfile ?? null,
    dockerContextPath: row.base_directory ?? null,
    dockerBuildStage: row.dockerfile_target_build ?? null,
    publishDirectory: row.publish_directory ?? null,
    isStaticSpa: row.settings?.is_spa ?? null,
    customGitUrl: git.url,
    customGitBranch: row.git_branch ?? null,
    customGitBuildPath: row.base_directory ?? null,
    isPreviewDeploymentsActive:
      row.settings?.is_preview_deployments_enabled ?? null,
    memoryLimit: row.limits_memory ?? null,
    memoryReservation: row.limits_memory_reservation ?? null,
    cpuLimit: row.limits_cpus ?? null,
    serverId: extras.serverId ?? "",
    environmentId: extras.environmentId ?? null,
    // The port it LISTENS on, so a domain that carries none still routes
    // somewhere - `ports_exposes` is the only column that says.
    routingPort: coolifyFallbackPort(row),
    domains: parseCoolifyFqdns(row.fqdn, row.docker_compose_domains),
    mounts: extras.mounts ?? [],
    ports: coolifyPorts(row.ports_mappings),
    security: extras.basicAuth
      ? [
          {
            securityId: `cool-auth-${row.uuid}`,
            username: extras.basicAuth.username,
            password: extras.basicAuth.password,
          },
        ]
      : [],
  };
}

/**
 * Coolify's twelve health-check columns → Deplo's eight. What does not fit is a
 * report line (`coolifyNotes`), never a silent difference.
 */
export function coolifyHealthCheck(
  row: CoolifyApplication,
): HealthCheck | null {
  if (!row.health_check_enabled) return null;
  const interval = row.health_check_interval ?? HEALTH_CHECK_DEFAULTS.intervalS;
  const timeout = row.health_check_timeout ?? HEALTH_CHECK_DEFAULTS.timeoutS;
  return {
    type: row.health_check_type === "cmd" ? "command" : "http",
    path: row.health_check_path?.trim() || "/",
    port:
      Number(row.health_check_port) > 0 ? Number(row.health_check_port) : null,
    command: row.health_check_command?.trim() || null,
    intervalS: interval,
    // Coolify lets these be equal; Deplo refuses it, because a check still running
    // when the next is due never settles either way.
    timeoutS: timeout < interval ? timeout : Math.max(1, interval - 1),
    retries: row.health_check_retries ?? HEALTH_CHECK_DEFAULTS.retries,
    startPeriodS:
      row.health_check_start_period ?? HEALTH_CHECK_DEFAULTS.startPeriodS,
  };
}

/** The port a domain with no port of its own should reach. */
export function coolifyFallbackPort(row: CoolifyApplication): number | null {
  return firstExposed(row.ports_exposes);
}

/**
 * A `dockercompose` application, or a Coolify SERVICE (a one-click template),
 * as a compose stack. The RAW file is the one the author wrote; the parsed one is
 * Coolify's copy, with its own labels, network and container names baked in.
 */
export function coolifyCompose(
  row: CoolifyApplication | CoolifyService,
  extras: CoolifyExtras = {},
): { value: SourceCompose; notes: string[] } {
  const notes: string[] = [];
  // Kept byte for byte: the file is the author's, and a trim is still an edit.
  const raw = row.docker_compose_raw?.trim() ? row.docker_compose_raw : null;
  const parsed = row.docker_compose?.trim() ? row.docker_compose : null;
  if (!raw && parsed)
    notes.push(
      "The compose file that came across is {panel}'s rendered copy, not the one you wrote - read it before deploying.",
    );
  const app = row as CoolifyApplication;
  // A SERVICE has no `fqdn` column: its address lives in SERVICE_FQDN_*.
  const magic = coolifyServiceFqdns(extras.env, composeServices(raw ?? parsed));
  return {
    value: {
      composeId: row.uuid,
      platformNotes: [...notes, ...coolifyNotes(app)],
      name: row.name ?? null,
      appName: row.name ?? null,
      description: row.description ?? null,
      env: extras.env ?? null,
      composeFile: raw || parsed || null,
      icon: null,
      composeType: "docker-compose",
      sourceType: "raw",
      serverId: extras.serverId ?? "",
      environmentId: extras.environmentId ?? null,
      domains: parseCoolifyFqdns(app.fqdn, app.docker_compose_domains, magic),
      mounts: extras.mounts ?? [],
    },
    notes,
  };
}

export function coolifyDatabase(
  row: CoolifyDatabase,
  kind: SourceDbKind,
  extras: CoolifyExtras = {},
): SourceDatabase {
  const f = DB_FIELDS[kind];
  return {
    [`${kind}Id`]: row.uuid,
    name: row.name ?? null,
    appName: row.name ?? null,
    description: row.description ?? null,
    dockerImage: row.image ?? null,
    databaseName: pick(row, f.database),
    databaseUser: pick(row, f.user),
    databasePassword: pick(row, f.password),
    databaseRootPassword: pick(row, f.root),
    env: extras.env ?? null,
    externalPort: row.is_public ? (row.public_port ?? null) : null,
    memoryLimit: row.limits_memory ?? null,
    memoryReservation: row.limits_memory_reservation ?? null,
    cpuLimit: row.limits_cpus ?? null,
    serverId: extras.serverId ?? "",
    environmentId: extras.environmentId ?? null,
    mounts: extras.mounts ?? [],
  };
}

/* ------------------------------------------------------------------ */
/* Servers, people, crons                                              */
/* ------------------------------------------------------------------ */

/** `ip === host.docker.internal || id === 0` is Coolify's own "this is my host". */
export function coolifyIsPanelHost(row: CoolifyServer): boolean {
  return row.ip?.trim() === "host.docker.internal" || row.id === 0;
}

export function coolifyServer(row: CoolifyServer): SourceServer {
  return {
    // The panel's own host is keyed `""` everywhere, exactly as it is for the
    // other platform: it has no server row a migration can point at.
    serverId: coolifyIsPanelHost(row) ? "" : row.uuid,
    name: row.name?.trim() || row.uuid,
    ipAddress: coolifyIsPanelHost(row) ? null : (row.ip ?? null),
  };
}

export function coolifyMember(row: CoolifyUser): SourceMember {
  return {
    id: row.id == null ? undefined : String(row.id),
    // Coolify hides the pivot on `GET /team/members`, so nobody's role comes
    // across. Everyone arrives as a plain member either way.
    role: null,
    email: row.email ?? null,
    name: row.name ?? null,
  };
}

/** Coolify accepts these words as well as a cron expression. Its own table. */
const CRON_WORDS: Record<string, string> = {
  every_minute: "* * * * *",
  hourly: "0 * * * *",
  daily: "0 0 * * *",
  weekly: "0 0 * * 0",
  monthly: "0 0 1 * *",
  yearly: "0 0 1 1 *",
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
};

export function coolifySchedule(row: CoolifyScheduledTask): SourceSchedule {
  const raw = (row.frequency ?? "").trim();
  return {
    scheduleId: row.uuid,
    name: row.name?.trim() || row.uuid,
    cronExpression: CRON_WORDS[raw] ?? raw,
    command: row.command ?? null,
    serviceName: row.container ?? null,
    enabled: row.enabled ?? true,
  };
}

/** A backup destination as Deplo's own destination input. */
export function coolifyDestination(row: CoolifyS3Storage): {
  name: string;
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
} | null {
  const endpoint = row.endpoint?.trim();
  const bucket = row.bucket?.trim();
  if (!endpoint || !bucket || !row.key?.trim() || !row.secret?.trim())
    return null;
  return {
    name: row.name?.trim() || bucket,
    endpoint,
    bucket,
    region: row.region?.trim() || "us-east-1",
    accessKeyId: row.key.trim(),
    secretAccessKey: row.secret.trim(),
  };
}

/* ------------------------------------------------------------------ */
/* What has no twin here                                               */
/* ------------------------------------------------------------------ */

/** `custom_labels` is base64 with one `key=value` per line. */
function decodeLabels(raw: string | null | undefined): string[] {
  const text = raw?.trim();
  if (!text) return [];
  let decoded = text;
  try {
    decoded = Buffer.from(text, "base64").toString("utf8");
  } catch {
    // Not base64: read it as it came.
  }
  return decoded
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Everything Coolify carries that Deplo has nowhere to put. Each one is a line in
 * the report rather than a silent loss.
 */
export function coolifyNotes(row: CoolifyApplication): string[] {
  const notes: string[] = [];

  // Traefik labels are dropped in silence: Deplo owns that grammar and writes its
  // own. Anything else was somebody's decision and has to be repeated by hand.
  const labels = decodeLabels(row.custom_labels).filter(
    (l) => !/^traefik\./i.test(l) && !/^caddy_/i.test(l),
  );
  if (labels.length > 0)
    notes.push(
      `Custom container label(s) on {panel} that Deplo does not carry: ${labels.join(", ")}.`,
    );

  if (row.custom_docker_run_options?.trim())
    notes.push(
      `Custom docker run options on {panel} ("${row.custom_docker_run_options.trim()}") are not applied here - set what you need under Advanced.`,
    );

  if (row.custom_network_aliases?.trim())
    notes.push(
      `Network aliases on {panel} ("${row.custom_network_aliases.trim()}") are dropped - Deplo names every service on its shared network itself.`,
    );

  for (const [value, container, when] of [
    [
      row.pre_deployment_command,
      row.pre_deployment_command_container,
      "before",
    ],
    [
      row.post_deployment_command,
      row.post_deployment_command_container,
      "after",
    ],
  ] as const)
    if (value?.trim())
      notes.push(
        `A command ran ${when} every deploy on {panel}${container?.trim() ? ` in ${container.trim()}` : ""}: "${value.trim()}". Deplo has no deployment hook - run it from the console or as a cron job.`,
      );

  if (row.redirect === "www" || row.redirect === "non-www")
    notes.push(
      `{panel} redirected ${row.redirect === "www" ? "the bare domain to www" : "www to the bare domain"}. Add the other hostname under Domains and point it at this one.`,
    );

  if (row.limits_cpuset?.trim())
    notes.push(
      `Pinned to CPUs ${row.limits_cpuset.trim()} on {panel} - set it under Resources if it still matters.`,
    );
  if (row.limits_memory_swap?.trim() && row.limits_memory_swap.trim() !== "0")
    notes.push(
      `A memory swap limit of ${row.limits_memory_swap.trim()} on {panel} - set it under Resources if it still matters.`,
    );

  if (
    row.build_pack === "static" &&
    row.custom_nginx_configuration?.trim() !== undefined &&
    row.custom_nginx_configuration?.trim()
  )
    notes.push(
      "A custom web-server configuration on {panel} is not imported - Deplo owns the static server's config.",
    );

  if (row.build_pack === "dockerfile" && !row.git_repository?.trim())
    notes.push(
      "Its Dockerfile was typed into {panel} with no repository behind it - paste it into a file here and build from it.",
    );

  // The health check that does not fit Deplo's own fields, named so nobody has to
  // diff two panels to find out what changed.
  if (row.health_check_enabled) {
    const extra: string[] = [];
    if (row.health_check_method && row.health_check_method !== "GET")
      extra.push(`method ${row.health_check_method}`);
    if (row.health_check_scheme && row.health_check_scheme !== "http")
      extra.push(`scheme ${row.health_check_scheme}`);
    if (row.health_check_host && row.health_check_host !== "localhost")
      extra.push(`host ${row.health_check_host}`);
    if (row.health_check_return_code && row.health_check_return_code !== 200)
      extra.push(`expected code ${row.health_check_return_code}`);
    if (row.health_check_response_text?.trim())
      extra.push(`expected text "${row.health_check_response_text.trim()}"`);
    if (extra.length > 0)
      notes.push(
        `Its health check on {panel} also checked ${extra.join(", ")}, which Deplo's does not.`,
      );
  }

  return notes;
}
