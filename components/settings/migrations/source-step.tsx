"use client";

import * as React from "react";
import { ArrowUpFromLine, Truck, Users } from "lucide-react";

import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import { ChoiceCard } from "@/components/shared/choice-card";
import { MoveOutCard } from "@/components/deplo-move/move-out-card";
import type { SourceMoveStatus } from "@/lib/data/deplo-move/source";
import { SourceMark } from "./sources";
import { StepShell } from "./step-shell";

export type SourcePick = "panel" | "deplo-teams" | "deplo-move";

export interface MoveContext {
  // This Deplo leaving: its move code and progress.
  source: SourceMoveStatus | null;
  // A move into this Deplo that has already started.
  activeTargetId: string | null;
  readiness: { ready: boolean; reason: string | null };
  // Opened from an old "Move Deplo" link.
  openOutbound: boolean;
}

function DeploIcon({ className }: { className?: string }) {
  return <SourceMark kind="deplo" className={className} />;
}

function PanelIcons() {
  return (
    <span className="flex items-center gap-0.5">
      <SourceMark kind="dokploy" className="size-3" />
      <SourceMark kind="coolify" className="size-3" />
    </span>
  );
}

export function SourceStep({
  move,
  onPick,
}: {
  move: MoveContext;
  onPick: (pick: SourcePick) => void;
}) {
  const [view, setView] = React.useState<"sources" | "deplo" | "out">(() =>
    move.openOutbound || move.source ? "out" : "sources",
  );
  const incoming = move.activeTargetId !== null;
  const back = (
    <Button
      type="button"
      variant="outline"
      className="justify-self-start"
      onClick={() => setView("sources")}
    >
      Back
    </Button>
  );

  if (view === "out")
    return (
      <StepShell
        hero
        title="Move to another machine"
        lead="Apps keep running while a fresh Deplo on another machine takes over."
        docs="deplo.move"
      >
        <div className="grid gap-4">
          <MoveOutCard initial={move.source} incoming={incoming} />
          {back}
        </div>
      </StepShell>
    );

  if (view === "deplo")
    return (
      <StepShell
        hero
        title="What comes over?"
        lead="A whole Deplo, or only some of its teams."
      >
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <ChoiceCard
              icon={Truck}
              arrow
              title="Everything"
              blurb="Every team, person, app and server. Only into a fresh Deplo."
              disabled={!move.readiness.ready}
              disabledNote={move.readiness.reason ?? undefined}
              onSelect={() => onPick("deplo-move")}
            />
            <ChoiceCard
              icon={Users}
              arrow
              title="Only some teams"
              blurb="Each team you pick comes into a team here."
              onSelect={() => onPick("deplo-teams")}
            />
          </div>
          {back}
        </div>
      </StepShell>
    );

  return (
    <StepShell
      hero
      title="Where is it now?"
      lead="Bring it here from another Deplo, Dokploy or Coolify."
    >
      <div className="grid gap-4">
        {incoming && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3">
            <p className="text-sm">A move into this Deplo is under way.</p>
            <Button size="sm" asChild>
              <Link href={`/moving/${move.activeTargetId}`}>Show progress</Link>
            </Button>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <ChoiceCard
            icon={DeploIcon}
            arrow
            title="Another Deplo"
            blurb="All of it, or only some of its teams."
            disabled={incoming}
            onSelect={() => setView("deplo")}
          />
          <ChoiceCard
            icon={PanelIcons}
            arrow
            title="Dokploy or Coolify"
            blurb="Its projects, apps and databases, into teams here."
            disabled={incoming}
            onSelect={() => onPick("panel")}
          />
        </div>
        <button
          type="button"
          className="inline-flex items-center justify-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          onClick={() => setView("out")}
        >
          <ArrowUpFromLine className="size-4" />
          Moving this Deplo to another machine? Create a move code
        </button>
      </div>
    </StepShell>
  );
}
