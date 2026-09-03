import type { WizardStep } from "@/components/shared/wizard-stepper";

export type StepId =
  "connect" | "install" | "review" | "people" | "done" | "takeover";

const STEP_LABEL: Record<StepId, string> = {
  connect: "Connect",
  install: "Install",
  review: "Review",
  people: "People",
  done: "Done",
  takeover: "Take over",
};

/**
 * The steps, and there is no longer a separate one for the data. `people` only for
 * an instance admin, because both of its actions are instance-admin gated and the
 * step would otherwise be a page of nothing. `takeover` only on the screen that is
 * replacing another panel, where taking the ports is the last thing left to do.
 */
export function stepsFor(
  canInvite: boolean,
  canTakeOver: boolean,
): WizardStep<StepId>[] {
  const ids: StepId[] = [
    "connect",
    "install",
    "review",
    ...(canInvite ? (["people"] as StepId[]) : []),
    "done",
    ...(canTakeOver ? (["takeover"] as StepId[]) : []),
  ];
  return ids.map((id) => ({ id, label: STEP_LABEL[id] }));
}
