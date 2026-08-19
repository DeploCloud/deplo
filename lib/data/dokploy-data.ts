import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  appVolumes as appVolumesTable,
  apps as appsTable,
  databases as databasesTable,
  environments as environmentsTable,
  projects as projectsTable,
} from "../db/schema/control-plane";
import { mapLimit } from "../utils";
import { getCurrentUser } from "../auth";
import { reachesWholeTeam, requireCapability } from "../membership";
import { connectAgent } from "../infra/agent-client";
import { DB_DATA_DIRS } from "../deploy/database-compose";
import type { DatabaseType } from "../types";

import {
  DOKPLOY_DB_KINDS,
  getService,
  inspectContainer,
  listAppContainers,
  listProjects as listDokployProjects,
  serviceDisplayName,
  stopService,
  type DokployCredential,
  type DokployDatabase,
  type DokployRuntime,
} from "../dokploy/client";
import {
  composeVolumeMounts,
  declaredSourceVolumes,
  deploDatabaseVolumeName,
  deploVolumeName,
  pairVolumes,
  sourceVolumesFrom,
  type NamedVolume,
} from "../dokploy/map";

import { requireAppCapability } from "./node-access";
import { copyVolumeBetween, stopStackOn } from "./volume-migration";
import { recordActivity } from "./activity";
import { listServersForTeam } from "./servers";
import {
  appendRunItem,
  assertImportGate,
  credentialFor,
  ownRun,
  refreshCounts,
  type ConnectInput,
  type ServerChoice,
} from "./dokploy-import";

/**
 * The data half of a Dokploy migration: move a service's volumes over, once its
 * configuration is already here.
 *
 * A CUTOVER, not a copy, and deliberately one service at a time — so a fleet moves
 * in steps, each with a way back. For each service:
 *
 *   1. ask Dokploy which containers run it and `docker inspect` them (through
 *      Dokploy's own API, which is literally that command) for the REAL volume
 *      names and the paths they are mounted at;
 *   2. pair those against the imported app's own volumes BY CONTAINER PATH — the
 *      only identity the two platforms share, since neither's volume names mean
 *      anything to the other;
 *   3. STOP the service on Dokploy and leave it stopped. `ExportVolume`'s contract
 *      is that the source is quiesced, and a volume read while its container writes
 *      produces an archive nothing can be trusted from;
 *   4. relay each volume through the control plane into the Deplo one
 *      (`ExportVolume` on the source host → `ImportVolume` on the target's), which
 *      is the same star-topology relay a server move already uses.
 *
 * Nothing is deployed afterwards: the user presses Deploy when the traffic should
 * follow the data.
 *
 * **A caller never names a volume.** Both sides are derived here from the service
 * and the app it was imported into. A mutation that accepted a source and a target
 * volume name would be an instruction to copy any volume on the host into any
 * other one — another team's data into your app, or an empty archive over the
 * control plane's own database. The only thing a caller picks is WHICH SERVICE.
 */

/* ------------------------------------------------------------------ */
/* DTOs                                                               */
/* ------------------------------------------------------------------ */

export interface DataMoveVolume {
  sourceVolume: string;
  targetVolume: string;
  mountPath: string;
  note: string | null;
}

export interface DataMoveService {
  /** `Project / Environment / service`, as it reads on Dokploy. */
  path: string;
  /** `application` | `compose` | one of the five engines. */
  sourceKind: string;
  sourceId: string;
  sourceName: string;
  projectName: string;
  environmentName: string;
  /** The Dokploy server that runs it; empty string is Dokploy's own host. */
  sourceServerId: string;
  targetKind: "app" | "database";
  targetId: string;
  targetName: string;
  /** The Deplo server that holds the data once it is here. */
  targetServerId: string;
  /** Whether the source is still up over there. */
  running: boolean;
  volumes: DataMoveVolume[];
  notes: string[];
}

