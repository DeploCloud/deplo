/**
 * Dokploy behind the one client interface.
 */

import { mapLimit } from "../../utils";
import type {
  MigrationSourceClient,
  RuntimeQuery,
  ServiceRuntime,
  SourceCredential,
} from "../source";
import {
  activeOrganization,
  getConvertedCompose,
  getEnvironment,
  getService,
  inspectContainer,
  listAppContainers,
  listMembers,
  listNetworks,
  listOrganizations,
  listProjects,
  listSchedules,
  listServers,
  readTraefikConfig,
  startService,
  stopService,
  type DokployRuntime,
} from "./client";
import { load as loadYaml } from "../../yaml";
import {
  DOKPLOY_PLATFORM,
  parseEnvBlob,
  sharedRefsIn,
  sourceBindMountsFrom,
  sourceVolumesFrom,
} from "../map";
import type { HostMount, NamedVolume } from "../model";

/**
 * The networks the PANEL attached, which the compose file never names: a stack's
 * per-service list, or an application's. Deplo puts every app on its Environment's
 * network, so this is a report line and not a setting to carry over.
 */
async function panelNetworkNotes(
  c: SourceCredential,
  row: unknown,
): Promise<string[]> {
  const r = row as {
    networkIds?: string[] | null;
    serviceNetworks?: { networkIds?: string[] | null }[] | null;
  };
  const ids = new Set<string>(r.networkIds ?? []);
  for (const svc of r.serviceNetworks ?? [])
    for (const id of svc.networkIds ?? []) ids.add(id);
  if (ids.size === 0) return [];
  const known = await listNetworks(c);
  const names = [...ids].map(
    (id) => known.find((n) => n.networkId === id)?.name ?? id,
  );
  return [
    `Attached on {panel} to ${names.join(", ")}, ${names.length === 1 ? "a network" : "networks"} on the server rather than part of this app - here every app in the same Environment already shares one network.`,
  ];
}

/**
 * A middleware the operator wrote into the application's own Traefik file. The
 * panel's forms never produce one, so it is the one route setting an import cannot
 * read off the row - and, unsaid, it vanished. Dokploy's own two are left out.
 */
function customMiddlewareNotes(
  traefik: string | null,
  appName: string,
): string[] {
  if (!traefik) return [];
  let doc: unknown;
  try {
    doc = loadYaml(traefik);
  } catch {
    return [];
  }
  const http = (doc as { http?: Record<string, unknown> } | null)?.http;
  if (!http || typeof http !== "object") return [];
  const own = new Set([`auth-${appName}`, "redirect-to-https"]);
  const defined = (http.middlewares ?? {}) as Record<
    string,
    Record<string, unknown> | null
  >;
  const names = new Set<string>();
  for (const name of Object.keys(defined)) if (!own.has(name)) names.add(name);
  for (const router of Object.values(
    (http.routers ?? {}) as Record<string, { middlewares?: unknown }>,
  ))
    for (const m of Array.isArray(router?.middlewares)
      ? router.middlewares
      : [])
      if (typeof m === "string" && !own.has(m)) names.add(m);
  return [...names].map((name) => {
    const kind = Object.keys(defined[name] ?? {})[0];
    return `Its Traefik file on {panel} carries a custom middleware, ${name}${kind ? ` (${kind})` : ""}, which did not come across. A domain here takes a middleware by name, so define it in the proxy's configuration first, then add it to the domain.`;
  });
}

/**
 * Which containers a service runs, and what they mount.
 */
