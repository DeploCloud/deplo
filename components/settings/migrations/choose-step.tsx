"use client";

import * as React from "react";
import { ArrowRightLeft, Trash2 } from "lucide-react";

import { ChoiceCard } from "@/components/shared/choice-card";
import { StepShell } from "./step-shell";
import { copyFor, type SourceKind } from "./sources";
import type { TakeoverMode } from "./steps";

export function ChooseStep({
  kind,
  onPick,
}: {
  kind: SourceKind | null;
  onPick: (mode: TakeoverMode) => void;
}) {
  const panel = copyFor(kind).name;
  return (
    <StepShell
      stagger
      hero
      title="Welcome to Deplo."
      lead={`What happens to what ${panel} is running here?`}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <ChoiceCard
          icon={Trash2}
          arrow
          title="Start clean"
          blurb={`${panel} and everything on it is deleted for good.`}
          onSelect={() => onPick("clean")}
        />
        <ChoiceCard
          icon={ArrowRightLeft}
          arrow
          title="Bring your data over"
          blurb={`Your apps and databases move over, then ${panel} goes.`}
          onSelect={() => onPick("migrate")}
        />
      </div>
    </StepShell>
  );
}
