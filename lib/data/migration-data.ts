import "server-only";

import { and, desc, eq, isNotNull, ne } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  appVolumes as appVolumesTable,
  apps as appsTable,
  databases as databasesTable,
  migrationRunItems as itemsTable,
  migrationRunTargets as targetsTable,
  migrationRuns as runsTable,
} from "../db/schema/control-plane";
import { formatBytes, mapLimit } from "../utils";
import { nowIso } from "../ids";
import { getCurrentUser } from "../auth";
import {
  canMountHostVolumes,
  isInstanceAdmin,
  reachesWholeTeam,
  requireActiveTeamId,
  requireCapability,
} from "../membership";
import { connectAgent } from "../infra/agent-client";
import { AGENT_PORT_NOTICE } from "../agent-reachability";
import { publishDatabaseChanged } from "../graphql/pubsub";
import { DB_DATA_DIRS } from "../deploy/database-compose";
import { stackFilesDir } from "../deploy/deploy-key";
import type { DatabaseType } from "../types";

import { serviceDisplayName } from "../migration/dokploy/client";
import { sourceClient } from "../migration/source";
import type { SourceCredential } from "../migration/source";
import { SOURCE_DB_KINDS } from "../migration/model";
import type { SourceDatabase } from "../migration/model";
import {
  composeHostMounts,
  composeVolumeMounts,
  isDataHostPath,
  normalizePath,
  declaredSourceBindMounts,
  declaredSourceVolumes,
  deploDatabaseVolumeName,
  deploVolumeName,
  pairHostMounts,
  pairVolumes,
  withPanel,
} from "../migration/map";
import type { HostMount, NamedVolume } from "../migration/model";
import type { PairedHostMount } from "../migration/map";

import { requireAppCapability } from "./node-access";
import {
  copyHostPathBetween,
  copyVolumeBetween,
  isCopyAborted,
  startStackOn,
  stopStackOn,
  type OnBytes,
} from "./volume-migration";
import { recordActivity } from "./activity";
import { clearDataCopyError, markDataCopyFailed } from "./data-copy";
import { runAsMigration } from "./migration-guard";
import { listServersForTeam } from "./servers";
import {
  appendRunItem,
  assertImportGate,
  credentialFor,
  migrationMachines,
  ownRun,
  refreshCounts,
  type ConnectInput,
} from "./migration-import";

/**
 * The one refusal that has to read the same on the review screen and at the
 * cutover: Deplo reads a volume by asking the agent ON the machine that holds it,
 * so a source host with no agent is a host whose data cannot move at all.
 */
const UNREACHABLE_SOURCE_HOST =
  "Deplo has no agent on the machine this service's data is on, so its data cannot be copied. Add that machine as a server first - the Connect step lists it and installs the agent for you.";

/**
 * Its twin, for the machine that HAS an agent Deplo still cannot talk to.
 */
const UNREACHABLE_SOURCE_AGENT = `Deplo cannot reach the agent on the machine this service's data is on, so nothing was stopped and no data was copied. Installing the agent is outbound and works behind any firewall; reading a volume is Deplo dialing that machine back, INBOUND. ${AGENT_PORT_NOTICE} Then check the machine's address under Servers and run the copy again.`;

/**
 * Whether the agent holding this service's data answers US.
 */
