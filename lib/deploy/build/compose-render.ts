import { overlayTraefikLabels, type TraefikLabel } from "../traefik-overrides";
import { appTraefikOverrides } from "../../data/apps/traefik-labels";
import "server-only";

import { basicAuthUsersValue } from "../../data/basic-auth";
import type { RoutableDomain } from "../../data/domains/routes";
import { mountOptions } from "../../apps/volume-model";
import type { App } from "../../types/app";
import type {
  HealthCheck,
  MountPropagation,
  ResourceLimits,
} from "../../types/container";
import type { DeploymentEnvironment } from "../../types/deployment";
import { hostVolumeName } from "../../utils";
import { escapeComposeDollars } from "../compose-stack/compose-read";
import { stackFilesDir } from "../deploy-key";
import { certResolver } from "../domains";
import {
  healthCheckToComposeKeys,
  probeEverySecondWhileStarting,
  renderHealthCheckYaml,
  renderYamlKeys,
} from "../health-check";
import type { OverlapStacks } from "../overlap";
import { replicasRefusal } from "../replicas";
import { portProbeCommand } from "../port-probe";
import { deployNetwork } from "../network";
import { defaultLogging, renderResourceLimitsYaml } from "../resources";
import { traefikRouterLabels } from "../routing";
import { appEnv, type PreviewEnvContext } from "./deploy-env";

export type RenderComposeOptions = Parameters<typeof renderCompose>[0];

export const STAND_IN_LABEL = "deplo.stand-in=true";

// `_` never appears in an app's slug, so no other app's container can hold this name.
export function standInName(name: string): string {
  return `${name}_next`;
}

// https://deplo.build/docs/concepts/what-happens-on-a-deploy
export function renderOverlapStacks(opts: RenderComposeOptions): {
  live: string;
  standIn: string;
} {
  const healthCheckKeys = overlapHealthCheck(opts);
  const live = renderCompose({ ...opts, healthCheckKeys });
  const standIn = renderCompose({
    ...opts,
    healthCheckKeys,
    serviceName: standInName(opts.name),
    aliases: [opts.name],
    extraLabels: [STAND_IN_LABEL],
  });
  return { live, standIn };
}

// The proxy skips a container until it is healthy, so the new version gets traffic only once it listens.
function overlapHealthCheck(
  opts: RenderComposeOptions,
): Record<string, unknown> | null {
  const own =
    opts.healthCheckKeys ??
    (healthCheckToComposeKeys(opts.healthCheck).healthcheck as
      Record<string, unknown> | undefined);
  const hc = own
    ? { ...own }
    : opts.routes.length > 0
      ? {
          test: [
            "CMD-SHELL",
            escapeComposeDollars(portProbeCommand(opts.port)),
          ],
          interval: "30s",
          timeout: "5s",
          retries: 3,
          start_period: "180s",
        }
      : null;
  if (!hc) return null;
  const svc = { healthcheck: hc };
  probeEverySecondWhileStarting(svc);
  return svc.healthcheck;
}

