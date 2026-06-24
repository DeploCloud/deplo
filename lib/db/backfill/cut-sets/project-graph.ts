import { count, eq, inArray } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import type { DeploData, Project } from "../../../types";
import { normalizeProject } from "../../../data/normalize-project";
import {
  buildToRow,
  deploymentToRow,
  domainToRow,
  domainMiddlewaresToRows,
  envVarToRow,
  envVarTargetsToRows,
  exposesToRows,
  folderToRow,
  logLineToRow,
  methodSettingsToRow,
  mountsToRows,
  projectToRow,
  sharedEnvGroupToRow,
  sharedEnvVarsToRows,
  volumesToRows,
  devToRow,
} from "../../../data/project-graph-rows";
import {
  deployments,
  deploymentLogs,
  domains,
  domainMiddlewares,
  envVars,
  envVarTargets,
  folders,
  projects,
  projectBuild,
  projectBuildMethodSettings,
  projectDev,
  projectExposes,
  projectMounts,
  projectVolumes,
  servers,
  sharedEnvGroups,
  sharedEnvGroupProjects,
  sharedEnvGroupTargets,
  sharedEnvGroupVars,
  teamFolderOrder,
  teamProjectOrder,
} from "../../schema/control-plane";
import type { CutSetCopy } from "../engine";
import type { BackfillTx } from "../types";
import {
  coerceBuildMethod,
  coerceDevStatus,
  coerceFramework,
  coerceImageKind,
  sanitizeTargets,
} from "../normalize";
import { seedIdentityRoots } from "../roots";

/**
 * Cut-set (c) — project graph (relational-store PLAN §3 "Cut-set (c)", Step 4).
 * The big one: `projects` (+ the 6 child tables) + `deployments` +
 * `deployment_logs` + `domains` (+ middlewares) + `envVars` (+ targets) +
 * `sharedEnvGroups` (+ vars/projects/targets junctions) + `folders` + the
 * `team_project_order`/`team_folder_order` ordering junctions, copied from the
 * fresh JSONB at the cut-set's switch moment.
 *
 * Backfill specifics (PLAN §7):
 *  - **Normalize BEFORE exploding.** Store rows are never rewritten today, so the
 *    live JSONB still carries raw legacy projects (legacy `dockerfile` source,
 *    missing `buildMethod`/`methodSettings`, mountless volumes, `nodeVersion`).
 *    {@link normalizeProject} (the read-time normalizer) runs on every project
 *    first so the NOT-NULL child columns hold; enum-ish values are then coerced
 *    (`coerceFramework`/`coerceBuildMethod`/`coerceDevStatus`/`coerceImageKind`),
 *    never rejected. (`migrate()` already stamped `sharedEnvGroups.teamId` etc. in
 *    `normalizeForBackfill`; this adds the per-project normalize on top.)
 *  - **Orphan prune (the live `deleteProject` bug).** `deleteProject` /
 *    `deleteProjects` never cascade project-target backups nor prune dead
 *    `sharedEnvGroups.projectIds`, so the JSONB carries dangling project ids that
 *    would FK-violate the copy and roll back the WHOLE transaction
 *    (un-migratable). The copy prunes dead `sharedEnvGroup.projectIds` to the live
 *    project set before inserting the junction. (Backup orphans are cut-set (d)'s
 *    concern; the live cascade is fixed in `deleteProject` this same PR.)
 *  - **Ordering junctions intersect the live set.** `teams.projectOrder` /
 *    `folderOrder` (the JSONB arrays) are intersected with the live same-team
 *    project/folder ids, assigning `position` over the survivors only — the
 *    stale-id self-healing becomes a DB invariant (the array can no longer carry a
 *    dead id at all).
 *  - **FK roots.** Identity roots (teams/users) are owned by cut-set (b), which
 *    ran first; seed them idempotently anyway (no-op over the existing rows). The
 *    `servers` table is owned by NO cut-set yet but `projects.server_id` RESTRICTs
 *    to it, so seed servers from the JSONB here.
 *  - **Reconcile is element-granular** (PLAN §7): row counts AFTER prune, summed
 *    child arrays, byte-equality of mount content, structural equality of volumes
 *    incl. the `type` discriminant, exhaustive method-settings coverage (via the
 *    `satisfies` guard in the row-assembler), and every FK resolves.
 */

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

