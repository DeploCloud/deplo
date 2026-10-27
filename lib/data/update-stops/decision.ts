import "server-only";

import {
  DEPLO_VERSION,
  REQUIRED_STOP,
  UPDATE_STOP,
  isNewer,
} from "../../version";
import { instanceFrozen } from "../deplo-move/freeze";
import { thisStopsCondition, type StopCondition } from "./condition";
import { readReleaseDeclaration } from "./declaration";
import { passedStops, recordPassedStop, stopPassed } from "./passed";

/** The update stop between this instance and the newest release, when it has not passed it. */
export interface UpdateStopInfo {
  version: string;
  reason: string;
  // This instance runs the stop and its conditions do not hold yet: Update offers nothing.
  waiting: boolean;
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

const MAX_HOPS = 8;

const tag = (v: string) => `v${v.replace(/^v/i, "")}`;

/** Records this release as passed the first time its condition holds, once; the record is never cleared. */
export async function passThisStopIfMet(): Promise<string[]> {
  const passed = await passedStops();
  const r = thisRelease;
  if (!r.updateStop || stopPassed(r.version, passed)) return passed;
  if (!(await r.condition()).met || (await instanceFrozen())) return passed;
  await recordPassedStop(r.version);
  return [...passed, r.version];
}

/** What Update installs on the way to `newest`: the newest itself, or the oldest stop it has to come after. */
export async function decideUpdate(
  newest: string,
  passed: readonly string[],
  published: (version: string) => Promise<boolean | { error: string }>,
  init?: RequestInit,
): Promise<UpdateRoute> {
  const goal = tag(newest);
  let target = newest.replace(/^v/i, "");
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const declared = await readReleaseDeclaration(target, init);
    if (!declared)
      return {
        next: null,
        stop: null,
        error: `Couldn't check what Deplo ${tag(target)} needs before it installs.`,
      };
    const stop = declared.requiresStop;
    if (!stop || stopPassed(stop, passed)) {
      if (tag(target) === goal) return { next: goal, stop: null };
      return {
        next: tag(target),
        stop: {
          version: tag(target),
          waiting: false,
          reason: `Deplo ${goal} has to come after ${tag(target)}, so Update installs ${tag(target)} first.`,
        },
      };
    }
    if (!isNewer(target, stop)) break;
    if (!isNewer(stop, thisRelease.version)) {
      if (thisRelease.updateStop)
        return {
          next: null,
          stop: {
            version: tag(thisRelease.version),
            waiting: true,
            reason: `Deplo ${goal} becomes available once ${tag(thisRelease.version)} has finished getting this instance ready.`,
          },
        };
      return {
        next: null,
        stop: {
          version: tag(stop),
          waiting: false,
          reason: `Deplo ${goal} has to come after ${tag(stop)}, which this instance skipped.`,
        },
      };
    }
    const there = await published(stop);
    if (there !== true)
      return {
        next: null,
        stop: null,
        error:
          there === false
            ? `Deplo ${goal} has to come after ${tag(stop)}, which is not published.`
            : there.error,
      };
    target = stop;
  }
  return {
    next: null,
    stop: null,
    error: `Deplo ${goal} names an update path Deplo cannot follow.`,
  };
}
