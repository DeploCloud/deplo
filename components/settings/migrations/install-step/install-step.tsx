"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { StepShell } from "../step-shell";
import type { SourceKind } from "../sources";
import type { PlanServer } from "../types";
import { MachineRow } from "./machine-row";
import type { PendingMachine } from "./machine-state";
import { useMachineInstall } from "./use-machine-install";

// How long the finished step sits there before it moves on by itself.
const SETTLE_MS = 2000;

export function InstallStep({
  kind,
  sourceUrl,
  machines,
  canAddServers,
  pending,
  setPending,
  attempted,
  onResolved,
  onDone,
  onBack,
}: {
  kind: SourceKind | null;
  // The panel this imports from - the key a corrected address is filed under.
  sourceUrl: string;
  machines: PlanServer[];
  // Registering a host is instance-admin only, like everywhere else.
  canAddServers: boolean;
  pending: Record<string, PendingMachine>;
  setPending: React.Dispatch<
    React.SetStateAction<Record<string, PendingMachine>>
  >;
  // Which machines have a registration IN FLIGHT, so a re-render never starts a
  // second one.
  attempted: React.RefObject<Set<string>>;
  onResolved: (
    sourceId: string,
    serverId: string,
    serverName: string,
    address?: string,
  ) => void;
  onDone: () => void;
  onBack?: () => void;
}) {
  const install = useMachineInstall({
    kind,
    sourceUrl,
    machines,
    canAddServers,
    pending,
    setPending,
    attempted,
    onResolved,
  });
  const { settled } = install;

  // Only when it BECOMES settled here: a person who came back to this step must
  // not be thrown forward again.
  const settledOnMount = React.useRef(settled);
  React.useEffect(() => {
    if (!settled || settledOnMount.current) return;
    const t = setTimeout(onDone, SETTLE_MS);
    return () => clearTimeout(t);
  }, [settled, onDone]);

  return (
    <StepShell
      hero
      title={
        settled ? "Every machine is connected" : "Run one line on each machine"
      }
      lead={
        settled
          ? "Deplo can read the disks it needs."
          : "Sign in to each machine as root and paste its line. Deplo needs its agent there to read your data, and takes it back off when the migration is done."
      }
    >
      <div className="divide-y divide-border/60 rounded-lg border border-border bg-background">
        {machines.map((m) => (
          <MachineRow
            key={m.sourceId || "own"}
            m={m}
            canAddServers={canAddServers}
            install={install}
          />
        ))}
      </div>

      {/* A step that was settled when it opened does not move on by itself, so it
          says how: a second migration from the same panel used to end here. */}
      {settled && (
        <div className={cn("flex", onBack ? "justify-between" : "justify-end")}>
          {onBack && (
            <Button variant="outline" onClick={onBack}>
              Back
            </Button>
          )}
          <Button onClick={onDone}>Continue</Button>
        </div>
      )}
    </StepShell>
  );
}