export async function sourceAgentReachable(serverId: string): Promise<boolean> {
  try {
    const conn = await connectAgent(serverId);
    try {
      await conn.hello();
    } finally {
      conn.close();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Which of `names` that host actually HAS. `null` when it could not be asked at
 * all - an agent too old for the RPC answers that way too, and refusing a copy
 * over a question nobody could answer would be the worse mistake.
 *
 * ponytail: `volumeUsage` SIZES each volume (a `du`) to answer a yes/no. Fine
 * before a copy that is about to stream the same bytes; a dedicated exists-RPC if
 * this ever runs anywhere hot.
 */
async function volumesOnHost(
  serverId: string,
  names: string[],
): Promise<Set<string> | null> {
  if (names.length === 0) return new Set();
  try {
    const conn = await connectAgent(serverId);
    try {
      return new Set((await conn.volumeUsage(names)).keys());
    } finally {
      conn.close();
    }
  } catch {
    return null;
  }
}

/**
 * The data half of a migration: move a service's volumes over, once its
 * configuration is already here.
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
  /** `Project / Environment / service`, as it reads on the source panel. */
  path: string;
  /** `application` | `compose` | one of the five engines. */
  sourceKind: string;
  sourceId: string;
  sourceName: string;
  projectName: string;
  environmentName: string;
  /** The source machine that runs it; empty string is the panel's own host. */
  sourceServerId: string;
  targetKind: "app" | "database";
  targetId: string;
  targetName: string;
  /** The Deplo server that holds the data once it is here. */
  targetServerId: string;
  /** Whether the source is still up over there. */
  running: boolean;
  /**
   * Whether the machine holding this service's data ANSWERS us - a live Hello, not
   * the stored status, which goes green on the call-home and so says nothing about
   * the direction a copy needs (see `sourceAgentReachable`).
   */
  sourceReachable: boolean;
  volumes: DataMoveVolume[];
  notes: string[];
}

export interface DataMoveResult {
  moved: number;
  failed: number;
  notes: string[];
  /**
   * The source machine stopped answering PART WAY THROUGH - a gRPC UNAVAILABLE,
   * which is a connection that died, not a volume that could not be read.
   */
  sourceGone: boolean;
}

/**
 * A gRPC UNAVAILABLE (14): the connection to the host died, however it died -
 * refused, reset mid-stream, or never established. Anything else is about the
 * volume, not the machine.
 */
function isHostGone(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 14) return true;
  return e instanceof Error && /\b14 UNAVAILABLE\b/.test(e.message);
}

/* ------------------------------------------------------------------ */
/* The source tree, read once                                          */
/* ------------------------------------------------------------------ */

/** One source service, flattened with everything a data move needs about it. */
interface SourceService {
  kind: string;
  id: string;
  name: string;
  /** The name its containers are labelled with. */
  appName: string;
  serverId: string;
  projectName: string;
  environmentName: string;
  /** What the panel SAYS it mounts, read off the same detail call. The fallback
   *  for a stopped service, which has no container to inspect. */
  declaredVolumes: NamedVolume[];
  /** Same, for the host directories it bind-mounts. */
  declaredBindMounts: HostMount[];
}

/**
 * Every service on the source instance, from ONE `project.all` call.
 *
 * Read once and passed around rather than re-fetched per lookup: the alternative
 * (a helper per field) turned one call into three for the same answer.
 */
async function sourceServices(c: SourceCredential): Promise<SourceService[]> {
  // `project.all` gives ids, not rows: an application arrives as {applicationId,
  // name, applicationStatus} and a database as {postgresId} and nothing else.
  const stubs: {
    kind: string;
    id: string;
    projectName: string;
    environmentName: string;
  }[] = [];
  for (const p of await sourceClient(c).listProjects())
    for (const env of p.environments ?? []) {
      const where = {
        projectName: p.name ?? "",
        environmentName: env.name ?? "",
      };
      for (const a of env.applications ?? [])
        stubs.push({ kind: "application", id: a.applicationId, ...where });
      for (const s of env.compose ?? [])
        stubs.push({ kind: "compose", id: s.composeId, ...where });
      for (const kind of SOURCE_DB_KINDS)
        for (const row of (env[kind] ?? []) as SourceDatabase[]) {
          const id = row[`${kind}Id`];
          if (typeof id === "string") stubs.push({ kind, id, ...where });
        }
    }

  const out: (SourceService | null)[] = new Array(stubs.length).fill(null);
  await mapLimit(
    stubs.map((stub, index) => ({ stub, index })),
    5,
    async ({ stub, index }) => {
      const detail = await sourceClient(c)
        .getService(stub.kind, stub.id)
        .catch(() => null);
      if (!detail) return;
      const appName = detail.appName?.trim() ?? "";
      // The DECLARED fallback is the only thing a stopped stack has, and a stack
      // whose YAML lives in a git repo carries none inline - so it declared
      // nothing, and one bad copy left it unrecoverable ("nothing to copy") with
      // its volumes sitting on the host. Same fallback the config import makes.
      const inline =
        "composeFile" in detail
          ? ((detail as { composeFile?: string | null }).composeFile ?? null)
          : null;
      const composeFile =
        stub.kind === "compose" && !inline?.trim()
          ? await sourceClient(c)
              .getResolvedCompose(stub.id)
              .catch(() => null)
          : inline;
      out[index] = {
        ...stub,
        name: serviceDisplayName(detail, stub.id),
        appName,
        serverId: detail.serverId ?? "",
        declaredVolumes: declaredSourceVolumes({
          kind: stub.kind,
          appName,
          mounts: detail.mounts,
          composeFile,
        }),
        declaredBindMounts: declaredSourceBindMounts(
          detail.mounts,
          composeFile,
          (detail as { stackDir?: string | null }).stackDir ?? null,
        ),
      };
    },
  );
  return out.filter((s): s is SourceService => s != null);
}

/**
 * A `./x` bind this app HAS here that nothing on the other side filled. The
 * stopped-stack case: the panel names no path for it, so it pairs with nothing
 * and used to be a clean `0/0` over a directory that should have had data in it.
 */
function unfilledStackBinds(
  landed: Landed,
  binds: PairedHostMount[],
): string[] {
  return landed.hostMounts
    .filter(
      (m) => m.stackRelative && !binds.some((b) => b.mountPath === m.mountPath),
    )
    .map(
      (m) =>
        `${m.mountPath} is bound to a directory beside this stack's compose file, and {panel} named no path for it - nothing was copied into it. Start the stack on {panel} and run the copy again if it holds data.`,
    );
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
  /** The host directories this app bind-mounts. Only an app has any. */
  hostMounts: HostMount[];
  /** Container paths a config file already fills - its bytes came across with the
   *  configuration, so no host directory has to. */
  fileMounts: Set<string>;
  /** Engine facts, for the post-copy check. Only on a database. */
  engine?: { type: DatabaseType; username: string; dbName: string };
}

/**
 * What this import run actually created: source service id → the Deplo resource.
 */
async function runTargets(
  runId: string,
): Promise<Map<string, { targetKind: "app" | "database"; targetId: string }>> {
  const rows = await getDb()
    .select({
      sourceId: itemsTable.sourceId,
      targetKind: itemsTable.targetKind,
      targetId: itemsTable.targetId,
      outcome: itemsTable.outcome,
    })
    .from(itemsTable)
    .where(eq(itemsTable.runId, runId));

  const out = new Map<
    string,
    { targetKind: "app" | "database"; targetId: string }
  >();
  for (const r of rows) {
    if (r.outcome !== "created" || !r.sourceId || !r.targetId) continue;
    if (r.targetKind !== "app" && r.targetKind !== "database") continue;
    out.set(r.sourceId, { targetKind: r.targetKind, targetId: r.targetId });
  }
  return out;
}

/**
 * The imported resource itself, with the volumes it would receive.
 *
 * Loaded BY ID and scoped to the team, so a run item pointing somewhere it should
 * not reach resolves to nothing rather than to someone else's database.
 */
async function landedFor(
  teamId: string,
  target: { targetKind: "app" | "database"; targetId: string },
): Promise<Landed | null> {
  if (target.targetKind === "database") {
    const rows = await getDb()
      .select({
        id: databasesTable.id,
        name: databasesTable.name,
        host: databasesTable.host,
        type: databasesTable.type,
        username: databasesTable.username,
        dbName: databasesTable.dbName,
        serverId: databasesTable.serverId,
      })
      .from(databasesTable)
      .where(
        and(
          eq(databasesTable.id, target.targetId),
          eq(databasesTable.teamId, teamId),
        ),
      );
    const hit = rows[0];
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
      hostMounts: [],
      fileMounts: new Set(),
      engine: {
        type: hit.type as DatabaseType,
        username: hit.username,
        dbName: hit.dbName,
      },
    };
  }

  const rows = await getDb()
    .select({
      id: appsTable.id,
      name: appsTable.name,
      slug: appsTable.slug,
      serverId: appsTable.serverId,
      compose: appsTable.compose,
    })
    .from(appsTable)
    .where(
      and(eq(appsTable.id, target.targetId), eq(appsTable.teamId, teamId)),
    );
  const hit = rows[0];
  if (!hit) return null;

  const managed = await getDb()
    .select({
      name: appVolumesTable.name,
      type: appVolumesTable.type,
      hostPath: appVolumesTable.hostPath,
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
          alias: v.name,
        })),
      ...composeVolumeMounts(hit.compose ?? "").map((v) => ({
        name: deploVolumeName(hit.slug, v.name, false),
        mountPath: v.mountPath,
        alias: v.name,
      })),
    ],
    hostMounts: [
      ...managed
        .filter((v) => v.type === "host" && (v.hostPath ?? "").trim())
        .map((v) => ({ hostPath: v.hostPath!.trim(), mountPath: v.mountPath })),
      // The stack's own YAML binds host directories too, and it is the same file
      // that came across - so the path this app reads is the path over there. A
      // `./x` bind resolves into the stack's files dir, exactly where the render
      // points it (`rewriteMountSource`).
      ...composeHostMounts(hit.compose ?? "", stackFilesDir(hit.slug)),
    ],
    // A file mount lands as a project file, not a bind, and the panel handed over
    // its CONTENT with the configuration - so nothing here is missing it.
    fileMounts: new Set(
      managed
        .filter((v) => v.type === "app")
        .map((v) => normalizePath(v.mountPath)),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Plan                                                               */
/* ------------------------------------------------------------------ */

/**
 * Every service THIS RUN imported whose data can still be moved.
 *
 * Scoped to the run on purpose. The plan drives a copy that wipes its target before
 * writing, so "which resource is this service's" has to be a fact the run recorded,
 * never a name that happens to match something in the team.
 *
 * A service with nothing to pair is still listed, carrying the notes that say why -
 * a volume that cannot be paired is the single most useful line in the whole report,
 * and dropping it silently is how a migration finishes "clean" with data left behind.
 *
 * ponytail: one container list + one inspect per container, per service. Fine for
 * the tens of services a migration has; a fleet with hundreds wants the container
 * list cached per HOST instead of per service.
 */
export async function planMigrationDataMove(
  input: ConnectInput & { runId: string },
): Promise<DataMoveService[]> {
  const { teamId } = await assertImportGate();
  const c = await credentialFor(input);
  if (!(await ownRun(input.runId, teamId)))
    throw new Error("That import run does not belong to this team.");

  const targets = await runTargets(input.runId);
  if (targets.size === 0) return [];

  // The mappers write `{panel}`; only `Report.add` used to resolve it, so every
  // note that reached a SCREEN instead of the run log still said "{panel} says".
  const panel = sourceClient(c).displayName;
  const said = (text: string) => withPanel(text, panel);
  const machines = await migrationMachines(c, teamId);
  const out: DataMoveService[] = [];
  // One Hello per distinct machine, not per service: several services share a host
  // and the answer cannot differ between them.
  const answered = new Map<string, Promise<boolean>>();
  const agentAnswers = (serverId: string) => {
    let p = answered.get(serverId);
    if (!p) {
      p = sourceAgentReachable(serverId);
      answered.set(serverId, p);
    }
    return p;
  };

  for (const svc of await sourceServices(c)) {
    const target = targets.get(svc.id);
    if (!target) continue;
    const landed = await landedFor(teamId, target);
    if (!landed) continue;

    const state = await sourceClient(c).serviceRuntime(svc);
    const paired = pairVolumes(state.volumes, landed.volumes, {
      singleData: landed.targetKind === "database",
    });
    const binds = pairHostMounts(state.hostMounts, landed.hostMounts);
    // Said HERE, before anything is stopped: a machine Deplo cannot read is a machine
    // whose data cannot move at all, and the review screen is where that has to be read
    // - not the cutover, with the old platform already down.
    const sourceServer = machines.find(
      (m) => m.sourceId === svc.serverId,
    )?.deploServerId;
    const reachable = sourceServer ? await agentAnswers(sourceServer) : false;

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
      sourceReachable: reachable,
      volumes: [
        ...paired.value,
        // A bind mount is listed as what it is: a host PATH - a directory or a single
        // file - copied by a different RPC behind a different permission. Which of the
        // two it is only the host knows, so the copy says it and the plan does not guess.
        ...binds.map((b) => ({
          sourceVolume: b.sourcePath,
          targetVolume: b.targetPath,
          mountPath: b.mountPath,
          note: b.stackRelative
            ? "A path the stack binds beside its own compose file, not a volume."
            : "A path on the host, not a volume. Copying it needs instance admin and the host-volumes permission.",
        })),
      ].map((v) => ({ ...v, note: v.note ? said(v.note) : null })),
      notes: [
        ...state.notes,
        ...paired.notes,
        ...unfilledStackBinds(landed, binds),
        ...(reachable
          ? []
          : [
              sourceServer ? UNREACHABLE_SOURCE_AGENT : UNREACHABLE_SOURCE_HOST,
            ]),
      ].map(said),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Move                                                               */
/* ------------------------------------------------------------------ */

export interface MoveInput extends ConnectInput {
  runId: string;
  /** The source service to cut over. Its volumes are DERIVED, never passed in. */
  sourceKind: string;
  sourceId: string;
  /** Bytes as they cross, for a caller that shows progress while this runs. */
  onBytes?: OnBytes;
}

/**
 * What Deplo actually saw: it asked ONE machine for a volume and that machine has
 * no such volume. Only a service that is not running makes "never started there"
 * a fair reading; for one that IS running, the machine is the wrong machine.
 */
function missingVolumeMessage(
  name: string,
  serviceName: string,
  running: boolean,
): string {
  return running
    ? `Deplo asked the machine {panel} says it runs ${serviceName} on for ${name}, and there is no such volume there - ${serviceName} is running, so its data is on a different machine. Correct that machine's address and run the copy again.`
    : `Deplo asked the machine {panel} says it runs ${serviceName} on for ${name}, and there is no such volume there. ${serviceName} is stopped over there, so it may simply never have been started - check before anyone uses it.`;
}

/**
 * Write down that the SOURCE service is now stopped over there. Backing out of a
 * takeover reads exactly these rows to start them again.
 */
async function recordSourceStopped(
  runId: string,
  serviceId: string,
  kind: string,
): Promise<void> {
  await getDb()
    .update(targetsTable)
    .set({ stoppedKind: kind, stoppedAt: nowIso() })
    .where(
      and(eq(targetsTable.runId, runId), eq(targetsTable.serviceId, serviceId)),
    );
}

/**
 * Write down the stop the copy just performed, because it was DELIBERATE.
 */
async function recordStoppedForCopy(
  landed: Landed,
  teamId: string,
): Promise<void> {
  if (landed.targetKind === "database") {
    await getDb()
      .update(databasesTable)
      .set({ status: "stopped" })
      .where(
        and(
          eq(databasesTable.id, landed.targetId),
          eq(databasesTable.teamId, teamId),
        ),
      );
    // The status badge holds an open subscription; without this it keeps the
    // snapshot it opened with until the page is reloaded.
    publishDatabaseChanged(landed.targetId);
    return;
  }
  await getDb()
    .update(appsTable)
    .set({ status: "idle", updatedAt: nowIso() })
    .where(
      and(eq(appsTable.id, landed.targetId), eq(appsTable.teamId, teamId)),
    );
}

/**
 * Every machine behind the panel answers Deplo, or nothing starts.
 *
 * The wizard refuses to reach Review without this; the API did not, so a run
 * imported eleven objects and then found six of them with no way to read their
 * data. A LIVE hello, not the stored status: that one goes green on the agent's
 * own call-home and says nothing about the direction a copy needs.
 */
export async function assertMigrationMachinesReady(
  c: SourceCredential,
): Promise<void> {
  const teamId = await requireActiveTeamId();
  const machines = await migrationMachines(c, teamId);
  const notReady: string[] = [];
  for (const m of machines) {
    const name = m.name || m.ipAddress || "the panel's own host";
    if (!m.deploServerId) notReady.push(`${name} has no agent`);
    else if (!(await sourceAgentReachable(m.deploServerId)))
      notReady.push(`${name} does not answer`);
  }
  if (notReady.length > 0)
    throw new Error(
      `Nothing was started: ${notReady.join(", ")}. Deplo reads a service's data off the machine it runs on, so every machine has to answer first - and answering means Deplo dialing its agent on TCP 9443, INBOUND. Installing the agent is the other direction and works behind any firewall, so open that port on any of them that has one. The wizard's Connect step lists them and re-checks each one.`,
    );
}

/** Where a blocked workload's data still is, so it can be fetched again. */
export interface RecopySource {
  runId: string;
  /** The panel's address, as the run recorded it. Its key is NOT kept. */
  sourceUrl: string;
  platform: string;
  sourceKind: string;
  sourceId: string;
  sourceName: string;
}

/**
 * The service this app or database was imported from.
 *
 * The report is the record: the run's key is wiped the moment it ends, so
 * copying the data again asks for it once more - and everything else it needs is
 * here rather than typed by whoever is trying to recover.
 */
export async function recopySourceFor(
  kind: "app" | "database",
  id: string,
): Promise<RecopySource | null> {
  if (kind === "app") await requireAppCapability(id, "restore_backups");
  else {
    if (!(await reachesWholeTeam())) throw new Error("Not found");
    await requireCapability("restore_backups");
  }
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select({
      runId: itemsTable.runId,
      sourceKind: itemsTable.sourceKind,
      sourceId: itemsTable.sourceId,
      sourceName: itemsTable.sourceName,
      sourceUrl: runsTable.sourceUrl,
      platform: runsTable.platform,
    })
    .from(itemsTable)
    .innerJoin(runsTable, eq(runsTable.id, itemsTable.runId))
    .where(
      and(
        eq(runsTable.teamId, teamId),
        eq(itemsTable.targetKind, kind),
        eq(itemsTable.targetId, id),
        isNotNull(itemsTable.sourceId),
        ne(itemsTable.sourceKind, "volume"),
      ),
    )
    .orderBy(desc(itemsTable.seq))
    .limit(1);
  const hit = rows[0];
  if (!hit?.sourceId) return null;
  return {
    runId: hit.runId,
    sourceUrl: hit.sourceUrl,
    platform: hit.platform,
    sourceKind: hit.sourceKind,
    sourceId: hit.sourceId,
    sourceName: hit.sourceName,
  };
}

/**
 * Cut one service's data over: stop it on the source panel, then copy every
 * paired volume into the app or database that was imported from it.
 */
/** The copy stops, starts and rewrites the very rows the import marked. */
/**
 * The copy each run currently has in flight, so a Stop can reach into it.
 */
const inFlightCopies = new Map<string, AbortController>();

/** Cut the copy this run has open, if it has one. Safe to call when it has not. */
export function abortRunCopy(runId: string): void {
  inFlightCopies.get(runId)?.abort();
}

export async function moveMigrationServiceData(
  input: MoveInput,
): Promise<DataMoveResult> {
  return runAsMigration(() => runMoveMigrationServiceData(input));
}

async function runMoveMigrationServiceData(
  input: MoveInput,
): Promise<DataMoveResult> {
  const { teamId } = await assertImportGate();
  const c = await credentialFor(input);
  const panel = sourceClient(c).displayName;
  // The run log resolves `{panel}` in `Report.add`; what this RETURNS goes to a
  // screen instead (the recopy dialog), so it has to be resolved here too.
  const saidHere = (text: string) => withPanel(text, panel);
  if (!(await ownRun(input.runId, teamId)))
    throw new Error("That import run does not belong to this team.");

  const svc = (await sourceServices(c)).find(
    (s) => s.kind === input.sourceKind && s.id === input.sourceId,
  );
  if (!svc) {
    // The listing drops a service whose detail call failed, which is not the same
    // fact as "it is gone" - a panel restarting answers that way for a moment.
    const stumbled = await sourceClient(c)
      .getService(input.sourceKind, input.sourceId)
      .catch(() => null);
    throw new Error(
      stumbled
        ? `${panel} did not answer for ${stumbled.appName?.trim() || input.sourceId} this time. Nothing was copied and nothing here was changed - run the copy again.`
        : `That service is no longer on the ${panel} instance.`,
    );
  }

  const target = (await runTargets(input.runId)).get(svc.id);
  const landed = target ? await landedFor(teamId, target) : null;
  const path = `${svc.projectName} / ${svc.environmentName} / ${svc.name}`;
  if (!landed)
    throw new Error(
      `This import did not create anything for ${svc.name}, so there is nothing here to copy its data into. Import its configuration first.`,
    );

  // The target's own gate. A database has no node dimension, so it stays team-wide
  // and answers NOT FOUND to a narrowed principal rather than confirming the id
  // exists - the rule `requireBackupCapability` states for the same reason.
  if (landed.targetKind === "app") {
    await requireAppCapability(landed.targetId, "restore_backups");
  } else {
    if (!(await reachesWholeTeam())) throw new Error("Not found");
    await requireCapability("restore_backups");
  }

  // Which Deplo server holds the source volumes.
  const sourceServerId = await resolveSourceServer(c, teamId, svc.serverId);

  const state = await sourceClient(c).serviceRuntime(svc);
  const paired = pairVolumes(state.volumes, landed.volumes, {
    singleData: landed.targetKind === "database",
  });
  const notes = [...state.notes, ...paired.notes];

  // A bind mount's bytes sit in a plain host directory, so copying one reads and
  // writes an arbitrary path on two machines.
  const binds = pairHostMounts(state.hostMounts, landed.hostMounts);
  // One nothing here mounts. Silent, this read as a stack that came across whole,
  // with an empty directory inside it.
  for (const m of state.hostMounts)
    if (
      isDataHostPath(m.hostPath) &&
      !binds.some((b) => b.sourcePath === m.hostPath) &&
      !landed.fileMounts.has(normalizePath(m.mountPath))
    )
      notes.push(
        `${m.hostPath} is mounted at ${m.mountPath} on {panel}, but nothing of ${landed.targetName} mounts that path here - what is in it was not copied.`,
      );
  notes.push(...unfilledStackBinds(landed, binds));
  // A `./x` bind is Deplo's own stack directory on both sides, so there is no host
  // path anybody typed to gate - and gating it took the common case (a one-click
  // stack whose data sits beside its compose) away from everyone but an admin.
  const mayCopyHostPaths =
    binds.every((b) => b.stackRelative) ||
    ((await isInstanceAdmin()) && (await canMountHostVolumes()));

  if (paired.value.length === 0 && binds.length === 0) {
    // Nothing to copy means nothing is stopped either: a cutover that would move
    // no bytes has no business taking the source down.
    await appendRunItem(input.runId, panel, {
      path,
      sourceKind: input.sourceKind,
      sourceName: svc.name,
      // "Deplo could not find out" is a decision for a person, not a clean skip -
      // see ServiceRuntime.undetermined.
      outcome: state.undetermined ? "manual" : "skipped",
      targetKind: landed.targetKind,
      targetId: landed.targetId,
      message:
        notes.join(" ") ||
        "Nothing to move: this service has no data of its own on {panel}.",
    });
    await refreshCounts(input.runId, teamId);
    return {
      moved: 0,
      failed: 0,
      notes: notes.map(saidHere),
      sourceGone: false,
    };
  }

  // Everything below this point either stops something or writes something, and
  // `stopService` a few lines down is the point of no return. The machine that
  // holds the bytes has to answer FIRST - see `sourceAgentReachable`.
  if (!(await sourceAgentReachable(sourceServerId))) {
    await appendRunItem(input.runId, panel, {
      path,
      sourceKind: input.sourceKind,
      sourceName: svc.name,
      sourceId: svc.id,
      outcome: "failed",
      targetKind: landed.targetKind,
      targetId: landed.targetId,
      message: UNREACHABLE_SOURCE_AGENT,
    });
    await markDataCopyFailed(
      { kind: landed.targetKind, id: landed.targetId },
      `Deplo could not reach the machine ${svc.name}'s data is on, so it was never copied`,
      { unlessCopiedIn: input.runId },
    );
    await refreshCounts(input.runId, teamId);
    // Nothing was stopped and nothing was copied, and every other service on
    // this machine is about to hit the same wall - so it counts as gone.
    return {
      moved: 0,
      failed: 1,
      notes: [...notes, UNREACHABLE_SOURCE_AGENT].map(saidHere),
      sourceGone: true,
    };
  }

  // ...and it has to HOLD the bytes. Deplo knows the exact volume names here, so
  // asking costs one RPC and answers the question the stop below cannot be taken
  // back from: a service stopped on the source panel whose volumes live on a
  // different machine is the old platform down AND an empty app here.
  if (state.running && (binds.length === 0 || !mayCopyHostPaths)) {
    const wanted = paired.value.map((p) => p.sourceVolume);
    const present = await volumesOnHost(sourceServerId, wanted);
    if (present && wanted.length > 0 && !wanted.some((n) => present.has(n))) {
      const message = `${svc.name} is running on {panel}, but none of the volumes it names (${wanted.join(", ")}) are on the machine {panel} says it runs on - so its data is somewhere else. Nothing was stopped and nothing was copied. Correct that machine's address under the Connect step and run the copy again.`;
      await appendRunItem(input.runId, panel, {
        path,
        sourceKind: input.sourceKind,
        sourceName: svc.name,
        sourceId: svc.id,
        outcome: "failed",
        targetKind: landed.targetKind,
        targetId: landed.targetId,
        message,
      });
      await markDataCopyFailed(
        { kind: landed.targetKind, id: landed.targetId },
        `None of ${svc.name}'s volumes are on the machine ${panel} says it runs on, so its data was never copied`,
        { unlessCopiedIn: input.runId },
      );
      await refreshCounts(input.runId, teamId);
      return {
        moved: 0,
        failed: 1,
        notes: [...notes, message].map(saidHere),
        sourceGone: false,
      };
    }
  }

  // A database is provisioned in the BACKGROUND by the import (`createDatabase`
  // floats it), so at this point its first container may still be running `initdb`
  // into the very volume about to be replaced.
  if (landed.targetKind === "database") {
    const settled = await waitForProvision(landed.targetId, teamId);
    if (!settled) {
      await appendRunItem(input.runId, panel, {
        path,
        sourceKind: input.sourceKind,
        sourceName: svc.name,
        sourceId: svc.id,
        outcome: "failed",
        targetKind: landed.targetKind,
        targetId: landed.targetId,
        message: `${landed.targetName} is still being created, so its data was not copied. Run the copy again once it is up.`,
      });
      await markDataCopyFailed(
        { kind: landed.targetKind, id: landed.targetId },
        `${landed.targetName} was still being created when the migration reached it, so its data was never copied`,
        { unlessCopiedIn: input.runId },
      );
      await refreshCounts(input.runId, teamId);
      return {
        moved: 0,
        failed: 1,
        notes: notes.map(saidHere),
        sourceGone: false,
      };
    }
  }

  // The point of no return, and what makes the copy trustworthy - EXCEPT for a
  // service the panel will not stop because it was never deployed, which answers
  // 500 to its own stop. Nothing is running, so nothing is moving under the
  // copy; the run has no business ending over it.
  let stoppedThere = false;
  try {
    await sourceClient(c).stopService(input.sourceKind, input.sourceId);
    stoppedThere = true;
  } catch (e) {
    const why = e instanceof Error ? e.message : `${panel} refused`;
    if (state.running) {
      await appendRunItem(input.runId, panel, {
        path,
        sourceKind: input.sourceKind,
        sourceName: svc.name,
        sourceId: svc.id,
        outcome: "failed",
        targetKind: landed.targetKind,
        targetId: landed.targetId,
        message: `${svc.name} is still running on {panel} and would not stop (${why}), so its data was not copied - copying a volume being written to would arrive corrupted. Stop it there and run the copy again.`,
      });
      await markDataCopyFailed(
        { kind: landed.targetKind, id: landed.targetId },
        `${svc.name} would not stop on ${panel}, so its data was never copied`,
        { unlessCopiedIn: input.runId },
      );
      await refreshCounts(input.runId, teamId);
      return {
        moved: 0,
        failed: 1,
        notes: notes.map(saidHere),
        sourceGone: false,
      };
    }
    notes.push(
      `{panel} would not stop ${svc.name} (${why}), but nothing of it is running there, so its data was copied as it is.`,
    );
  }
  // Only a stop that HAPPENED is written down: backing out of a takeover starts
  // these again, and starting something the operator had stopped themselves
  // would be this feature undoing their decision.
  if (stoppedThere)
    await recordSourceStopped(input.runId, input.sourceId, input.sourceKind);

  // Stop the destination too: untarring into a volume a container is writing to is
  // the same mistake in the other direction.
  try {
    await stopStackOn(landed.targetServerId, landed.targetSlug);
    await recordStoppedForCopy(landed, teamId);
  } catch {
    /* nothing of ours is running there yet */
  }

  let moved = 0;
  let failed = 0;
  let empty = 0;
  // Of `empty`, the ones that do not EXIST over there - a service created and
  // never started. See VolumeCopyResult.missing.
  let missing = 0;
  // Of `missing`, the ones belonging to a service that IS running over there,
  // which is data that should have come across and did not. Kept apart from
  // `failed` because that one also decides whether a database is started again,
  // and a database left down is not the right answer to a volume on another host.
  let notCopied = 0;
  // Set by either loop below. See DataMoveResult.sourceGone: it is the difference
  // between "this volume did not come across" and "stop the whole migration".
  let sourceGone = false;
  // What did NOT arrive, kept apart from `notes` (which also carries advice) so it
  // can be written onto the app or database itself at the end.
  const lost: string[] = [];
  const source = await connectAgent(sourceServerId);
  const dest =
    sourceServerId === landed.targetServerId
      ? source
      : await connectAgent(landed.targetServerId);
  const aborter = new AbortController();
  inFlightCopies.set(input.runId, aborter);
  try {
    for (const pair of paired.value) {
      try {
        const copied = await copyVolumeBetween(
          source,
          dest,
          pair.sourceVolume,
          pair.targetVolume,
          input.onBytes,
          aborter.signal,
        );
        // An empty source is not a copy and must never read as one.
        if (copied.empty) {
          empty++;
          if (copied.missing) missing++;
          // A RUNNING service whose volume is not where Deplo looked has its data
          // somewhere else. Left as a `skipped` line, the app came up on empty
          // storage with nothing anywhere refusing to let it.
          if (copied.missing && state.running) {
            notCopied++;
            lost.push(
              `${pair.sourceVolume} (${pair.mountPath}): not on the machine ${panel} says ${svc.name} runs on`,
            );
          }
          await appendRunItem(input.runId, panel, {
            path,
            sourceKind: "volume",
            sourceName: pair.sourceVolume,
            // Data that did not come across is a FAILURE, never a line the
            // summary folds into "skipped": a run that ends `failed: 0` over a
            // volume nobody copied reads as a clean migration.
            outcome: copied.missing && state.running ? "failed" : "skipped",
            targetKind: landed.targetKind,
            targetId: landed.targetId,
            message: copied.missing
              ? missingVolumeMessage(pair.sourceVolume, svc.name, state.running)
              : `${pair.sourceVolume} holds nothing on {panel}, so ${pair.targetVolume} (${pair.mountPath}) was left as it is.`,
          });
          continue;
        }
        moved++;
        await appendRunItem(input.runId, panel, {
          path,
          sourceKind: "volume",
          sourceName: pair.sourceVolume,
          outcome: "created",
          targetKind: landed.targetKind,
          targetId: landed.targetId,
          message:
            `Copied ${formatBytes(copied.bytes)} (compressed) into ${pair.targetVolume} (${pair.mountPath}).` +
            (pair.note ? ` ${pair.note}` : ""),
        });
      } catch (e) {
        // Cancelled, not broken: leave every remaining volume alone and let the
        // stop that asked for it do the undoing.
        if (isCopyAborted(e)) throw e;
        failed++;
        if (isHostGone(e)) sourceGone = true;
        const message = e instanceof Error ? e.message : "the copy failed";
        notes.push(`${pair.sourceVolume}: ${message}`);
        lost.push(`${pair.sourceVolume} (${pair.mountPath}): ${message}`);
        await appendRunItem(input.runId, panel, {
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
    for (const bind of binds) {
      if (!mayCopyHostPaths && !bind.stackRelative) {
        await appendRunItem(input.runId, panel, {
          path,
          sourceKind: "volume",
          sourceName: bind.sourcePath,
          outcome: "manual",
          targetKind: landed.targetKind,
          targetId: landed.targetId,
          message: `${bind.sourcePath} is a host directory (mounted at ${bind.mountPath}). Copying one needs instance admin and the host-volumes permission, so its contents did not come over.`,
        });
        continue;
      }
      // Same machine, same path: the directory the app will read IS the one the old
      // platform wrote. Copying it over itself would be a wipe followed by a
      // restore of what was just wiped - all risk, no movement.
      if (
        sourceServerId === landed.targetServerId &&
        bind.sourcePath === bind.targetPath
      ) {
        await appendRunItem(input.runId, panel, {
          path,
          sourceKind: "volume",
          sourceName: bind.sourcePath,
          outcome: "skipped",
          targetKind: landed.targetKind,
          targetId: landed.targetId,
          message: `${bind.sourcePath} is already on this machine at the same path - nothing to copy.`,
        });
        continue;
      }
      try {
        // A bind that names a FILE is carried as that one file - see
        // copyHostPathBetween, which asks the agent rather than guessing.
        const copied = await copyHostPathBetween(
          source,
          dest,
          bind.sourcePath,
          bind.targetPath,
          input.onBytes,
          aborter.signal,
        );
        if (copied.empty) {
          empty++;
          if (copied.missing) missing++;
          if (copied.missing && state.running) {
            notCopied++;
            lost.push(
              `${bind.sourcePath} (${bind.mountPath}): not on the machine ${panel} says ${svc.name} runs on`,
            );
          }
          await appendRunItem(input.runId, panel, {
            path,
            sourceKind: "volume",
            sourceName: bind.sourcePath,
            outcome: copied.missing && state.running ? "failed" : "skipped",
            targetKind: landed.targetKind,
            targetId: landed.targetId,
            message: copied.missing
              ? missingVolumeMessage(bind.sourcePath, svc.name, state.running)
              : `${bind.sourcePath} is empty on {panel}, so ${bind.targetPath} was left as it is.`,
          });
          continue;
        }
        moved++;
        await appendRunItem(input.runId, panel, {
          path,
          sourceKind: "volume",
          sourceName: bind.sourcePath,
          outcome: "created",
          targetKind: landed.targetKind,
          targetId: landed.targetId,
          message: `Copied ${formatBytes(copied.bytes)} (compressed) into ${bind.targetPath} (${bind.mountPath}), a host ${copied.file ? "file" : "directory"}.`,
        });
      } catch (e) {
        if (isCopyAborted(e)) throw e;
        failed++;
        if (isHostGone(e)) sourceGone = true;
        const message = e instanceof Error ? e.message : "the copy failed";
        notes.push(`${bind.sourcePath}: ${message}`);
        lost.push(`${bind.sourcePath} (${bind.mountPath}): ${message}`);
        await appendRunItem(input.runId, panel, {
          path,
          sourceKind: "volume",
          sourceName: bind.sourcePath,
          outcome: "failed",
          targetKind: landed.targetKind,
          targetId: landed.targetId,
          message,
        });
      }
    }
  } finally {
    inFlightCopies.delete(input.runId);
    source.close();
    if (dest !== source) dest.close();
  }

  // A database is brought back up and CHECKED, because "the bytes are in the volume"
  // is not the claim anyone cares about - "the engine reads them" is. It is brought
  // back up even when NOTHING was copied: the copy stopped it, and a service that
  // had no data to move is not a reason to leave somebody's database down.
  if (landed.targetKind === "database" && failed === 0) {
    const verdict = await startAndVerifyDatabase(landed, teamId, moved > 0);
    await appendRunItem(input.runId, panel, {
      path,
      sourceKind: input.sourceKind,
      sourceName: svc.name,
      sourceId: svc.id,
      outcome: verdict.ok ? "created" : "failed",
      targetKind: "database",
      targetId: landed.targetId,
      message: verdict.message,
    });
    if (!verdict.ok) {
      failed++;
      // Only a copy that MOVED bytes can have lost any. A database that will not
      // come back up on the volume Deplo just made is a start problem, and saying
      // "its data did not come across" would send people looking for data.
      if (moved > 0) lost.push(verdict.message);
    }
  }

  // The verdict on the whole service, written where a deploy will read it.
  const marker = { kind: landed.targetKind, id: landed.targetId } as const;
  if (lost.length > 0) await markDataCopyFailed(marker, lost.join(" | "));
  else if (failed === 0) await clearDataCopyError(marker);

  // The app half is left stopped on purpose, and the report has to say which verb
  // starts it again - a user staring at a stopped app wondering whether the move
  // broke it is a failure of the report, not of the move.
  if (moved > 0 && landed.targetKind === "app")
    notes.push(
      `${landed.targetName} is stopped on both sides. Press Deploy when the traffic should follow the data.`,
    );
  if (empty > 0 && moved === 0)
    notes.push(
      missing === empty && !state.running
        ? `Nothing was copied for ${landed.targetName}: it was never started on {panel}, so it has no data there yet. Press Deploy and it starts fresh.`
        : missing === empty
          ? `Nothing was copied for ${landed.targetName}: none of the volumes {panel} names are on the machine it says ${svc.name} runs on.`
          : `Nothing was copied for ${landed.targetName}: every volume it has on {panel} is empty.`,
    );

  for (const message of notes)
    await appendRunItem(input.runId, panel, {
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
    `Moved ${moved} data volume(s) from ${panel} into ${landed.targetName}`,
    (await getCurrentUser())?.name ?? "someone",
    landed.targetKind === "app" ? landed.targetId : null,
    teamId,
    null,
    landed.targetKind === "database" ? landed.targetId : null,
  );

  // What the caller and the summary read: data that should have arrived and did
  // not counts, whether the copy threw or the volume was simply not there.
  return {
    moved,
    failed: failed + notCopied,
    notes: notes.map(saidHere),
    sourceGone,
  };
}

/* ------------------------------------------------------------------ */
/* After the copy: does the engine actually read it                    */
/* ------------------------------------------------------------------ */

/** How long to wait for a floated `provisionDatabase` to settle, and for the
 *  engine to come back up after the copy. Both are one image pull plus a first
 *  start; a slow host on a cold image genuinely takes minutes. */
const PROVISION_WAIT_MS = 5 * 60_000;
const HEALTH_WAIT_MS = 3 * 60_000;
const POLL_MS = 2_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a database row to stop saying `provisioning`.
 */
async function waitForProvision(
  databaseId: string,
  teamId: string,
): Promise<boolean> {
  const deadline = Date.now() + PROVISION_WAIT_MS;
  for (;;) {
    const rows = await getDb()
      .select({ status: databasesTable.status })
      .from(databasesTable)
      .where(
        and(
          eq(databasesTable.id, databaseId),
          eq(databasesTable.teamId, teamId),
        ),
      );
    const status = rows[0]?.status;
    if (!status) return false;
    // "error" is settled too: the volume is not being written any more, and a
    // failed first provision is exactly the case where the copied data is what
    // makes the database work.
    if (status !== "provisioning") return true;
    if (Date.now() > deadline) return false;
    await sleep(POLL_MS);
  }
}

/**
 * What to ask each engine for a number that proves the copied data is READABLE.
 * Best effort by design - the verdict is the engine coming up healthy, and a count
 * that will not run must never turn a good copy into a reported failure.
 */
const CONTENT_COUNT: Partial<
  Record<
    DatabaseType,
    (a: { username: string; dbName: string }) => {
      command: string;
      noun: string;
    }
  >
> = {
  postgres: (a) => ({
    command: `psql -U ${a.username} -d ${a.dbName} -tAc "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')"`,
    noun: "table",
  }),
  // `-D <db>` + `database()` rather than a quoted schema list: the whole command
  // rides inside `sh -c '...'`, and a single quote cannot be escaped inside single
  // quotes in POSIX sh - the quoted form parsed as nothing and silently answered with
  // no count at all.
  mysql: (a) => ({
    command: `sh -c 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" -N -B -D ${a.dbName} -e "select count(*) from information_schema.tables where table_schema = database()"'`,
    noun: "table",
  }),
  mariadb: (a) => ({
    command: `sh -c 'mariadb -u root -p"$MARIADB_ROOT_PASSWORD" -N -B -D ${a.dbName} -e "select count(*) from information_schema.tables where table_schema = database()"'`,
    noun: "table",
  }),
  // Every database on the instance, not the one the row names: a Mongo on the old
  // platform carries no database name for the import to carry across, so the row
  // holds a placeholder and the data is wherever the app actually wrote it.
  mongodb: () => ({
    command: `sh -c 'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "db.adminCommand({listDatabases:1}).databases.filter(d=>!/^(admin|local|config)$/.test(d.name)).reduce((a,d)=>a+db.getSiblingDB(d.name).getCollectionNames().length,0)"'`,
    noun: "collection",
  }),
  // No redis: Deplo passes its password as `--requirepass` on the server's argv, so
  // nothing inside the container can authenticate a client without being handed the
  // secret again.
  clickhouse: (a) => ({
    command: `clickhouse-client --query "select count(*) from system.tables where database = '${a.dbName}'"`,
    noun: "table",
  }),
};

/**
 * Start the copied database and check the engine reads what landed in its volume.
 */
async function startAndVerifyDatabase(
  landed: Landed,
  teamId: string,
  copied: boolean,
): Promise<{ ok: boolean; message: string }> {
  const after = copied
    ? "The data was copied but "
    : "Nothing had to be copied, but ";
  try {
    await startStackOn(landed.targetServerId, landed.targetSlug);
  } catch (e) {
    return {
      ok: false,
      message: `${after}${landed.targetName} would not start: ${
        e instanceof Error ? e.message : "the host refused"
      }`,
    };
  }

  const conn = await connectAgent(landed.targetServerId);
  try {
    const deadline = Date.now() + HEALTH_WAIT_MS;
    let last = "";
    for (;;) {
      const instances = await conn
        .listInstances(landed.targetId, landed.targetSlug, "")
        .catch(() => []);
      const pick = instances.find((i) => i.running) ?? instances[0];
      // No healthcheck on the image is not the same as healthy, but it is all the
      // signal there is: a running container is then the verdict.
      if (pick?.running && (pick.health === "healthy" || pick.health === "")) {
        await setDatabaseRunningAfterCopy(landed.targetId, teamId);
        if (!copied)
          return {
            ok: true,
            message: `${landed.targetName} is back up. Nothing was copied into it, so it is the empty database Deplo created.`,
          };
        const counted = await countContent(conn, landed, pick.name, pick.image);
        return {
          ok: true,
          message: counted
            ? `${landed.targetName} is up on the copied data - ${counted}.`
            : `${landed.targetName} is up on the copied data.`,
        };
      }
      last = pick ? pick.health || pick.state || "starting" : "no container";
      if (Date.now() > deadline)
        return {
          ok: false,
          message: copied
            ? `The data was copied but ${landed.targetName} did not come up (${last}). Check its logs - a data directory written by a different engine version is the usual cause.`
            : `${landed.targetName} did not come back up after the copy step (${last}). Nothing was written to it. Check its logs.`,
        };
      await sleep(POLL_MS);
    }
  } finally {
    conn.close();
  }
}

/** The engine's own count of what it can see, or "" when it would not answer. */
async function countContent(
  conn: Awaited<ReturnType<typeof connectAgent>>,
  landed: Landed,
  container: string,
  image: string,
): Promise<string> {
  if (!landed.engine) return "";
  const ask = CONTENT_COUNT[landed.engine.type];
  if (!ask) return "";
  const { command, noun } = ask(landed.engine);
  try {
    const res = await conn.exec(landed.targetId, container, command, image);
    const value = res.stdout.trim().split(/\s+/).pop() ?? "";
    if (res.code !== 0 || !/^\d+$/.test(value)) return "";
    const n = Number(value);
    return `${n} ${noun}${n === 1 ? "" : "s"}`;
  } catch {
    return "";
  }
}

/** The copy stopped it and wrote that down; coming back up has to be written down
 *  too, or the row keeps saying "stopped" over a running engine. */
async function setDatabaseRunningAfterCopy(
  databaseId: string,
  teamId: string,
): Promise<void> {
  await getDb()
    .update(databasesTable)
    .set({ status: "running" })
    .where(
      and(eq(databasesTable.id, databaseId), eq(databasesTable.teamId, teamId)),
    );
  publishDatabaseChanged(databaseId);
}

/**
 * The Deplo server that can read a given source host's volumes. Derived from the
 * ADDRESS, and never accepted from the caller.
 */
async function resolveSourceServer(
  c: SourceCredential,
  teamId: string,
  platformServerId: string,
): Promise<string> {
  const machine = (await migrationMachines(c, teamId)).find(
    (m) => m.sourceId === platformServerId,
  );
  if (!machine)
    throw new Error(
      `${sourceClient(c).displayName} no longer lists the machine this service runs on, so Deplo cannot tell which host holds its data.`,
    );
  if (!machine.deploServerId) throw new Error(UNREACHABLE_SOURCE_HOST);
  const usable = (await listServersForTeam(teamId)).some(
    (s) => s.id === machine.deploServerId && !s.storageOnly,
  );
  if (!usable) throw new Error("That server is not available to this team.");
  return machine.deploServerId;
}
