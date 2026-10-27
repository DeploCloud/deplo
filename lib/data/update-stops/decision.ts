import "server-only";

import {
  bareVersion,
  DEPLO_VERSION,
  REQUIRED_STOP,
  UPDATE_STOP,
  isNewer,
  versionTag,
} from "../../version";
import { instanceFrozen } from "../deplo-move/freeze";
import {
  thisStopsCondition,
  type StopCondition,
  type StopServer,
} from "./condition";
import { readReleaseDeclaration } from "./declaration";
import { passedStops, recordPassedStop, stopPassed } from "./passed";

/** The update stop between this instance and the newest release, when it has not passed it. */
export interface UpdateStopInfo {
  version: string;
  reason: string;
  // This instance runs the stop and its conditions do not hold yet: Update offers nothing.
  waiting: boolean;
  // While waiting: who the condition still waits on, and who an instance admin left behind.
  waitingOn: StopServer[];
  leftBehind: StopServer[];
}

export interface UpdateRoute {
  next: string | null;
  stop: UpdateStopInfo | null;
  error?: string;
}

interface ThisRelease {
  version: string;
  updateStop: boolean;
  requiresStop: string | null;
  condition: () => Promise<StopCondition>;
}

const THIS_RELEASE: ThisRelease = {
  version: DEPLO_VERSION,
  updateStop: UPDATE_STOP,
  requiresStop: REQUIRED_STOP,
  condition: thisStopsCondition,
};

let thisRelease = THIS_RELEASE;

export function __setThisReleaseForTest(over: Partial<ThisRelease>): void {
  thisRelease = { ...THIS_RELEASE, ...over };
}

export function __resetThisReleaseForTest(): void {
  thisRelease = THIS_RELEASE;
}

// KEEP IN SYNC with the literal 8 in install.sh's `route_through_stops`.
const MAX_HOPS = 8;
const NO_SERVERS = { waitingOn: [], leftBehind: [] };

const failed = (error: string): UpdateRoute => ({
  next: null,
  stop: null,
  error,
});

/** Records this release as passed the first time its condition holds, once; the record is never cleared. */
export async function passThisStopIfMet(): Promise<string[]> {
  const passed = await passedStops();
  const r = thisRelease;
  if (!r.updateStop || stopPassed(r.version, passed)) return passed;
  if (!(await r.condition()).met || (await instanceFrozen())) return passed;
  await recordPassedStop(r.version);
  return [...passed, r.version];
}

/** For a trigger (a first link, a removal, a server left behind): never throws, and the next update check retries. */
export async function tryPassThisStop(): Promise<void> {
  await passThisStopIfMet().catch((e) =>
    console.error("[deplo] could not record the update stop:", e),
  );
}

/** This release while it is an update stop not passed yet, and whom it waits on, before any release requires it too. */
export async function thisStopWaiting(
  passed: readonly string[],
  goal?: string,
): Promise<UpdateStopInfo | null> {
  const r = thisRelease;
  if (!r.updateStop || stopPassed(r.version, passed)) return null;
  const { waitingOn, leftBehind } = await r.condition();
  const here = versionTag(r.version);
  return {
    version: here,
    waiting: true,
    waitingOn,
    leftBehind,
    // KEEP IN SYNC with the "becomes available" warning in install.sh's `route_through_stops`.
    reason: goal
      ? `Deplo ${goal} becomes available once ${here} has finished getting ready.`
      : "The next update waits until every server has connected to Deplo.",
  };
}

/** What Update installs on the way to `newest`: the newest itself, or the oldest stop it has to come after. */
export async function decideUpdate(
  newest: string,
  passed: readonly string[],
  published: (version: string) => Promise<boolean | { error: string }>,
  init?: RequestInit,
): Promise<UpdateRoute> {
  const goal = versionTag(newest);
  // A release named as a stop that does not declare itself one could never record a pass.
  const notAStop = (stop: string) =>
    failed(
      `Deplo ${goal} has to come after ${versionTag(stop)}, which can't get Deplo ready for it.`,
    );
  let target = bareVersion(newest);
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const declared = await readReleaseDeclaration(target, init);
    if (!declared)
      return failed(
        `Couldn't check what Deplo ${versionTag(target)} needs before it installs.`,
      );
    if (hop > 0 && !declared.updateStop) return notAStop(target);
    const stop = declared.requiresStop;
    if (!stop || stopPassed(stop, passed)) {
      if (versionTag(target) === goal) return { next: goal, stop: null };
      return {
        next: versionTag(target),
        stop: {
          version: versionTag(target),
          waiting: false,
          ...NO_SERVERS,
          // KEEP IN SYNC with the routed warning in install.sh's `route_through_stops`.
          reason: `Deplo ${goal} has to come after ${versionTag(target)}, so Update installs ${versionTag(target)} first.`,
        },
      };
    }
    if (!isNewer(target, stop)) break;
    if (!isNewer(stop, thisRelease.version)) {
      if (thisRelease.updateStop)
        return { next: null, stop: await thisStopWaiting(passed, goal) };
      if (!isNewer(thisRelease.version, stop)) return notAStop(stop);
      return {
        next: null,
        stop: {
          version: versionTag(stop),
          waiting: false,
          ...NO_SERVERS,
          // KEEP IN SYNC with the "skipped" warning in install.sh's `route_through_stops`.
          reason: `Deplo ${goal} has to come after ${versionTag(stop)}, which this instance skipped.`,
        },
      };
    }
    const there = await published(stop);
    if (there !== true)
      return failed(
        there === false
          ? `Deplo ${goal} has to come after ${versionTag(stop)}, which is not published.`
          : there.error,
      );
    target = stop;
  }
  return failed(`Deplo ${goal} names an update path Deplo cannot follow.`);
}