/** A project normalized to the current model + coerced enum-ish values, ready to
 *  explode into the strict child tables. */
function normalizeForGraph(p: Project): Project {
  const np = normalizeProject(p);
  return {
    ...np,
    framework: coerceFramework(np.framework),
    build: {
      ...np.build,
      framework: coerceFramework(np.build.framework),
      buildMethod: coerceBuildMethod(
        np.build.buildMethod,
        coerceFramework(np.build.framework),
      ) as Project["build"]["buildMethod"],
    },
    dev: np.dev
      ? {
          ...np.dev,
          status: coerceDevStatus(np.dev.status) as Project["dev"] extends null
            ? never
            : NonNullable<Project["dev"]>["status"],
          imageKind: coerceImageKind(
            np.dev.imageKind,
          ) as NonNullable<Project["dev"]>["imageKind"],
        }
      : np.dev,
  };
}

async function copyProjectGraph(tx: BackfillTx, data: DeploData): Promise<void> {
  // FK roots first (PLAN §2 "roots first"). Identity (teams/users) was migrated
  // by cut-set (b); seed idempotently. `servers` is owned by no cut-set but
  // `projects.server_id` RESTRICTs to it, so seed it from the JSONB.
  await seedIdentityRoots(tx, data);
  await seedServers(tx, data);

  // The live id sets used for orphan pruning + order intersection.
  const liveProjectIds = new Set(data.projects.map((p) => p.id));
  const liveProjects = data.projects.map(normalizeForGraph);

  /* --- folders (before projects: projects.folder_id SET NULL references it, and
         the team_folder_order junction needs them) --- */
  if (data.folders.length > 0) {
    await tx.insert(folders).values(data.folders.map(folderToRow));
  }

  /* --- projects + their 6 child tables (FK-ordered) --- */
  if (liveProjects.length > 0) {
    await tx.insert(projects).values(liveProjects.map(projectToRow));
    await tx
      .insert(projectBuild)
      .values(liveProjects.map((p) => buildToRow(p.id, p.build)));

    const ms = liveProjects.map((p) =>
      methodSettingsToRow(p.id, p.build.methodSettings),
    );
    if (ms.length > 0) await tx.insert(projectBuildMethodSettings).values(ms);

    const devRows = liveProjects
      .filter((p) => p.dev)
      .map((p) => devToRow(p.id, p.dev!));
    if (devRows.length > 0) await tx.insert(projectDev).values(devRows);

    const exposeRows = liveProjects.flatMap((p) => exposesToRows(p.id, p.exposes));
    if (exposeRows.length > 0) await tx.insert(projectExposes).values(exposeRows);

    const volumeRows = liveProjects.flatMap((p) => volumesToRows(p.id, p.volumes));
    if (volumeRows.length > 0) await tx.insert(projectVolumes).values(volumeRows);

    const mountRows = liveProjects.flatMap((p) => mountsToRows(p.id, p.mounts));
    if (mountRows.length > 0) await tx.insert(projectMounts).values(mountRows);
  }

  /* --- deployments (after projects) --- */
  // Drop deployments whose project no longer exists (a leak the live cascade
  // does prune, but be defensive: a dangling deployment would FK-violate).
  const liveDeployments = data.deployments.filter((d) =>
    liveProjectIds.has(d.projectId),
  );
  if (liveDeployments.length > 0) {
    // Insert in source-array order so the DB-generated `seq` reproduces
    // insertion order (PLAN §5 "Backfill assigns seq in source-array order").
    await tx.insert(deployments).values(liveDeployments.map(deploymentToRow));
  }

  /* --- latest_deployment_id second pass (forward FK; set after deployments
         exist). Only point at a deployment that was actually inserted. --- */
  const liveDepIds = new Set(liveDeployments.map((d) => d.id));
  for (const p of liveProjects) {
    if (p.latestDeploymentId && liveDepIds.has(p.latestDeploymentId)) {
      await tx
        .update(projects)
        .set({ latestDeploymentId: p.latestDeploymentId })
        .where(eq(projects.id, p.id));
    }
  }

  /* --- deployment_logs (after deployments) --- */
  // logs: Record<deploymentId, LogLine[]>; one row per line, in array order so
  // the DB-generated `id` reproduces Array.push order. Drop logs for deployments
  // that don't exist relationally.
  const logRows = Object.entries(data.logs ?? {})
    .filter(([depId]) => liveDepIds.has(depId))
    .flatMap(([depId, lines]) => lines.map((line) => logLineToRow(depId, line)));
  if (logRows.length > 0) await tx.insert(deploymentLogs).values(logRows);

  /* --- env_vars + targets (after projects) --- */
  const liveEnvVars = data.envVars.filter((e) => liveProjectIds.has(e.projectId));
  if (liveEnvVars.length > 0) {
    await tx.insert(envVars).values(liveEnvVars.map(envVarToRow));
    const targetRows = liveEnvVars.flatMap((e) =>
      envVarTargetsToRows({ ...e, targets: sanitizeTargets(e.targets) }),
    );
    if (targetRows.length > 0) await tx.insert(envVarTargets).values(targetRows);
  }

  /* --- domains + middlewares (after projects) --- */
  const liveDomains = data.domains.filter((d) => liveProjectIds.has(d.projectId));
  if (liveDomains.length > 0) {
    await tx.insert(domains).values(liveDomains.map(domainToRow));
    const mwRows = liveDomains.flatMap(domainMiddlewaresToRows);
    if (mwRows.length > 0) await tx.insert(domainMiddlewares).values(mwRows);
  }

  /* --- shared env groups + 3 children (after projects: the project junction
         FKs projects) --- */
  const groups = data.sharedEnvGroups ?? [];
  if (groups.length > 0) {
    await tx.insert(sharedEnvGroups).values(groups.map(sharedEnvGroupToRow));

    const varRows = groups.flatMap(sharedEnvVarsToRows);
    if (varRows.length > 0) await tx.insert(sharedEnvGroupVars).values(varRows);

    // PRUNE dead project ids (the orphan the live deleteProject bug leaks) so the
    // junction FK resolves. Dedupe too (the junction PK is (group_id, project_id)).
    const projRows = groups.flatMap((g) => {
      const seen = new Set<string>();
      return g.projectIds
        .filter((pid) => liveProjectIds.has(pid) && !seen.has(pid) && seen.add(pid))
        .map((projectId) => ({ groupId: g.id, projectId }));
    });
    if (projRows.length > 0)
      await tx.insert(sharedEnvGroupProjects).values(projRows);

    const targetRows = groups.flatMap((g) =>
      sanitizeTargets(g.targets).map((target) => ({ groupId: g.id, target })),
    );
    if (targetRows.length > 0)
      await tx.insert(sharedEnvGroupTargets).values(targetRows);
  }

  /* --- ordering junctions (after projects/folders): intersect each team's
         ordered array with its live ids, position over survivors only --- */
  const projOrderRows: { teamId: string; projectId: string; position: number }[] = [];
  const folderOrderRows: { teamId: string; folderId: string; position: number }[] = [];
  for (const team of data.teams) {
    const teamProjectIds = new Set(
      liveProjects.filter((p) => p.teamId === team.id).map((p) => p.id),
    );
    const teamFolderIds = new Set(
      data.folders.filter((f) => f.teamId === team.id).map((f) => f.id),
    );
    const seenP = new Set<string>();
    (team.projectOrder ?? []).forEach((pid) => {
      if (teamProjectIds.has(pid) && !seenP.has(pid)) {
        seenP.add(pid);
        projOrderRows.push({ teamId: team.id, projectId: pid, position: seenP.size - 1 });
      }
    });
    const seenF = new Set<string>();
    (team.folderOrder ?? []).forEach((fid) => {
      if (teamFolderIds.has(fid) && !seenF.has(fid)) {
        seenF.add(fid);
        folderOrderRows.push({ teamId: team.id, folderId: fid, position: seenF.size - 1 });
      }
    });
  }
  if (projOrderRows.length > 0)
    await tx.insert(teamProjectOrder).values(projOrderRows);
  if (folderOrderRows.length > 0)
    await tx.insert(teamFolderOrder).values(folderOrderRows);

  await reconcileProjectGraph(tx, data);
}

