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
  listDestinations,
  listVolumeBackups,
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
import { parseEnvBlob, sharedRefsIn } from "../map/env";
import { DOKPLOY_PLATFORM } from "../map/source-platform";
import {
  sourceBindMountsFrom,
  sourceVolumesFrom,
} from "../map/volume-discovery";
import type { HostMount, NamedVolume, SourceBackupSchedule } from "../model";

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

async function serviceRuntime(
  c: SourceCredential,
  svc: RuntimeQuery,
): Promise<ServiceRuntime> {
  const order: DokployRuntime[] =
    svc.kind === "compose" ? ["standalone", "swarm"] : ["swarm", "standalone"];

  let containers: { containerId: string }[] = [];
  for (const type of order) {
    containers = await listAppContainers(
      c,
      svc.appName,
      type,
      svc.serverId,
    ).catch(() => []);
    if (containers.length > 0) break;
  }
  if (containers.length === 0)
    return {
      volumes: svc.declaredVolumes,
      hostMounts: svc.declaredBindMounts,
      running: false,
      undetermined:
        svc.declaredVolumes.length + svc.declaredBindMounts.length === 0,
      notes:
        svc.declaredVolumes.length + svc.declaredBindMounts.length > 0
          ? [
              `${svc.appName} is stopped on Dokploy, so its data comes from what Dokploy says it mounts rather than from a live container.`,
            ]
          : [
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
    const info = await inspectContainer(c, ct.containerId, svc.serverId).catch(
      () => null,
    );
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

async function volumeBackupsOf(
  c: SourceCredential,
  id: string,
  kind: "application" | "compose",
  row: { backups?: SourceBackupSchedule[] | null },
): Promise<SourceBackupSchedule[]> {
  const volumes = await listVolumeBackups(c, id, kind);
  if (volumes.length === 0) return row.backups ?? [];
  const names = new Map(
    (await listDestinations(c)).map((d) => [d.destinationId ?? "", d.name]),
  );
  return [
    ...(row.backups ?? []),
    ...volumes.map((v) => ({
      schedule: v.cronExpression ?? null,
      enabled: v.enabled,
      keepLatestCount: v.keepLatestCount,
      destination: {
        name: v.destination?.name ?? names.get(v.destinationId ?? "") ?? null,
      },
      volumeName: v.volumeName ?? null,
      serviceName: v.serviceName ?? null,
    })),
  ];
}

export function dokployClient(c: SourceCredential): MigrationSourceClient {
  return {
    platform: "dokploy",
    baseUrl: c.baseUrl,
    displayName: DOKPLOY_PLATFORM.name,
    assertReadable: async () => {},
    listProjects: () => listProjects(c),
    getEnvironment: (id) => getEnvironment(c, id),
    getService: async (kind, id) => {
      const row = await getService(c, kind, id);
      const blob = (row as { env?: string | null }).env;
      const traefik =
        kind === "application" ? await readTraefikConfig(c, id) : null;
      const backups =
        kind === "application" || kind === "compose"
          ? await volumeBackupsOf(c, id, kind, row)
          : undefined;
      return {
        ...row,
        ...(backups ? { backups } : {}),
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
    otherTeams: async () => {
      const [active, all] = await Promise.all([
        activeOrganization(c),
        listOrganizations(c),
      ]);
      if (!all) return null;
      return all.filter((o) => o.id !== active.id).map((o) => o.name || o.id);
    },
    listSchedules: (kind, id) => listSchedules(c, kind, id),
    teamSharedEnv: async () => null,
    serverSharedEnv: async () => null,
    listBackupDestinations: async () =>
      (await listDestinations(c)).flatMap((d) => {
        const name = d.name?.trim();
        const endpoint = d.endpoint?.trim();
        const bucket = d.bucket?.trim();
        const accessKeyId = d.accessKey?.trim();
        const secretAccessKey = d.secretAccessKey?.trim();
        if (!name || !endpoint || !bucket || !accessKeyId || !secretAccessKey)
          return [];
        return [
          {
            name,
            endpoint,
            bucket,
            region: d.region?.trim() || "us-east-1",
            accessKeyId,
            secretAccessKey,
          },
        ];
      }),
    serviceRuntime: (svc) => serviceRuntime(c, svc),
    stopService: (kind, id) => stopService(c, kind, id),
    startService: (kind, id) => startService(c, kind, id),
    platformNetworks: () => [...DOKPLOY_PLATFORM.networks],
  };
}
