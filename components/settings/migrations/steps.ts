import type { WizardStep } from "@/components/shared/wizard-stepper";

export type StepId =
  "choose" | "connect" | "install" | "review" | "people" | "takeover" | "done";

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
      ? ["takeover", "done"]
      : [...middle, "takeover", "done"];
  return ids.map((id) => ({ id, label: STEP_LABEL[id] }));
}

export interface StepProgress {
  mode: TakeoverMode | null;
  isTakeover: boolean;
  plan: boolean;
  machinesReady: boolean;
  runId: string | null;
  reportDone: boolean;
  teamsLeft: number;
  inFlight: boolean;
  takeoverDone: boolean;
}

export function stepReachable(s: StepId, at: StepProgress): boolean {
  if (at.inFlight) return s === "review";
  switch (s) {
    case "choose":
      return at.isTakeover && at.runId == null;
    case "connect":
      return at.mode !== "clean";
    case "install":
      return at.plan;
    case "review":
      return at.plan && at.machinesReady && (at.isTakeover || !at.reportDone);
    case "people":
      return at.reportDone;
    case "takeover":
      return at.mode === "clean" || (at.reportDone && at.teamsLeft === 0);
    case "done":
      return at.isTakeover ? at.takeoverDone : at.reportDone;
  }
}

export function reviewShows(at: {
  running: boolean;
  runId: string | null;
  failure: string | null;
  report: boolean;
  plan: boolean;
}): "report" | "moving" | "plan" | null {
  if (at.report) return "report";
  if (at.running || at.failure !== null || at.runId != null) return "moving";
  return at.plan ? "plan" : null;
}

export function needsYou(n: number): string {
  return `${n} need${n === 1 ? "s" : ""} you`;
}
