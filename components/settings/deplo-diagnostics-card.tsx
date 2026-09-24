"use client";

import * as React from "react";
import { LifeBuoy } from "lucide-react";

import { SettingItem } from "@/components/settings/deplo-settings-panel/setting-item";
import { CopyButton } from "@/components/shared/copy-button";

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
      `Deplo          ${version}`,
      `panel          ${panelUrl} (${panelUrlSource})`,
      `Deplo host     ${deploHostName ?? "not added as a server"}`,
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
    <SettingItem
      icon={LifeBuoy}
      title="Diagnostics"
      description="The versions this instance is running, ready to paste into a bug report."
      docs="instance.admin"
      control={<CopyButton value={report} label="Copy" />}
    >
      <pre className="overflow-x-auto rounded-lg border border-border bg-surface p-3 font-mono text-xs text-muted-foreground">
        {report}
      </pre>
    </SettingItem>
  );
}