export interface DataMoveResult {
  moved: number;
  failed: number;
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* The source tree, read once                                          */
/* ------------------------------------------------------------------ */

/** One Dokploy service, flattened with everything a data move needs about it. */
interface SourceService {
  kind: string;
  id: string;
  name: string;
  /** The name its containers are labelled with. */
  appName: string;
  serverId: string;
  projectName: string;
  environmentName: string;
  /** What Dokploy SAYS it mounts, read off the same detail call. The fallback
   *  for a stopped service, which has no container to inspect. */
  declaredVolumes: NamedVolume[];
}

/**
 * Every service on the source instance, from ONE `project.all` call.
 *
 * Read once and passed around rather than re-fetched per lookup: the alternative
 * (a helper per field) turned one call into three for the same answer.
 */
async function sourceServices(c: DokployCredential): Promise<SourceService[]> {
  // `project.all` gives ids, not rows: an application arrives as
  // {applicationId, name, applicationStatus} and a database as {postgresId} and
  // nothing else. `appName` — the label every container of the service carries,
  // and the whole basis of finding its volumes — is only ever on the detail row.
  const stubs: { kind: string; id: string; projectName: string; environmentName: string }[] =
    [];
  for (const p of await listDokployProjects(c))
    for (const env of p.environments ?? []) {
      const where = { projectName: p.name ?? "", environmentName: env.name ?? "" };
      for (const a of env.applications ?? [])
        stubs.push({ kind: "application", id: a.applicationId, ...where });
      for (const s of env.compose ?? [])
        stubs.push({ kind: "compose", id: s.composeId, ...where });
      for (const kind of DOKPLOY_DB_KINDS)
        for (const row of (env[kind] ?? []) as DokployDatabase[]) {
          const id = row[`${kind}Id`];
          if (typeof id === "string") stubs.push({ kind, id, ...where });
        }
    }

  const out: (SourceService | null)[] = new Array(stubs.length).fill(null);
  await mapLimit(
    stubs.map((stub, index) => ({ stub, index })),
    5,
    async ({ stub, index }) => {
      const detail = await getService(c, stub.kind, stub.id).catch(() => null);
      if (!detail) return;
      const appName = detail.appName?.trim() ?? "";
      out[index] = {
        ...stub,
        name: serviceDisplayName(detail, stub.id),
        appName,
        serverId: detail.serverId ?? "",
        declaredVolumes: declaredSourceVolumes({
          kind: stub.kind,
          appName,
          mounts: detail.mounts,
          composeFile:
            "composeFile" in detail ? ((detail as { composeFile?: string | null }).composeFile ?? null) : null,
        }),
      };
    },
  );
  return out.filter((s): s is SourceService => s != null);
}

/**
 * Which containers a service runs, and the volumes they mount.
 *
 * The runtime is TRIED in order rather than assumed: Dokploy runs an application
 * or a database as a swarm service and a compose stack as a compose project, and a
 * `composeType: stack` matches neither label exactly. A lookup that committed to
 * one would find nothing and report "no volumes" — the same shape as a service
 * that genuinely has none, which is the worst possible way to be wrong here.
 */
async function sourceState(
  c: DokployCredential,
  appName: string,
  kind: string,
  declared: NamedVolume[],
): Promise<{ volumes: NamedVolume[]; running: boolean; notes: string[] }> {
  // A compose stack's containers are plain ones named after the stack; an
  // application or a database is a swarm service. Both orders end with the other
  // value rather than assuming, because a Dokploy configured differently (a
  // `composeType: stack`, an install not using swarm) still has to be found.
  const order: DokployRuntime[] =
    kind === "compose" ? ["standalone", "swarm"] : ["swarm", "standalone"];

  let containers: { containerId: string }[] = [];
  for (const type of order) {
    containers = await listAppContainers(c, appName, type).catch(() => []);
    if (containers.length > 0) break;
  }
  // No container is the NORMAL state of a platform someone is leaving (Dokploy
  // stops a service by scaling it to 0 replicas), and the volume is still on the
  // host. Fall back to what Dokploy declares it mounts rather than reporting the
  // service as having no data — which reads identically to genuinely having none.
  if (containers.length === 0)
    return {
      volumes: declared,
      running: false,
      notes: declared.length
        ? [
            `${appName} is stopped on Dokploy, so its volumes come from what Dokploy says it mounts rather than from a live container.`,
          ]
        : [
            `Dokploy has no container for ${appName} and declares no volume for it, so there is nothing to copy.`,
          ],
    };

  const volumes: NamedVolume[] = [];
  const seen = new Set<string>();
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
  });
  return { volumes, running, notes };
}

/* ------------------------------------------------------------------ */
/* The destination, and how it is found                                */
/* ------------------------------------------------------------------ */

interface Landed {
  targetKind: "app" | "database";
  targetId: string;
  targetName: string;
  /** The stack slug the agent knows it by. */
  targetSlug: string;
  targetServerId: string;
  volumes: NamedVolume[];
}