/** Seed the `servers` rows a project's RESTRICT FK references, idempotently. */
async function seedServers(tx: BackfillTx, data: DeploData): Promise<void> {
  if (data.servers.length === 0) return;
  await tx
    .insert(servers)
    .values(
      data.servers.map((s) => ({
        id: s.id,
        name: s.name,
        host: s.host,
        type: s.type,
        status: s.status,
        ip: s.ip,
        dockerVersion: s.dockerVersion,
        traefikEnabled: s.traefikEnabled,
        cpuCores: s.cpuCores,
        memoryMb: s.memoryMb,
        diskGb: s.diskGb,
        cpuUsage: s.cpuUsage,
        memoryUsage: s.memoryUsage,
        diskUsage: s.diskUsage,
        agentPort: s.agent?.port ?? null,
        agentCertFingerprint: s.agent?.certFingerprint ?? null,
        agentCertPem: s.agent?.certPem ?? null,
        agentVersion: s.agent?.version ?? null,
        bootstrapTokenHash: s.bootstrap?.tokenHash ?? null,
        bootstrapExpiresAt: s.bootstrap?.expiresAt ?? null,
        bootstrapUsedAt: s.bootstrap?.usedAt ?? null,
        lastSeenAt: s.lastSeenAt ?? null,
        createdAt: s.createdAt,
      })),
    )
    .onConflictDoNothing();
}