async function serviceRuntime(
  c: SourceCredential,
  svc: RuntimeQuery,
): Promise<ServiceRuntime> {
  // A compose stack's containers are plain ones named after the stack; an application
  // or a database is a swarm service.
  const order: DokployRuntime[] =
    svc.kind === "compose" ? ["standalone", "swarm"] : ["swarm", "standalone"];

  let containers: { containerId: string }[] = [];
  for (const type of order) {
    containers = await listAppContainers(c, svc.appName, type).catch(() => []);
    if (containers.length > 0) break;
  }
  // No container is the NORMAL state of a platform someone is leaving (Dokploy stops
  // a service by scaling it to 0 replicas), and the volume is still on the host.
  if (containers.length === 0)
    return {
      volumes: svc.declaredVolumes,
      hostMounts: svc.declaredBindMounts,
      running: false,
      undetermined:
        svc.declaredVolumes.length + svc.declaredBindMounts.length === 0,
      // The count is volumes AND host binds: a service with only a bind mount
      // used to be told it "declares no volume", right beside the bind mount the
      // plan had already paired for it.
      notes:
        svc.declaredVolumes.length + svc.declaredBindMounts.length > 0
          ? [
              `${svc.appName} is stopped on Dokploy, so its data comes from what Dokploy says it mounts rather than from a live container.`,
            ]
          : // Never "there is nothing to copy": for a compose stack that is what
            // "Dokploy stopped answering about it" also looks like, and somebody
            // read it as a verdict and pressed Deploy over their own data.
            [
              `Dokploy has no container for ${svc.appName} and names nothing it mounts, so Deplo cannot tell what its data is. If it had any, start it again on Dokploy and run the copy from here - a running stack names its own volumes. Do not deploy this one until you have.`,
            ],
    };

  const volumes: NamedVolume[] = [];
  const hostMounts: HostMount[] = [];
  const seen = new Set<string>();
  const seenBind = new Set<string>();
  const notes: string[] = [];
  let running = false;
  await mapLimit(containers, 4, async (ct) => {
    const info = await inspectContainer(c, ct.containerId).catch(() => null);
    if (!info) {
      notes.push(`Dokploy would not inspect container ${ct.containerId}.`);
      return;
    }
    if (info.State?.Running) running = true;
    for (const v of sourceVolumesFrom(info))
      if (!seen.has(v.name)) {
        seen.add(v.name);
        volumes.push(v);
      }
    for (const m of sourceBindMountsFrom(info))
      if (!seenBind.has(m.mountPath)) {
        seenBind.add(m.mountPath);
        hostMounts.push(m);
      }
  });
  return { volumes, hostMounts, running, notes };
}

export function dokployClient(c: SourceCredential): MigrationSourceClient {
  return {
    platform: "dokploy",
    baseUrl: c.baseUrl,
    displayName: DOKPLOY_PLATFORM.name,
    // Dokploy's key either reads a service or answers 403 on the call itself, so
    // there is nothing to probe for ahead of time.
    assertReadable: async () => {},
    listProjects: () => listProjects(c),
    getEnvironment: (id) => getEnvironment(c, id),
    // Dokploy hands over the REFERENCE itself - it resolves `${{project.KEY}}`
    // only at deploy time - so the refs are read straight off the blob here.
    getService: async (kind, id) => {
      const row = await getService(c, kind, id);
      const blob = (row as { env?: string | null }).env;
      const traefik =
        kind === "application" ? await readTraefikConfig(c, id) : null;
      return {
        ...row,
        sharedRefs: sharedRefsIn(parseEnvBlob(blob)),
        platformNotes: [
          ...(await panelNetworkNotes(c, row)),
          ...customMiddlewareNotes(traefik, row.appName?.trim() ?? ""),
        ],
      };
    },
    getResolvedCompose: (id) => getConvertedCompose(c, id),
    listServers: () => listServers(c),
    listMembers: () => listMembers(c),
    sourceTeam: () => activeOrganization(c),
    // A key names ONE organization, so the others are worth naming: this is the
    // list Dokploy itself shows when a key is minted.
    otherTeams: async () => {
      const [active, all] = await Promise.all([
        activeOrganization(c),
        listOrganizations(c),
      ]);
      if (!all) return null;
      return all.filter((o) => o.id !== active.id).map((o) => o.name || o.id);
    },
    listSchedules: (kind, id) => listSchedules(c, kind, id),
    // Dokploy shares variables at the project and the environment, never above.
    teamSharedEnv: async () => null,
    serverSharedEnv: async () => null,
    listBackupDestinations: async () => [],
    serviceRuntime: (svc) => serviceRuntime(c, svc),
    stopService: (kind, id) => stopService(c, kind, id),
    startService: (kind, id) => startService(c, kind, id),
    // Dokploy puts every stack on one shared network, whatever the stack is.
    platformNetworks: () => [...DOKPLOY_PLATFORM.networks],
  };
}
