"use client";

import * as React from "react";
import { LifeBuoy } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { CopyButton } from "@/components/shared/copy-button";

/** One host, as a bug report needs to see it. */
export interface DiagnosticHost {
  name: string;
  agentVersion: string | null;
  dockerVersion: string;
  hostArch: string;
}

function pad(value: string, width: number): string {
  return value.length >= width
    ? value
    : value + " ".repeat(width - value.length);
}

/**
 * Everything an issue about this instance has to state, in one block nobody has
 * to go and collect from four screens.
 */
export function DeploDiagnosticsCard({
  version,
  panelUrl,
  panelUrlSource,
  deploHostName,
  expectedAgentVersion,
  hosts,
}: {
  version: string;
  panelUrl: string;
  panelUrlSource: string;
  deploHostName: string | null;
  expectedAgentVersion: string;
  hosts: DiagnosticHost[];
}) {
  const report = React.useMemo(() => {
    const width = Math.max(4, ...hosts.map((h) => h.name.length));
    const lines = [
      `deplo          ${version}`,
      `panel          ${panelUrl} (${panelUrlSource})`,
      `deplo host     ${deploHostName ?? "not added as a server"}`,
      `expected agent ${expectedAgentVersion}`,
      "",
      `servers        ${hosts.length}`,
      ...hosts.map(
        (h) =>
          `  ${pad(h.name, width)}  agent ${h.agentVersion ?? "-"}  docker ${
            h.dockerVersion || "-"
          }  ${h.hostArch || "arch unknown"}`,
      ),
    ];
    return lines.join("\n");
  }, [
    version,
    panelUrl,
    panelUrlSource,
    deploHostName,
    expectedAgentVersion,
    hosts,
  ]);

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          <LifeBuoy className="size-4" />
          Diagnostics
          <InfoTip
            content="The versions this instance is running, ready to paste into a bug report."
            docs="instance.admin"
          />
        </CardTitle>
        <CopyButton value={report} label="Copy" />
      </CardHeader>
      <CardContent>
        <pre className="overflow-x-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs text-muted-foreground">
          {report}
        </pre>
      </CardContent>
    </Card>
  );
}
