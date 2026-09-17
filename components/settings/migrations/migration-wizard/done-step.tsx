"use client";

import * as React from "react";
import { Logs, Repeat } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfettiBurst } from "@/components/shared/confetti-burst";
import { MigrationGraphic } from "../migration-graphic";
import { RemoveMigrationSources } from "../remove-sources";
import { StepShell } from "../step-shell";
import type { SourceKind } from "../sources";
import { ReportBody } from "./report-card";
import type { RunReport } from "./session";

const REDIRECT_MS = 3000;

export function DoneStep({
  kind,
  panelUrl,
  report,
  teams,
  uncovered,
  onAddTeam,
  isInstanceAdmin,
  sourcesTeamId,
  onShowLog,
  onAgain,
  onFinish,
}: Omit<React.ComponentProps<typeof ReportBody>, "report"> & {
  kind: SourceKind | null;
  panelUrl: string | null;
  report: RunReport | null;
  isInstanceAdmin: boolean;
  sourcesTeamId: string;
  onShowLog: (() => void) | null;
  onAgain: (() => void) | null;
  onFinish: () => void;
}) {
  React.useEffect(() => {
    if (!panelUrl) return;
    const t = setTimeout(onFinish, REDIRECT_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelUrl]);

  return (
    <div className="mx-auto flex w-full flex-col items-center gap-8">
      <ConfettiBurst rain className="z-50" count={60} />

      <MigrationGraphic
        state="done"
        kind={kind}
        className="h-auto w-full max-w-md"
      />

      <div className="w-full max-w-xl min-w-0">
        <StepShell
          hero
          title={panelUrl ? "This machine is Deplo's" : "You're on Deplo"}
          lead={
            panelUrl
              ? `Opening ${panelUrl}`
              : "Nothing is deployed yet. Open an app, check it over, and press Deploy when you want the traffic."
          }
        >
          {report && (
            <ReportBody
              report={report}
              teams={teams}
              uncovered={uncovered}
              onAddTeam={onAddTeam}
            />
          )}
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {onShowLog && (
                <Button variant="outline" onClick={onShowLog}>
                  <Logs className="size-4" />
                  Show log
                </Button>
              )}
              {onAgain && (
                <Button variant="outline" onClick={onAgain}>
                  <Repeat className="size-4" />
                  Migrate another
                </Button>
              )}
            </div>
            <Button onClick={onFinish}>
              {panelUrl ? "Open Deplo" : "Finish"}
            </Button>
          </div>

          {report && isInstanceAdmin && (
            <RemoveMigrationSources teamId={sourcesTeamId} />
          )}
        </StepShell>
      </div>
    </div>
  );
}