/* ------------------------------------------------------------------ */
/* Reconcile (element-granular)                                         */
/* ------------------------------------------------------------------ */

async function rowCount(tx: BackfillTx, table: PgTable): Promise<number> {
  const r = await tx.select({ n: count() }).from(table);
  return r[0]?.n ?? 0;
}

function fail(msg: string): never {
  // A reconcile mismatch throws so the engine's tx rolls back, the marker is not
  // written, and the next boot re-runs the copy from the still-live JSONB.
  throw new Error(`[backfill:project-graph] reconcile mismatch: ${msg}`);
}

/**
 * Element-granular reconciliation of the project-graph cut-set against the source
 * `data` (PLAN §7). Counts are AFTER the orphan prune / order intersection, so
 * the expected values are computed over the SAME live sets the copy inserted.
 * Exported so a test can drive a mismatch the DB constraints alone wouldn't catch.
 */
export async function reconcileProjectGraph(
  tx: BackfillTx,
  data: DeploData,
): Promise<void> {
  const liveProjectIds = new Set(data.projects.map((p) => p.id));
  const liveProjects = data.projects.map(normalizeForGraph);

  /* (1) projects + 1-to-1 children (one build + method-settings per project). */
  const projectCount = await rowCount(tx, projects);
  if (projectCount !== liveProjects.length)
    fail(`projects ${projectCount} != ${liveProjects.length}`);
  const buildCount = await rowCount(tx, projectBuild);
  if (buildCount !== liveProjects.length)
    fail(`project_build ${buildCount} != ${liveProjects.length}`);
  const msCount = await rowCount(tx, projectBuildMethodSettings);
  if (msCount !== liveProjects.length)
    fail(`project_build_method_settings ${msCount} != ${liveProjects.length}`);

  /* (2) project_dev: one row per project that had dev enabled (tri-state — absent
        otherwise). */
  const expectedDev = liveProjects.filter((p) => p.dev).length;
  const devCount = await rowCount(tx, projectDev);
  if (devCount !== expectedDev)
    fail(`project_dev ${devCount} != ${expectedDev}`);

  /* (3) ordered child lists: total == Σ array length over the live projects. */
  const expectedExposes = liveProjects.reduce((n, p) => n + (p.exposes?.length ?? 0), 0);
  const exposeCount = await rowCount(tx, projectExposes);
  if (exposeCount !== expectedExposes)
    fail(`project_exposes ${exposeCount} != ${expectedExposes}`);
  const expectedVolumes = liveProjects.reduce((n, p) => n + (p.volumes?.length ?? 0), 0);
  const volumeCount = await rowCount(tx, projectVolumes);
  if (volumeCount !== expectedVolumes)
    fail(`project_volumes ${volumeCount} != ${expectedVolumes}`);
  const expectedMounts = liveProjects.reduce((n, p) => n + (p.mounts?.length ?? 0), 0);
  const mountCount = await rowCount(tx, projectMounts);
  if (mountCount !== expectedMounts)
    fail(`project_mounts ${mountCount} != ${expectedMounts}`);

  /* (4) mounts byte-equality + volume structural equality (incl. type). */
  for (const p of liveProjects) {
    if (p.mounts?.length) {
      const persisted = await tx
        .select()
        .from(projectMounts)
        .where(eq(projectMounts.projectId, p.id));
      const byPos = new Map(persisted.map((m) => [m.position, m]));
      p.mounts.forEach((m, i) => {
        const got = byPos.get(i);
        if (!got || got.filePath !== m.filePath || got.content !== m.content)
          fail(`project ${p.id} mount[${i}] not byte-equal`);
      });
    }
    if (p.volumes?.length) {
      const persisted = await tx
        .select()
        .from(projectVolumes)
        .where(eq(projectVolumes.projectId, p.id));
      const byPos = new Map(persisted.map((v) => [v.position, v]));
      p.volumes.forEach((v, i) => {
        const got = byPos.get(i);
        const wantType = v.type === "host" || v.type === "project" ? v.type : null;
        if (
          !got ||
          got.volumeId !== v.id ||
          got.type !== wantType ||
          got.name !== v.name ||
          got.mountPath !== v.mountPath ||
          Boolean(got.readOnly) !== Boolean(v.readOnly)
        )
          fail(`project ${p.id} volume[${i}] not structurally equal`);
      });
    }
  }

  /* (5) deployments (live only) + logs (Σ over live deployments). */
  const liveDeployments = data.deployments.filter((d) => liveProjectIds.has(d.projectId));
  const liveDepIds = new Set(liveDeployments.map((d) => d.id));
  const deploymentCount = await rowCount(tx, deployments);
  if (deploymentCount !== liveDeployments.length)
    fail(`deployments ${deploymentCount} != ${liveDeployments.length}`);
  const expectedLogs = Object.entries(data.logs ?? {})
    .filter(([depId]) => liveDepIds.has(depId))
    .reduce((n, [, lines]) => n + lines.length, 0);
  const logCount = await rowCount(tx, deploymentLogs);
  if (logCount !== expectedLogs)
    fail(`deployment_logs ${logCount} != ${expectedLogs}`);

  /* (6) env_vars (live) + targets (Σ sanitized). */
  const liveEnvVars = data.envVars.filter((e) => liveProjectIds.has(e.projectId));
  const envCount = await rowCount(tx, envVars);
  if (envCount !== liveEnvVars.length)
    fail(`env_vars ${envCount} != ${liveEnvVars.length}`);
  const expectedEnvTargets = liveEnvVars.reduce(
    (n, e) => n + sanitizeTargets(e.targets).length,
    0,
  );
  const envTargetCount = await rowCount(tx, envVarTargets);
  if (envTargetCount !== expectedEnvTargets)
    fail(`env_var_targets ${envTargetCount} != ${expectedEnvTargets}`);

  /* (7) domains (live) + middlewares (Σ). */
  const liveDomains = data.domains.filter((d) => liveProjectIds.has(d.projectId));
  const domainCount = await rowCount(tx, domains);
  if (domainCount !== liveDomains.length)
    fail(`domains ${domainCount} != ${liveDomains.length}`);
  const expectedMw = liveDomains.reduce((n, d) => n + (d.middlewares?.length ?? 0), 0);
  const mwCount = await rowCount(tx, domainMiddlewares);
  if (mwCount !== expectedMw)
    fail(`domain_middlewares ${mwCount} != ${expectedMw}`);

  /* (8) shared env groups + children (project ids PRUNED + deduped). */
  const groups = data.sharedEnvGroups ?? [];
  const groupCount = await rowCount(tx, sharedEnvGroups);
  if (groupCount !== groups.length)
    fail(`shared_env_groups ${groupCount} != ${groups.length}`);
  const expectedGroupVars = groups.reduce((n, g) => n + g.variables.length, 0);
  const groupVarCount = await rowCount(tx, sharedEnvGroupVars);
  if (groupVarCount !== expectedGroupVars)
    fail(`shared_env_group_vars ${groupVarCount} != ${expectedGroupVars}`);
  const expectedGroupProjects = groups.reduce((n, g) => {
    const live = new Set(g.projectIds.filter((pid) => liveProjectIds.has(pid)));
    return n + live.size;
  }, 0);
  const groupProjectCount = await rowCount(tx, sharedEnvGroupProjects);
  if (groupProjectCount !== expectedGroupProjects)
    fail(`shared_env_group_projects ${groupProjectCount} != ${expectedGroupProjects}`);
  const expectedGroupTargets = groups.reduce(
    (n, g) => n + sanitizeTargets(g.targets).length,
    0,
  );
  const groupTargetCount = await rowCount(tx, sharedEnvGroupTargets);
  if (groupTargetCount !== expectedGroupTargets)
    fail(`shared_env_group_targets ${groupTargetCount} != ${expectedGroupTargets}`);

  /* (9) folders + ordering junctions (intersected with live ids). */
  const folderCount = await rowCount(tx, folders);
  if (folderCount !== data.folders.length)
    fail(`folders ${folderCount} != ${data.folders.length}`);
  const expectedProjOrder = data.teams.reduce((n, team) => {
    const teamProjectIds = new Set(
      liveProjects.filter((p) => p.teamId === team.id).map((p) => p.id),
    );
    return n + new Set((team.projectOrder ?? []).filter((id) => teamProjectIds.has(id))).size;
  }, 0);
  const projOrderCount = await rowCount(tx, teamProjectOrder);
  if (projOrderCount !== expectedProjOrder)
    fail(`team_project_order ${projOrderCount} != ${expectedProjOrder}`);
  const expectedFolderOrder = data.teams.reduce((n, team) => {
    const teamFolderIds = new Set(
      data.folders.filter((f) => f.teamId === team.id).map((f) => f.id),
    );
    return n + new Set((team.folderOrder ?? []).filter((id) => teamFolderIds.has(id))).size;
  }, 0);
  const folderOrderCount = await rowCount(tx, teamFolderOrder);
  if (folderOrderCount !== expectedFolderOrder)
    fail(`team_folder_order ${folderOrderCount} != ${expectedFolderOrder}`);

  /* (10) every project FK resolves (server + team + folder, when set). */
  if (liveProjects.length > 0) {
    const serverIds = [...new Set(liveProjects.map((p) => p.serverId))];
    const presentServers = new Set(
      (
        await tx
          .select({ id: servers.id })
          .from(servers)
          .where(inArray(servers.id, serverIds))
      ).map((r) => r.id),
    );
    for (const p of liveProjects) {
      if (!presentServers.has(p.serverId))
        fail(`project ${p.id} references missing server ${p.serverId}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

/** The project-graph cut-set's copy, for {@link runBackfill}. */
export const projectGraphCutSetCopy: CutSetCopy = copyProjectGraph;
