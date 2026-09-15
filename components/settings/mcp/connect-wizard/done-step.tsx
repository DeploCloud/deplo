"use client";

import Link from "@/components/ui/link";
import { Check, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfettiBurst } from "@/components/shared/confetti-burst";
import { RobotGraphic } from "../robot-graphic";
import type { AgentDef } from "../agents";

export function DoneStep({
  agent,
  connected,
  onRestart,
}: {
  agent: AgentDef;
  connected: boolean;
  onRestart: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-6 text-center">
      {connected && <ConfettiBurst rain className="z-50" count={60} />}

      <RobotGraphic
        state={connected ? "connected" : "reaching"}
        accent={agent.veil}
        className="h-48 w-auto"
      />

      <div>
        <h2 className="text-xl font-semibold">
          {connected ? "Connected successfully!" : `${agent.label} is set up`}
        </h2>
        <p className="mt-1 text-sm text-balance text-muted-foreground">
          {connected
            ? "It made its first call to Deplo. Change or revoke its access at any time under Settings → API tokens."
            : `Deplo has not heard from ${agent.label} yet. It appears here as soon as it makes its first call.`}
        </p>
      </div>

      <div className="flex w-full flex-wrap items-center justify-end gap-3">
        <Button asChild variant="outline" className="mr-auto">
          <Link href="/settings/tokens">
            <KeyRound className="size-4" />
            API tokens
          </Link>
        </Button>
        <Button onClick={onRestart}>
          <Check className="size-4" />
          Done
        </Button>
      </div>
    </div>
  );
}
