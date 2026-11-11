import "server-only";

import yaml from "../../yaml";

import type { VolumeMount } from "../../types/container";
import { servicesOf } from "../compose-lint/document";
import { probeEverySecondWhileStarting } from "../health-check";
import { INFRA_NETWORK } from "../network";
import { BRIEFLY, STAND_IN_LABEL, standInName } from "../overlap";
import { portProbeHealthCheck } from "../port-probe";
import { composeServiceReplicas, serviceKeepsOneCopy } from "../replicas";
import type { App, ComposeDoc } from "./types";

// What ties a service to one container, one name, or another service's own namespace.
const ONE_COPY_KEYS = [
  "hostname",
  "links",
  "external_links",
  "volumes_from",
  "extends",
  "network_mode",
  "pid",
  "ipc",
  "mac_address",
];

// An allowlist: any other key (a fixed name, an address range, an outside network) is one two stacks cannot both hold.
const TWICE_NETWORK_KEYS = new Set([
  "internal",
  "labels",
  "attachable",
  "driver",
]);

const isRec = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** The most copies any service of the stack asks for through `deploy.replicas`. */
export function stackReplicas(compose: string | null): number {
  return Math.max(
    1,
    ...Object.values(servicesOf(compose ?? "") ?? {}).map(
      composeServiceReplicas,
    ),
  );
}

/** Why the stack's next release cannot start beside the live one, or null when every service can run twice. */
export function stackOverlapBlocker(
  authored: string,
  rendered: ComposeDoc,
  volumes?: VolumeMount[] | null,
  takenNames: readonly string[] = [],
): string | null {
  const why = (what: string) => `${what}, ${BRIEFLY}`;
  if ((volumes ?? []).some((v) => v.type !== "app"))
    return why(
      "This app has a Volume or a Bind, and two copies of the stack can't share it",
    );
  // Read as written: the render turns Files into paths on the server, which would read as a host path.
  for (const [name, svc] of Object.entries(servicesOf(authored) ?? {}))
    if (serviceKeepsOneCopy(svc))
      return why(
        `Service \`${name}\` keeps data on the server's disk or opens a port on it, and two copies of the stack can't share that`,
      );
  const services = rendered.services ?? {};
  const taken = new Set(takenNames.map((n) => n.toLowerCase()));
  for (const [name, svc] of Object.entries(services)) {
    const key = ONE_COPY_KEYS.find((k) => isRec(svc) && svc[k] != null);
    if (key)
      return why(
        `Service \`${name}\` sets \`${key}\`, which two copies of the stack can't both have`,
      );
    const next = standInName(name);
    if (next in services || taken.has(next.toLowerCase()))
      return why(
        `The new version of \`${name}\` starts as \`${next}\`, a name this environment already uses`,
      );
  }
  for (const [key, def] of Object.entries(
    isRec(rendered.networks) ? rendered.networks : {},
  )) {
    if (key === INFRA_NETWORK || !isRec(def)) continue;
    const fixed = Object.keys(def).find(
      (k) =>
        !TWICE_NETWORK_KEYS.has(k) || (k === "driver" && def[k] !== "bridge"),
    );
    if (fixed)
      return why(
        `The network \`${key}\` sets \`${fixed}\`, which two copies of the stack can't both have`,
      );
  }
  return null;
}

function routedPort(labels: unknown): number | null {
  if (!Array.isArray(labels) || !labels.includes("traefik.enable=true"))
    return null;
  for (const label of labels) {
    const m =
      /^traefik\.http\.services\.[^.]+\.loadbalancer\.server\.port=(\d+)$/.exec(
        String(label),
      );
    if (m) return Number(m[1]);
  }
  return null;
}

/** The proxy skips a container until it is healthy, so a routed service gets visitors only once it listens. */
export function probeRoutedServices(services: Record<string, App>): void {
  for (const svc of Object.values(services)) {
    if (!isRec(svc) || svc.healthcheck != null) continue;
    const port = routedPort(svc.labels);
    if (port === null) continue;
    svc.healthcheck = portProbeHealthCheck(port);
    probeEverySecondWhileStarting(svc);
  }
}

function renameDependsOn(deps: unknown): unknown {
  if (Array.isArray(deps)) return deps.map((d) => standInName(String(d)));
  if (!isRec(deps)) return deps;
  return Object.fromEntries(
    Object.entries(deps).map(([k, v]) => [standInName(k), v]),
  );
}

// On the Environment's network a stand-in answers only to its own name; on the stack's own networks, to the service's.
function standInNetworks(nets: unknown, service: string): App {
  const joined: App = Array.isArray(nets)
    ? Object.fromEntries(nets.map((k) => [String(k), null]))
    : isRec(nets)
      ? { ...nets }
      : { default: null };
  for (const key of Object.keys(joined)) {
    if (key === INFRA_NETWORK) {
      joined[key] = null;
      continue;
    }
    const own = isRec(joined[key]) ? joined[key] : {};
    const aliases = Array.isArray(own.aliases) ? own.aliases : [];
    joined[key] = { ...own, aliases: [...aliases, service] };
  }
  return joined;
}

/** The rendered stack once more, to run beside the live one: every service under a name of its own. */
export function standInStack(rendered: string): string {
  const doc = (yaml.load(rendered) as ComposeDoc) ?? {};
  const services: Record<string, App> = Object.create(null);
  for (const [name, svc] of Object.entries(doc.services ?? {})) {
    if (!isRec(svc)) continue;
    // Its images are built already, by the live stack's own build.
    delete svc.build;
    svc.labels = [
      ...(Array.isArray(svc.labels) ? svc.labels : []),
      STAND_IN_LABEL,
    ];
    if (svc.depends_on != null)
      svc.depends_on = renameDependsOn(svc.depends_on);
    svc.networks = standInNetworks(svc.networks, name);
    services[standInName(name)] = svc;
  }
  doc.services = services;
  // No service of a stack that runs twice mounts one, so a stand-in can never write the live stack's data.
  delete doc.volumes;
  const body = yaml.dump(doc, { lineWidth: -1, noRefs: true });
  return `${rendered.split("\n", 1)[0]}\n${body}`;
}
