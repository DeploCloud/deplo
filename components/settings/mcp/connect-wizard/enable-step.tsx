"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StepShell } from "./step-shell";

// EnableStep flips the team's MCP switch, the one step a plain member cannot act on.
export function EnableStep({
  canManageTeam,
  pending,
  onTurnOn,
}: {
  canManageTeam: boolean;
  pending: boolean;
  onTurnOn: () => void;
}) {
  return (
    <StepShell
      title="The MCP Server is off for this team"
      lead="Turning it on lets members connect their own agents here. What an agent may actually do is its token's permissions, and nothing else."
      action={
        canManageTeam ? (
          <Button onClick={onTurnOn} disabled={pending}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            Turn on MCP for this team
          </Button>
        ) : null
      }
    >
      {!canManageTeam && (
        <p className="text-sm text-muted-foreground">
          A team admin has to switch it on before an agent can connect.
        </p>
      )}
    </StepShell>
  );
}
