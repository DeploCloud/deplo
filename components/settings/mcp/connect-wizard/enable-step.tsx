"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StepShell } from "./step-shell";

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
      lead="Members can then connect their own agents. Each one does only what its token allows."
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
