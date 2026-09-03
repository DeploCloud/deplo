"use client";

import * as React from "react";
import { ArrowRightLeft, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ChoiceCard } from "@/components/shared/choice-card";
import { StepShell } from "./step-shell";
import { copyFor, type SourceKind } from "./sources";
import type { TakeoverMode } from "./steps";

/**
 * The first decision of a takeover, and the only one that cannot be undone later:
 * whether the machine keeps what is on it. Picking the second card selects it and
 * nothing more - the typed confirmation lives on the last step.
 */
export function ChooseStep({
  kind,
  mode,
  onSelect,
  onContinue,
}: {
  /** The panel being replaced. Named on both cards, so it is never abstract. */
  kind: SourceKind | null;
  mode: TakeoverMode | null;
  onSelect: (mode: TakeoverMode) => void;
  onContinue: () => void;
}) {
  const panel = copyFor(kind).name;
  return (
    <StepShell
      stagger
      title={`Deplo is replacing ${panel} on this machine`}
      lead={`What happens to what ${panel} is running here?`}
    >
      <div className="grid gap-3" role="radiogroup">
        <ChoiceCard
          icon={ArrowRightLeft}
          title="Bring your data over"
          blurb={`Your apps, databases and their data move to Deplo. ${panel} comes off the machine once they are here.`}
          selected={mode === "migrate"}
          onSelect={() => onSelect("migrate")}
        />
        <ChoiceCard
          icon={Trash2}
          title="Start clean"
          blurb={`${panel} and everything on it is deleted: apps, data, teams. Nothing can be brought back.`}
          selected={mode === "clean"}
          onSelect={() => onSelect("clean")}
        />
      </div>

      <div className="flex justify-end">
        <Button onClick={onContinue} disabled={mode == null}>
          Continue
        </Button>
      </div>
    </StepShell>
  );
}