/** Case-insensitive name equality, the tolerance the import itself applies. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Where a Dokploy service ended up here, with the volumes it would receive.
 *
 * Matched the way the import PLACED it — project name, environment name, service
 * name, inside this team — so the two halves of a migration line up without
 * storing a second copy of the mapping. Renamed on either side since the import?
 * Then it is not matched, and the caller says so. That is the honest failure; the
 * alternative is copying data into whatever happens to be adjacent.
 */
async function findLanded(
  teamId: string,
  svc: { kind: string; name: string; projectName: string; environmentName: string },
): Promise<Landed | null> {
  const isDatabase = svc.kind !== "application" && svc.kind !== "compose";

  if (isDatabase) {
    // A database's display name is unique per team (`databases_team_name_uq`) and
    // the import created it with the Dokploy service's own name, so the name IS
    // the key — no slug rule to re-derive here, which would be a second copy of
    // one that already lives in `lib/data/databases.ts`.
    const rows = await getDb()
      .select({
        id: databasesTable.id,
        name: databasesTable.name,
        host: databasesTable.host,
        type: databasesTable.type,
        serverId: databasesTable.serverId,
      })
      .from(databasesTable)
      .where(eq(databasesTable.teamId, teamId));
    const hit = rows.find((d) => sameName(d.name, svc.name));
    if (!hit) return null;
    return {
      targetKind: "database",
      targetId: hit.id,
      targetName: hit.name,
      targetSlug: hit.host,
      targetServerId: hit.serverId,
      volumes: [
        {
          name: deploDatabaseVolumeName(hit.host),
          mountPath: DB_DATA_DIRS[hit.type as DatabaseType] ?? "/data",
        },
      ],
    };
  }

  const rows = await getDb()
    .select({
      id: appsTable.id,
      name: appsTable.name,
      slug: appsTable.slug,
      serverId: appsTable.serverId,
      compose: appsTable.compose,
      environmentId: appsTable.environmentId,
    })
    .from(appsTable)
    .where(eq(appsTable.teamId, teamId));

  const named = rows.filter((a) => sameName(a.name, svc.name));
  if (named.length === 0) return null;

  const placed = await placementNames(teamId);
  const hit =
    named.find((a) => {
      const at = placed.get(a.environmentId ?? "");
      return (
        at != null &&
        sameName(at.project, svc.projectName) &&
        sameName(at.environment, svc.environmentName)
      );
    }) ??
    // Exactly one app of that name and nothing to disambiguate: take it. Two would
    // be ambiguous, and an ambiguous data move is not one to guess at.
    (named.length === 1 ? named[0] : undefined);
  if (!hit) return null;

  const managed = await getDb()
    .select({
      name: appVolumesTable.name,
      type: appVolumesTable.type,
      mountPath: appVolumesTable.mountPath,
    })
    .from(appVolumesTable)
    .where(eq(appVolumesTable.appId, hit.id));

  return {
    targetKind: "app",
    targetId: hit.id,
    targetName: hit.name,
    targetSlug: hit.slug,
    targetServerId: hit.serverId,
    volumes: [
      // A volume Deplo manages is rendered with an explicit `name:`; one declared
      // in the user's own compose is prefixed by the project. Two shapes, and
      // `deploVolumeName` is the only place that knows which is which.
      ...managed
        .filter((v) => (v.type ?? "named") === "named")
        .map((v) => ({
          name: deploVolumeName(hit.slug, v.name, true),
          mountPath: v.mountPath,
        })),
      ...composeVolumeMounts(hit.compose ?? "").map((v) => ({
        name: deploVolumeName(hit.slug, v.name, false),
        mountPath: v.mountPath,
      })),
    ],
  };
}

/** environmentId → the project + environment names around it. */
async function placementNames(
  teamId: string,
): Promise<Map<string, { project: string; environment: string }>> {
  const rows = await getDb()
    .select({
      environmentId: environmentsTable.id,
      environmentName: environmentsTable.name,
      projectName: projectsTable.name,
    })
    .from(environmentsTable)
    .innerJoin(projectsTable, eq(projectsTable.id, environmentsTable.projectId))
    .where(eq(projectsTable.teamId, teamId));
  return new Map(
    rows.map((r) => [
      r.environmentId,
      { project: r.projectName, environment: r.environmentName },
    ]),
  );
}

/* ------------------------------------------------------------------ */
/* Plan                                                               */
/* ------------------------------------------------------------------ */

/**
 * Every already-imported service whose data could still be moved.
 *
 * Driven off the SOURCE tree rather than off an import run, because the cutover
 * happens days after the import and may cover services imported by several runs.
 *
 * ponytail: one container list + one inspect per container, per service. Fine for
 * the tens of services a migration has; a fleet with hundreds wants the container
 * list cached per HOST instead of per service.
 */
