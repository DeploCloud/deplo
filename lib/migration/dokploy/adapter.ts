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
  activeOrganizationName,
  getConvertedCompose,
  getEnvironment,
  getService,
  inspectContainer,
  listAppContainers,
  listMembers,
  listProjects,
  listSchedules,
  listServers,
  stopService,
  type DokployRuntime,
} from "./client";
import {
  DOKPLOY_PLATFORM,
  sourceBindMountsFrom,
  sourceVolumesFrom,
} from "../map";
import type { HostMount, NamedVolume } from "../model";

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
      // The count is volumes AND host binds: a service with only a bind mount
      // used to be told it "declares no volume", right beside the bind mount the
      // plan had already paired for it.
      notes:
        svc.declaredVolumes.length + svc.declaredBindMounts.length > 0
          ? [
              `${svc.appName} is stopped on Dokploy, so its data comes from what Dokploy says it mounts rather than from a live container.`,
            ]
          : [
              `Dokploy has no container for ${svc.appName} and declares nothing it mounts, so there is nothing to copy.`,
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
    getService: (kind, id) => getService(c, kind, id),
    getResolvedCompose: (id) => getConvertedCompose(c, id),
    listServers: () => listServers(c),
    listMembers: () => listMembers(c),
    organizationName: () => activeOrganizationName(c),
    listSchedules: (kind, id) => listSchedules(c, kind, id),
    serviceRuntime: (svc) => serviceRuntime(c, svc),
    stopService: (kind, id) => stopService(c, kind, id),
    // Dokploy puts every stack on one shared network, whatever the stack is.
    platformNetworks: () => [...DOKPLOY_PLATFORM.networks],
  };
}
