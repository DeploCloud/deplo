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
  showPeople: boolean,
  canTakeOver: boolean,
  mode: TakeoverMode | null = "migrate",
): WizardStep<StepId>[] {
  const middle: StepId[] = [
    "connect",
    "install",
    "review",
    ...(showPeople ? (["people"] as StepId[]) : []),
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
  showPeople: boolean;
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
      return at.reportDone && at.showPeople;
    case "takeover":
      return at.mode === "clean" || (at.reportDone && at.teamsLeft === 0);
    case "done":
      return at.isTakeover ? at.takeoverDone : at.reportDone;
  }
}

export function stepAfterReport(
  showPeople: boolean,
  isTakeover: boolean,
): StepId {
  return showPeople ? "people" : isTakeover ? "takeover" : "done";
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

export interface ReportCounts {
  created: number;
  skipped: number;
  failed: number;
  manual: number;
  blocking: number;
}

// "Needs you" is only what keeps an app from running; `manual` is information.
export function reportBadges(r: ReportCounts): {
  key: string;
  label: string;
  variant: "warning" | "destructive" | "success" | "secondary" | "outline";
}[] {
  return [
    r.blocking > 0 && {
      key: "blocking",
      label: needsYou(r.blocking),
      variant: "warning" as const,
    },
    r.failed > 0 && {
      key: "failed",
      label: `${r.failed} failed`,
      variant: "destructive" as const,
    },
    {
      key: "created",
      label: `${r.created} created`,
      variant: "success" as const,
    },
    r.skipped > 0 && {
      key: "skipped",
      label: `${r.skipped} already here`,
      variant: "secondary" as const,
    },
    r.manual > 0 && {
      key: "manual",
      label: `${r.manual} note${r.manual === 1 ? "" : "s"}`,
      variant: "outline" as const,
    },
  ].filter((b) => b !== false);
}

export const REPORT_LEVELS = [
  "blocking",
  "failed",
  "created",
  "skipped",
  "unsupported",
  "manual",
] as const;
export type ReportLevel = (typeof REPORT_LEVELS)[number];

// A note that blocks an app is grouped on its own, whatever outcome it was written with.
export function reportLevel(item: {
  outcome: string;
  blocking?: boolean;
}): ReportLevel {
  const note = item.outcome === "manual" || item.outcome === "unsupported";
  if (note && item.blocking) return "blocking";
  return (REPORT_LEVELS as readonly string[]).includes(item.outcome)
    ? (item.outcome as ReportLevel)
    : "manual";
}
