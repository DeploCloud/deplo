import {
  traefikLabelsFrom,
  overlayTraefikLabels,
  validateTraefikLabels,
  type TraefikLabel,
} from "../traefik-overrides";
import { labelEntries } from "../compose-lint/traefik-labels";
import "server-only";

import yaml from "../../yaml";

import { keepAuthoredEnvText } from "../compose-lint/document";
import { deploImageMessage, serviceDeploImage } from "../deplo-image";
import { mergeResourceLimits } from "../resources";
import { injectAppVolumes, rewriteAppVolumes } from "./app-volumes";
import { wireDomainRoutes } from "./domain-routers";
import {
  assertHostnameIsWritten,
  assertNetworkModeIsNotANetwork,
  collapseOntoStackNetwork,
  createAppWiring,
  joinEveryService,
} from "./stack-network";
import {
  deploLabels,
  mergeBuildLabels,
  mergeEnvironment,
  mergeLabels,
  takeTraefikLabels,
} from "./service-stamp";
import { ignoredTraefikMessage } from "../compose-lint/traefik-labels";
import type { App, ComposeDoc, ComposeStackInput } from "./types";

function readComposeKeepingEnvText(compose: string): string {
  try {
    const doc = yaml.parseDocument(compose);
    if (doc.errors.length > 0) return compose;
    return keepAuthoredEnvText(doc) ? String(doc) : compose;
  } catch {
    return compose;
  }
}

export function buildComposeStack(input: ComposeStackInput): string {
  const { compose, name, deployKey, appId } = input;
  const trackingId = input.trackingId ?? appId;
  const envKeys = input.envKeys ?? [];
  const basicAuth = input.basicAuthUsers
    ? { name: `${name}-basicauth`, users: input.basicAuthUsers }
    : undefined;

  let doc: ComposeDoc;
  try {
    doc = (yaml.load(readComposeKeepingEnvText(compose)) as ComposeDoc) ?? {};
  } catch (e) {
    throw new Error(
      `Invalid docker-compose file: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!doc.services || typeof doc.services !== "object") {
    throw new Error("Compose file has no services to deploy");
  }

  delete doc.version;

  // No prototype: a stored service name like `__proto__` must never resolve to Object.prototype.
  const services: Record<string, App> = Object.assign(
    Object.create(null),
    doc.services,
  );
  doc.services = services;
  const named = serviceDeploImage(services, `deplo/${deployKey}-`);
  if (named)
    throw new Error(
      deploImageMessage(
        named.image,
        named.claim,
        `Service \`${named.service}\``,
      ),
    );

  // Stamped on EVERY service, or sidecars are invisible to the container count, console and teardown.
  const tracking = [
    ...deploLabels(trackingId, deployKey),
    ...(trackingId === appId ? [] : [`deplo.app=${appId}`]),
  ];
  // Off by default: an image's own `traefik.*` labels ride in, and Traefik reads the container.
  const containerLabels = [...tracking, "traefik.enable=false"];
  const ownMiddlewares = new Map<string, string[]>();
  const customLabels = new Map<string, TraefikLabel[]>();
  for (const [serviceName, svc] of Object.entries(services)) {
    if (svc && typeof svc === "object") {
      assertNetworkModeIsNotANetwork(serviceName, (svc as App).network_mode);
      assertHostnameIsWritten(serviceName, (svc as App).hostname);
      delete (svc as App).container_name;
      if (input.stripPublishedPorts) delete (svc as App).ports;
      if (input.filesDir) rewriteAppVolumes(svc as App, input.filesDir);
      if (input.allowTraefikLabels) {
        const labels = validateTraefikLabels(traefikLabelsFrom(svc.labels));
        customLabels.set(serviceName, labels);
        svc.labels = labelEntries(svc.labels)
          .filter(([key]) => !key.trim().toLowerCase().startsWith("traefik."))
          .map(([key, value]) =>
            value === undefined ? key : `${key}=${value}`,
          );
      }
      const traefik = takeTraefikLabels(svc as App, trackingId);
      ownMiddlewares.set(
        serviceName,
        input.allowTraefikLabels
          ? [
              ...new Set(
                (customLabels.get(serviceName) ?? []).flatMap(({ key }) => {
                  const match = /^traefik\.http\.middlewares\.([^.]+)\./.exec(
                    key,
                  );
                  return match ? [match[1]] : [];
                }),
              ),
            ]
          : traefik.middlewares,
      );
      if (traefik.ignored.length > 0)
        input.onWarn?.(ignoredTraefikMessage(serviceName, traefik.ignored));
      mergeLabels(svc as App, containerLabels);
      mergeBuildLabels(svc as App, serviceName, tracking);
      mergeEnvironment(svc as App, envKeys);
      mergeResourceLimits(svc as App, input.resources);
    }
  }

  const wireApp = createAppWiring(services);
  wireDomainRoutes({ services, input, basicAuth, wireApp, ownMiddlewares });
  for (const [service, labels] of customLabels) {
    if (!labels.length) continue;
    const svc = services[service];
    svc.labels = overlayTraefikLabels(
      [...(svc.labels as string[]), `traefik.docker.network=${input.network}`],
      labels,
    );
    if (
      (svc.labels as string[]).some((label) =>
        /^traefik\.enable=true$/i.test(label),
      ) &&
      !wireApp(service)
    )
      throw new Error(`Service ${service} cannot join the proxy network`);
  }
  joinEveryService({ doc, services, input, wireApp });
  collapseOntoStackNetwork(doc, services, input.network);

  injectAppVolumes(doc, services, input);

  const body = yaml.dump(doc, { lineWidth: -1, noRefs: true });
  return `# Generated by Deplo  ${deployKey}\n${body}`;
}
