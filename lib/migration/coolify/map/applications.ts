import { HEALTH_CHECK_DEFAULTS } from "../../../deploy/health-check";
import type { HealthCheck } from "../../../types/container";
import type {
  SourceApplication,
  SourceBuildType,
  SourceOrigin,
  SourcePort,
} from "../../model";
import type { CoolifyApplication } from "../client";
import { parseCoolifyFqdns } from "./domains";
import type { CoolifyExtras } from "./extras";
import { coolifyGitUrl } from "./git-source";
import { coolifyNotes } from "./platform-notes";

/** `"8080:80,9000:9000/udp"` -> the published-port rows the shared mapper reports. */
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

/**
 * One Coolify application -> the shared application shape. A repository behind a
 * connected source keeps that provider with no credential, so the app ASKS for a
 * GitHub App instead of failing the clone on git's "could not read Username".
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
  const git = coolifyGitUrl(row);
  const sourceType: SourceOrigin = isImage ? "docker" : git.origin;
  const domains = parseCoolifyFqdns(row.fqdn, row.docker_compose_domains);

  return {
    applicationId: row.uuid,
    sharedRefs: extras.sharedRefs ?? null,
    secretEnvKeys: extras.secretEnvKeys ?? null,
    platformNotes: [
      ...coolifyNotes(row),
      ...domains.notes,
      ...(extras.envNotes ?? []),
      ...(!isImage && git.assumed
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
    installCommand: row.install_command ?? null,
    buildCommand: row.build_command ?? null,
    dockerImage: image,
    // The PATH, not the file: `dockerfile` is the inline text somebody typed into
    // the panel, and taking it for a path built every monorepo from ./Dockerfile.
    dockerfile: row.dockerfile_location?.trim().replace(/^\/+/, "") || null,
    // The build path below already carries `base_directory`: the context is
    // relative to it, and naming it twice built from `apps/web/apps/web`.
    dockerContextPath: null,
    dockerBuildStage: row.dockerfile_target_build ?? null,
    // A publish directory only means "serve these files" when the app IS static;
    // a stale one on a nixpacks app wrapped a server in nginx.
    publishDirectory:
      row.build_pack === "static" || row.settings?.is_static
        ? (row.publish_directory ?? null)
        : null,
    isStaticSpa: row.settings?.is_spa ?? null,
    customGitUrl: git.url,
    // A bare `owner/repo` is Coolify keeping the host on a connected SOURCE -
    // which is also the only shape here that may have been a private clone.
    gitNeedsCredential: Boolean(
      row.git_repository?.trim() &&
      !/^\w+:\/\//.test(row.git_repository.trim()),
    ),
    customGitBranch: row.git_branch ?? null,
    customGitBuildPath: row.base_directory ?? null,
    isPreviewDeploymentsActive:
      row.settings?.is_preview_deployments_enabled ?? null,
    previewEnv: extras.previewEnv ?? null,
    memoryLimit: row.limits_memory ?? null,
    memoryReservation: row.limits_memory_reservation ?? null,
    cpuLimit: row.limits_cpus ?? null,
    serverId: extras.serverId ?? "",
    environmentId: extras.environmentId ?? null,
    // The port it LISTENS on, so a domain that carries none still routes
    // somewhere - `ports_exposes` is the only column that says.
    routingPort: coolifyFallbackPort(row),
    domains: domains.value,
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
 * Coolify's twelve health-check columns -> Deplo's eight. What does not fit is a
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