export function renderCompose(opts: {
  traefikLabels?: TraefikLabel[];
  // The compose service and container, when it is not `name` (the stand-in of an overlap deploy).
  serviceName?: string;
  aliases?: string[];
  extraLabels?: string[];
  // More than one copy: no fixed container name, and Compose starts that many.
  replicas?: number;
  // Keep each visitor on one copy; only honoured with more than one.
  stickySessions?: boolean;
  name: string;
  image: string;
  port: number;
  appId: string;
  network: string;
  deployKey: string;
  trackingId?: string;
  routes: RoutableDomain[];
  env: Record<string, string>;
  volumes?: {
    type?: "named" | "app" | "host";
    name: string;
    projectPath?: string;
    hostPath?: string;
    mountPath: string;
    readOnly?: boolean;
    propagation?: MountPropagation;
  }[];
  ports?: string[];
  healthCheck?: HealthCheck | null;
  healthCheckKeys?: Record<string, unknown> | null;
  injectPort?: boolean;
  basicAuthUsers?: string;
  resources?: ResourceLimits | null;
  resourceKeys?: Record<string, unknown> | null;
}): string {
  const { name, image, port, appId, deployKey, routes } = opts;
  const trackingId = opts.trackingId ?? appId;
  const injectPort = opts.injectPort ?? true;
  const vols = opts.volumes ?? [];
  const namedVols = vols.filter((v) => v.type !== "host" && v.type !== "app");
  const filesDir = stackFilesDir(deployKey);
  const env = injectPort
    ? { PORT: String(port), ...opts.env }
    : { ...opts.env };
  const labels = [
    ...traefikRouterLabels({
      baseKey: name,
      routes,
      defaultPort: port,
      certResolver: certResolver(),
      dockerNetwork: opts.network,
      sticky: opts.stickySessions === true && (opts.replicas ?? 1) > 1,
      ...(opts.basicAuthUsers
        ? {
            basicAuth: {
              name: `${name}-basicauth`,
              users: opts.basicAuthUsers,
            },
          }
        : {}),
    }),
    "deplo.managed=true",
    `deplo.project=${trackingId}`,
    `deplo.slug=${deployKey}`,
    ...(trackingId === appId ? [] : [`deplo.app=${appId}`]),
    ...(opts.extraLabels ?? []),
  ];
  if (
    opts.traefikLabels?.length &&
    !labels.some((label) => label.startsWith("traefik.docker.network="))
  )
    labels.push(`traefik.docker.network=${opts.network}`);
  const labelsYaml = overlayTraefikLabels(labels, opts.traefikLabels ?? [])
    .map((l) => `      - ${JSON.stringify(l)}`)
    .join("\n");
  const envYaml = Object.keys(env).length
    ? "    environment:\n" +
      Object.entries(env)
        .map(
          ([k, v]) => `      ${k}: ${escapeComposeDollars(JSON.stringify(v))}`,
        )
        .join("\n") +
      "\n"
    : "";
  // Exactly "" when the app has none, so the stack stays byte-identical (the reroute contract).
  const appVolsYaml = vols.length
    ? "    volumes:\n" +
      vols
        .map((v) => {
          const source =
            v.type === "host"
              ? v.hostPath
              : v.type === "app"
                ? `${filesDir}/${v.projectPath}`
                : v.name;
          return `      - ${source}:${v.mountPath}${mountOptions(v)}`;
        })
        .join("\n") +
      "\n"
    : "";
  const portsYaml = (opts.ports ?? []).length
    ? "    ports:\n" +
      opts.ports!.map((p) => `      - ${JSON.stringify(p)}`).join("\n") +
      "\n"
    : "";
  const topVolsYaml = namedVols.length
    ? "\nvolumes:\n" +
      namedVols
        .map(
          (v) => `  ${v.name}:\n    name: ${hostVolumeName(deployKey, v.name)}`,
        )
        .join("\n") +
      "\n"
    : "";
  const resourcesYaml =
    (opts.resourceKeys
      ? renderYamlKeys(opts.resourceKeys, 4)
      : renderResourceLimitsYaml(opts.resources, 4)) +
    renderYamlKeys({ logging: defaultLogging() }, 4);
  const healthYaml = opts.healthCheckKeys
    ? renderYamlKeys({ healthcheck: opts.healthCheckKeys }, 4)
    : renderHealthCheckYaml(opts.healthCheck, 4);

  const service = opts.serviceName ?? name;
  const replicas = opts.replicas ?? 1;
  const identityYaml =
    replicas > 1
      ? `    restart: unless-stopped\n    deploy:\n      replicas: ${replicas}\n`
      : `    container_name: ${service}\n    restart: unless-stopped\n`;
  const networksYaml = opts.aliases?.length
    ? "    networks:\n      deplo:\n        aliases:\n" +
      opts.aliases.map((a) => `          - ${a}`).join("\n") +
      "\n"
    : "    networks:\n      - deplo\n";

  return `# Generated by Deplo  ${deployKey}
services:
  ${service}:
    image: ${image}
${identityYaml}${networksYaml}${resourcesYaml}${healthYaml}${portsYaml}${envYaml}${appVolsYaml}    labels:
${labelsYaml}

networks:
  deplo:
    name: ${opts.network}
    external: true
${topVolsYaml}`;
}

export function portMappings(ports: App["ports"]): string[] {
  return (ports ?? []).map(
    (p) => `${p.published}:${p.target}${p.protocol === "udp" ? "/udp" : ""}`,
  );
}

export async function renderDeployStack(opts: {
  project: App;
  name: string;
  deployKey: string;
  trackingId: string;
  environment: DeploymentEnvironment;
  preview: PreviewEnvContext | null;
  previewPort: number | null;
  routes: RoutableDomain[];
  image: string;
}): Promise<{
  composeYaml: string;
  env: Record<string, string>;
  // A single image's agent request carries only build input: what runs is in composeYaml.
  buildEnv: Record<string, string>;
  network: string;
  overlap: OverlapStacks;
}> {
  const { project, preview, deployKey } = opts;
  const [env, buildEnv] = await Promise.all([
    appEnv(project.id, opts.environment, { preview }),
    appEnv(project.id, opts.environment, { preview, forBuild: true }),
  ]);
  const basicAuthUsers = await basicAuthUsersValue(project.id);
  const network = deployNetwork(project, preview ? deployKey : null);
  const ports = preview ? [] : (project.ports ?? []);
  const replicas = preview ? 1 : project.replicas;
  const refusal = replicasRefusal(project, replicas);
  if (refusal) throw new Error(refusal);
  const stackOpts: RenderComposeOptions = {
    ...(await appTraefikOverrides(project.id, Boolean(preview))),
    name: opts.name,
    image: opts.image,
    port: opts.previewPort ?? project.build.port,
    appId: project.id,
    deployKey,
    trackingId: opts.trackingId,
    network,
    routes: opts.routes,
    env,
    basicAuthUsers,
    // A prebuilt image is deployed as-is: injecting PORT would override the address its author baked in.
    injectPort: project.source !== "docker-image",
    volumes: project.volumes ?? [],
    ports: portMappings(ports),
    resources: project.resources,
    healthCheck: project.healthCheck,
    replicas,
    stickySessions: project.stickySessions,
  };
  return {
    composeYaml: renderCompose(stackOpts),
    env,
    buildEnv,
    network,
    overlap: { ...renderOverlapStacks(stackOpts), ports, replicas },
  };
}
