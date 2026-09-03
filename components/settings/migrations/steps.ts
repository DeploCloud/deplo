import type { WizardStep } from "@/components/shared/wizard-stepper";

export type StepId =
  "choose" | "connect" | "install" | "review" | "people" | "takeover" | "done";

/** Whether the takeover brings the data across first, or deletes the old panel. */
export type TakeoverMode = "migrate" | "clean";

const STEP_LABEL: Record<StepId, string> = {
  choose: "Choose",
  connect: "Connect",
  install: "Install",
  review: "Review",
  people: "People",
  takeover: "Take over",
  done: "Done",
};

/**
 * The steps. `choose` and `takeover` exist only on the screen that is replacing
 * another panel; `people` only for an instance admin, because both of its actions
 * are instance-admin gated and the step would otherwise be a page of nothing.
 * A clean takeover skips the middle: there is nothing to read and nothing to place.
 */
export function stepsFor(
  canInvite: boolean,
  canTakeOver: boolean,
  mode: TakeoverMode | null = "migrate",
): WizardStep<StepId>[] {
  const middle: StepId[] = [
    "connect",
    "install",
    "review",
    ...(canInvite ? (["people"] as StepId[]) : []),
  ];
  const ids: StepId[] = !canTakeOver
    ? [...middle, "done"]
    : mode === "clean"
      ? ["choose", "takeover", "done"]
      : ["choose", ...middle, "takeover", "done"];
  return ids.map((id) => ({ id, label: STEP_LABEL[id] }));
}

/** Everything the rail needs to know about how far the wizard has actually got. */
export interface StepProgress {
  mode: TakeoverMode | null;
  /** The screen replacing another panel, which is the only one with the two ends. */
  isTakeover: boolean;
  /** A scan has landed, so there is something to place. */
  plan: boolean;
  /** Every source machine's agent answers - without it no byte can be read. */
  machinesReady: boolean;
  /** A run this tab holds, whether it started it or adopted it. */
  runId: string | null;
  /** The run finished and its report is on screen. */
  reportDone: boolean;
  /** Queued teams of the panel still to come. */
  teamsLeft: number;
  /** A run is moving, driven from here or watched from here. */
  inFlight: boolean;
  /** The old panel is off the machine. */
  takeoverDone: boolean;
}

/**
 * No step opens until the one before it is finished. One function, because the rail
 * and the wizard body have to agree: a gate only one of them honours is a
 * suggestion, and that is what let a person walk into a step with nothing in it.
 */
export function stepReachable(s: StepId, at: StepProgress): boolean {
  // A migration owns the screen while it moves, and the step it is on is Review.
  if (at.inFlight) return s === "review";
  switch (s) {
    // A decision already acted on is not re-openable.
    case "choose":
      return at.isTakeover && at.runId == null;
    case "connect":
      return at.mode !== "clean";
    case "install":
      return at.plan;
    case "review":
      return at.plan && at.machinesReady;
    case "people":
      return at.reportDone;
    // Taking the ports stops that panel for good, so a team still queued comes
    // first. A clean takeover has nothing to wait for.
    case "takeover":
      return at.mode === "clean" || (at.reportDone && at.teamsLeft === 0);
    case "done":
      return at.isTakeover ? at.takeoverDone : at.reportDone;
  }
}

/**
 * What the Review step is showing. The RUN wins over the plan: a tab holding a
 * run the live feed has not caught up with used to fall back to the plan, and
 * pressing Start again was refused as somebody else's migration.
 */
export function reviewShows(at: {
  /** The `startMigration` call is in flight in this tab. */
  running: boolean;
  /** A run this tab holds, started here or adopted - seen by the feed or not. */
  runId: string | null;
  /** The run could not be started. */
  failure: string | null;
  /** The run finished and its report is here. */
  report: boolean;
  /** A scan has landed. */
  plan: boolean;
}): "report" | "moving" | "plan" | null {
  if (at.report) return "report";
  if (at.running || at.failure !== null || at.runId != null) return "moving";
  return at.plan ? "plan" : null;
}
