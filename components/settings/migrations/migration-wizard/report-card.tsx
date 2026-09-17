"use client";

import * as React from "react";
import { Logs, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TeamAvatar } from "@/components/shared/user-avatar";
import { RemoveMigrationSources } from "../remove-sources";
import { StepShell } from "../step-shell";
import { needsYou } from "../steps";
import type { RunReport } from "./session";

export function ReportBody({
  report,
  teams = null,
  uncovered,
  onAddTeam,
}: {
  report: RunReport;
  teams?:
    { name: string; avatarUrl: string | null; report: RunReport }[] | null;
  uncovered: string[];
  onAddTeam: () => void;
}) {
  return (
    <>
      <div className="flex flex-wrap justify-center gap-1.5">
        <Badge variant="success">{report.created} created</Badge>
        {report.skipped > 0 && (
          <Badge variant="secondary">{report.skipped} already here</Badge>
        )}
        {report.manual > 0 && (
          <Badge variant="warning">{needsYou(report.manual)}</Badge>
        )}
        {report.failed > 0 && (
          <Badge variant="destructive">{report.failed} failed</Badge>
        )}
      </div>
      {teams && teams.length > 1 && (
        <ul className="divide-y divide-border rounded-lg border border-border bg-background">
          {teams.map((t) => (
            <li
              key={t.name}
              className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
            >
              <TeamAvatar name={t.name} avatarUrl={t.avatarUrl} size="sm" />
              <span className="min-w-0 flex-1 truncate font-medium">
                {t.name}
              </span>
              <span className="text-muted-foreground">
                {t.report.created} created
                {t.report.manual > 0 ? `, ${needsYou(t.report.manual)}` : ""}
                {t.report.failed > 0 ? `, ${t.report.failed} failed` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      {uncovered.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-wash-strong px-3 py-2 text-sm leading-relaxed">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <p className="min-w-0 flex-1 text-muted-foreground">
            Still on that panel: {uncovered.join(", ")}.
          </p>
          <Button variant="secondary" size="sm" onClick={onAddTeam}>
            Bring it over
          </Button>
        </div>
      )}
    </>
  );
}

export function ReportCard({
  report,
  teams,
  uncovered,
  onAddTeam,
  onShowLog,
  onContinue,
  isInstanceAdmin,
  sourcesTeamId,
}: React.ComponentProps<typeof ReportBody> & {
  onShowLog: () => void;
  onContinue: () => void;
  isInstanceAdmin: boolean;
  sourcesTeamId: string;
}) {
  return (
    <StepShell
      hero
      title="Your projects are on Deplo"
      lead="Nothing is deployed yet. Open an app, check it over, and press Deploy when you want the traffic."
    >
      <ReportBody
        report={report}
        teams={teams}
        uncovered={uncovered}
        onAddTeam={onAddTeam}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" onClick={onShowLog}>
          <Logs className="size-4" />
          Show log
        </Button>
        <Button onClick={onContinue}>Continue</Button>
      </div>

      {isInstanceAdmin && <RemoveMigrationSources teamId={sourcesTeamId} />}
    </StepShell>
  );
}
