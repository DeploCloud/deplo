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

function firstExposed(ports: string | null | undefined): number | null {
  for (const raw of (ports ?? "").split(",")) {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

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
    dockerfile: row.dockerfile_location?.trim().replace(/^\/+/, "") || null,
    dockerContextPath: null,
    dockerBuildStage: row.dockerfile_target_build ?? null,
    publishDirectory:
      row.build_pack === "static" || row.settings?.is_static
        ? (row.publish_directory ?? null)
        : null,
    isStaticSpa: row.settings?.is_spa ?? null,
    customGitUrl: git.url,
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
    timeoutS: timeout < interval ? timeout : Math.max(1, interval - 1),
    retries: row.health_check_retries ?? HEALTH_CHECK_DEFAULTS.retries,
    startPeriodS:
      row.health_check_start_period ?? HEALTH_CHECK_DEFAULTS.startPeriodS,
  };
}

export function coolifyFallbackPort(row: CoolifyApplication): number | null {
  return firstExposed(row.ports_exposes);
}