export async function planDokployDataMove(
  input: ConnectInput,
): Promise<DataMoveService[]> {
  const { teamId } = await assertImportGate();
  const c = await credentialFor(input);
  const out: DataMoveService[] = [];

  for (const svc of await sourceServices(c)) {
    const landed = await findLanded(teamId, svc);
    if (!landed) continue;

    const state = await sourceState(c, svc.appName, svc.kind, svc.declaredVolumes);
    const paired = pairVolumes(state.volumes, landed.volumes, {
      singleData: landed.targetKind === "database",
    });

    out.push({
      path: `${svc.projectName} / ${svc.environmentName} / ${svc.name}`,
      sourceKind: svc.kind,
      sourceId: svc.id,
      sourceName: svc.name,
      projectName: svc.projectName,
      environmentName: svc.environmentName,
      sourceServerId: svc.serverId,
      targetKind: landed.targetKind,
      targetId: landed.targetId,
      targetName: landed.targetName,
      targetServerId: landed.targetServerId,
      running: state.running,
      volumes: paired.value,
      notes: [...state.notes, ...paired.notes],
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Move                                                               */
/* ------------------------------------------------------------------ */

export interface MoveInput extends ConnectInput {
  runId: string;
  /** The Dokploy service to cut over. Its volumes are DERIVED, never passed in. */
  sourceKind: string;
  sourceId: string;
  /** Dokploy server id → Deplo server id, the same mapping the import used. */
  servers?: ServerChoice[];
}

/**
 * Cut one service's data over: stop it on Dokploy, then copy every paired volume
 * into the app or database that was imported from it.
 *
 * Gated on `restore_backups` on the TARGET — the capability that already means
 * "may overwrite this resource's data". A restore and this have the same blast
 * radius, and minting a second permission for the same power would only make one
 * of them the weaker way in.
 *
 * OWNERSHIP is not a problem here, though it looks like one: Dokploy runs the
 * Debian `postgres` image (uid 999) and Deplo renders `postgres:<v>-alpine`
 * (uid 70), so the copied files arrive owned by a user that does not exist in the
 * new container. Every one of these official images still STARTS AS ROOT and its
 * entrypoint chowns the data directory before dropping privileges (verified on a
 * live Deplo database: `Config.User` empty, pid 1 running as postgres), so the
 * first start fixes it. An app's own volume has no such gap - the image on both
 * sides is the same one, so the uid already matches. Do not add a chown step here
 * expecting to need it.
 */
export async function moveDokployServiceData(
  input: MoveInput,
): Promise<DataMoveResult> {
  const { teamId } = await assertImportGate();
  const c = await credentialFor(input);
  if (!(await ownRun(input.runId, teamId)))
    throw new Error("That import run does not belong to this team.");

  const svc = (await sourceServices(c)).find(
    (s) => s.kind === input.sourceKind && s.id === input.sourceId,
  );
  if (!svc) throw new Error("That service is no longer on the Dokploy instance.");

  const landed = await findLanded(teamId, svc);
  const path = `${svc.projectName} / ${svc.environmentName} / ${svc.name}`;
  if (!landed)
    throw new Error(
      `${svc.name} is not in this team. Import its configuration first, and keep the names as they were.`,
    );

  // The target's own gate. A database has no node dimension, so it stays team-wide
  // and answers NOT FOUND to a narrowed principal rather than confirming the id
  // exists — the rule `requireBackupCapability` states for the same reason.
  if (landed.targetKind === "app") {
    await requireAppCapability(landed.targetId, "restore_backups");
  } else {
    if (!(await reachesWholeTeam())) throw new Error("Not found");
    await requireCapability("restore_backups");
  }

  // Which Deplo server holds the Dokploy volumes. DERIVED from the service's own
  // Dokploy host through the mapping the import already collected, never a free
  // choice: pointing this at the wrong host would read a volume that does not
  // exist there and overwrite the target with an empty archive.
  const sourceServerId = await resolveSourceServer(
    teamId,
    input.servers ?? [],
    svc.serverId,
  );

  const state = await sourceState(c, svc.appName, svc.kind, svc.declaredVolumes);
  const paired = pairVolumes(state.volumes, landed.volumes, {
    singleData: landed.targetKind === "database",
  });
  const notes = [...state.notes, ...paired.notes];

  if (paired.value.length === 0) {
    // Nothing to copy means nothing is stopped either: a cutover that would move
    // no bytes has no business taking the source down.
    await appendRunItem(input.runId, {
      path,
      sourceKind: input.sourceKind,
      sourceName: svc.name,
      outcome: "skipped",
      targetKind: landed.targetKind,
      targetId: landed.targetId,
      message:
        notes.join(" ") ||
        "Nothing to move: this service has no named volumes on Dokploy.",
    });
    await refreshCounts(input.runId, teamId);
    return { moved: 0, failed: 0, notes };
  }

  // The point of no return, and what makes the copy trustworthy.
  await stopService(c, input.sourceKind, input.sourceId);

  // Stop the destination too: untarring into a volume a container is writing to is
  // the same mistake in the other direction. A never-deployed app has no stack to
  // stop and the agent says so — tolerated, because the copy itself fails loudly
  // if the host is genuinely unreachable.
  try {
    await stopStackOn(landed.targetServerId, landed.targetSlug);
  } catch {
    /* nothing of ours is running there yet */
  }

  let moved = 0;
  let failed = 0;
  const source = await connectAgent(sourceServerId);
  const dest =
    sourceServerId === landed.targetServerId
      ? source
      : await connectAgent(landed.targetServerId);
  try {
    for (const pair of paired.value) {
      try {
        await copyVolumeBetween(source, dest, pair.sourceVolume, pair.targetVolume);
        moved++;
        await appendRunItem(input.runId, {
          path,
          sourceKind: "volume",
          sourceName: pair.sourceVolume,
          outcome: "created",
          targetKind: landed.targetKind,
          targetId: landed.targetId,
          message:
            `Copied into ${pair.targetVolume} (${pair.mountPath}).` +
            (pair.note ? ` ${pair.note}` : ""),
        });
      } catch (e) {
        failed++;
        const message = e instanceof Error ? e.message : "the copy failed";
        notes.push(`${pair.sourceVolume}: ${message}`);
        await appendRunItem(input.runId, {
          path,
          sourceKind: "volume",
          sourceName: pair.sourceVolume,
          outcome: "failed",
          targetKind: landed.targetKind,
          targetId: landed.targetId,
          message,
        });
      }
    }
  } finally {
    source.close();
    if (dest !== source) dest.close();
  }

  // Both sides are stopped now, and the copy left them that way on purpose. Say
  // which verb starts this one again: "Deploy" is the app's, and a database's page
  // has a Start button - a user staring at a stopped database wondering whether the
  // move broke it is a failure of the report, not of the move.
  if (moved > 0)
    notes.push(
      landed.targetKind === "app"
        ? `${landed.targetName} is stopped on both sides. Press Deploy when the traffic should follow the data.`
        : `${landed.targetName} is stopped so the copy could land. Start it from its own page and check the data.`,
    );

  for (const message of notes)
    await appendRunItem(input.runId, {
      path,
      sourceKind: input.sourceKind,
      sourceName: svc.name,
      outcome: "manual",
      targetKind: landed.targetKind,
      targetId: landed.targetId,
      message,
    });

  await refreshCounts(input.runId, teamId);
  await recordActivity(
    landed.targetKind === "app" ? "app" : "database",
    `Moved ${moved} data volume(s) from Dokploy into ${landed.targetName}`,
    (await getCurrentUser())?.name ?? "someone",
    landed.targetKind === "app" ? landed.targetId : null,
    teamId,
  );

  return { moved, failed, notes };
}

/**
 * The Deplo server that can read a given Dokploy host's volumes.
 *
 * There is no way to ask an agent whether a volume exists, so a wrong answer here
 * is not a failure but an EMPTY copy over real data. Hence: no free-form server
 * argument, only the same Dokploy-host → Deplo-server mapping the import already
 * made, and it must name a server this team can actually deploy to.
 */
async function resolveSourceServer(
  teamId: string,
  choices: ServerChoice[],
  dokployServerId: string,
): Promise<string> {
  const mapped = choices.find((s) => s.from === dokployServerId)?.to;
  if (!mapped)
    throw new Error(
      "Tell Deplo which of its servers runs that Dokploy host: the data lives there, so Deplo has to be able to reach it. If Dokploy is on a machine Deplo does not manage yet, add it as a server first.",
    );
  const usable = (await listServersForTeam(teamId)).some(
    (s) => s.id === mapped && !s.storageOnly,
  );
  if (!usable) throw new Error("That server is not available to this team.");
  return mapped;
}
