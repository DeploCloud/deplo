import "server-only";

import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

import { and, eq, inArray, or } from "drizzle-orm";

import {
  acquireLease,
  AUTO_UPDATE_LEASE,
  releaseLease,
} from "../backups/lease";
import { getDb } from "../db/client";
import { backupRuns } from "../db/schema/control-plane/backups";
import { databases } from "../db/schema/control-plane/databases";
import { deploMoves } from "../db/schema/control-plane/deplo-move";
import { deployments } from "../db/schema/control-plane/deployments";
import { dockerCleanupRuns } from "../db/schema/control-plane/docker-cleanup";
import { migrationRuns } from "../db/schema/control-plane/migration";
import { autoUpdatePlan } from "../data/auto-updates";
import { instanceFrozen } from "../data/deplo-move/freeze";
import { schedulesPaused } from "../data/deplo-move/schedules";
import {
  logUpdateEvent,
  markAnnounced,
  settleUnfinishedUpdates,
  unannouncedAutomatic,
  type UpdateLogEntry,
} from "../data/update-log";
import { startDeploUpdate } from "../data/updates";
import { dispatchToTeams } from "../notify/dispatch";
import { allTeamIds } from "../notify/server-teams";
import { decideAutoUpdate, type AutoUpdateStep } from "./decide";
import { currentSlot } from "./window";

const TICK_MS = 5 * 60_000;
const FIRST_TICK_MS = 2 * 60_000;

interface SchedulerState {
  started: boolean;
  owner: string;
  ticking: boolean;
}

const STATE_KEY = Symbol.for("deplo.auto-updates.scheduler");
const g = globalThis as unknown as { [STATE_KEY]?: SchedulerState };
const state: SchedulerState = (g[STATE_KEY] ??= {
  started: false,
  owner: `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`,
  ticking: false,
});

/** Work a restart of Deplo would break, named for the log. Queued deploys survive a restart. */
export async function workInProgress(): Promise<string | null> {
  const db = getDb();
  const probes: [string, () => Promise<unknown[]>][] = [
    [
      "A deploy was running",
      () =>
        db
          .select({ id: deployments.id })
          .from(deployments)
          .where(eq(deployments.status, "building"))
          .limit(1),
    ],
    [
      "A backup was running",
      () =>
        db
          .select({ id: backupRuns.id })
          .from(backupRuns)
          .where(eq(backupRuns.status, "running"))
          .limit(1),
    ],
    [
      "A database was being restored",
      () =>
        db
          .select({ id: databases.id })
          .from(databases)
          .where(eq(databases.status, "restoring"))
          .limit(1),
    ],
    [
      "A server cleanup was running",
      () =>
        db
          .select({ id: dockerCleanupRuns.id })
          .from(dockerCleanupRuns)
          .where(eq(dockerCleanupRuns.status, "running"))
          .limit(1),
    ],
    [
      "A migration was running",
      () =>
        db
          .select({ id: migrationRuns.id })
          .from(migrationRuns)
          .where(eq(migrationRuns.status, "running"))
          .limit(1),
    ],
    [
      "A Deplo move was running",
      () =>
        db
          .select({ id: deploMoves.id })
          .from(deploMoves)
          .where(
            or(
              and(
                eq(deploMoves.side, "source"),
                inArray(deploMoves.state, ["bound", "copying"]),
              ),
              and(
                eq(deploMoves.side, "target"),
                inArray(deploMoves.state, [
                  "connected",
                  "copying",
                  "deploying",
                ]),
              ),
            ),
          )
          .limit(1),
    ],
  ];
  for (const [reason, probe] of probes)
    if ((await probe()).length > 0) return reason;
  return null;
}

function announcement(e: UpdateLogEntry) {
  const path = "/settings/deplo?tab=update-log";
  if (e.outcome === "updated")
    return {
      key: "deplo_auto_updated" as const,
      title: `Deplo updated itself to ${e.toVersion}`,
      body: `It was on ${e.fromVersion}.`,
      path,
    };
  if (e.outcome === "held")
    return {
      key: "deplo_auto_update_stopped" as const,
      title: `Deplo ${e.toVersion} has to be installed by hand`,
      body: e.reason ?? "Open the Updates tab to install it.",
      path: "/settings/deplo?tab=updates",
    };
  return {
    key: "deplo_auto_update_stopped" as const,
    title: `The automatic update to ${e.toVersion} did not take`,
    body: `${e.reason ?? "The new version did not start."} Deplo tries again the next night.`,
    path,
  };
}

export async function announceAutomaticUpdates(): Promise<void> {
  const pending = await unannouncedAutomatic();
  if (pending.length === 0) return;
  const teams = await allTeamIds();
  for (const e of pending) {
    if (teams.length > 0) await dispatchToTeams(teams, announcement(e));
    await markAnnounced(e.id);
  }
}

// https://deplo.build/docs/operations/update#automatic-updates
export async function runAutoUpdateTick(
  now: Date = new Date(),
): Promise<AutoUpdateStep | null> {
  if (await instanceFrozen()) return null;
  if (await schedulesPaused()) return null;
  if (state.ticking) return null;
  state.ticking = true;
  try {
    if (!(await acquireLease(AUTO_UPDATE_LEASE, state.owner, now))) return null;
    await settleUnfinishedUpdates(now.getTime());
    await announceAutomaticUpdates();

    const plan = await autoUpdatePlan();
    const { settings, info } = plan;
    const inSlot = currentSlot(now, settings.hour, plan.timezone) !== null;
    const step = decideAutoUpdate({
      now,
      hour: settings.hour,
      timezone: plan.timezone,
      active: settings.enabled && plan.blockedBy === null,
      postponedUntil: settings.postponedUntil,
      next: info.next,
      nextPublishedAt: info.nextPublishedAt,
      securityFix: info.securityFix !== null,
      manualUpdate: info.manualUpdate,
      log: plan.log,
      busy: inSlot ? await workInProgress() : null,
    });
    const at = now.toISOString();
    if (step.kind === "skip" || step.kind === "hold")
      await logUpdateEvent({
        outcome: step.kind === "skip" ? "skipped" : "held",
        to: step.version,
        trigger: "automatic",
        actor: null,
        reason: step.reason,
        at,
      });
    if (step.kind === "hold") await announceAutomaticUpdates();
    if (step.kind === "install")
      await startDeploUpdate({ trigger: "automatic", actor: null }).catch(
        async (e) => {
          console.error("[deplo] automatic update could not start:", e);
          await announceAutomaticUpdates();
        },
      );
    return step;
  } catch (e) {
    console.error("[deplo] automatic updates tick failed:", e);
    return null;
  } finally {
    state.ticking = false;
  }
}

export function startAutoUpdateScheduler(): void {
  if (state.started) return;
  state.started = true;
  const timer = setInterval(() => void runAutoUpdateTick(), TICK_MS);
  timer.unref?.();
  setTimeout(() => void runAutoUpdateTick(), FIRST_TICK_MS).unref?.();
}

export async function releaseAutoUpdateLease(): Promise<void> {
  await releaseLease(AUTO_UPDATE_LEASE, state.owner);
}
