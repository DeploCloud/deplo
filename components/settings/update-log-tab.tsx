import { ArrowRight, History, Loader2 } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { InfoTip } from "@/components/ui/info-tip";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusDot } from "@/components/shared/status-badge";
import { timeAgo } from "@/lib/utils";
import type { UpdateLogEntry } from "@/lib/data/update-log";

const OUTCOME: Record<
  UpdateLogEntry["outcome"],
  {
    label: string;
    dot: "success" | "unhealthy" | "failed" | "building" | "idle";
  }
> = {
  running: { label: "Updating", dot: "building" },
  updated: { label: "Updated", dot: "success" },
  rolled_back: { label: "Rolled back", dot: "unhealthy" },
  failed: { label: "Failed", dot: "failed" },
  skipped: { label: "Skipped", dot: "idle" },
  postponed: { label: "Postponed", dot: "idle" },
  held: { label: "Needs you", dot: "unhealthy" },
};

export function updateLogActor(e: UpdateLogEntry): string {
  if (e.actor) return e.actor;
  if (e.trigger === "automatic") return "Automatic";
  if (e.trigger === "host") return "Installer";
  return "Update button";
}

export function UpdateLogTab({ entries }: { entries: UpdateLogEntry[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          <History className="size-4" />
          Update log
          <InfoTip
            content="Every update of Deplo in the last 90 days, from the Update button, the automatic updates or the installer."
            docs="upgrade.log"
          />
        </CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <EmptyState
            icon={History}
            title="No updates yet"
            docs="upgrade.log"
            description="Each update of Deplo shows up here, with who started it and how it went."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell
                      className="whitespace-nowrap text-muted-foreground"
                      title={e.at}
                    >
                      {timeAgo(e.at)}
                    </TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        {e.fromVersion}
                        <ArrowRight className="size-3 text-muted-foreground" />
                        {e.toVersion}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {updateLogActor(e)}
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-1.5 text-xs whitespace-nowrap">
                        {e.outcome === "running" ? (
                          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                        ) : (
                          <StatusDot status={OUTCOME[e.outcome].dot} />
                        )}
                        {OUTCOME[e.outcome].label}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-sm">
                      {e.reason ? (
                        <span
                          className="block truncate text-xs text-muted-foreground"
                          title={e.reason}
                        >
                          {e.reason}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
