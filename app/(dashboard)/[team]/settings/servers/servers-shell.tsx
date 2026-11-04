import type { ElementType } from "react";
import {
  Boxes,
  Copy,
  Cpu,
  HardDrive,
  MemoryStick,
  RefreshCw,
  Plus,
  Settings2,
  MoreHorizontal,
} from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { Bone } from "@/components/ui/skeleton";
import { RefreshLabel } from "./check-status-button";
import { ServerUseBadge } from "@/components/servers/server-role-badge";
import { AGENT_VERSION } from "@/lib/version";
import { AgentVersionBadge } from "./agent-version-badge";

// The parts of the Servers page its loading state draws too.
export function ServersHeader({ actions }: { actions: React.ReactNode }) {
  return (
    <PageHeader
      docs="servers.overview"
      title={
        <span className="flex items-center gap-2">
          Servers
          <InfoTip
            content={
              <>
                Start with <strong>this host</strong>: add it (use its IP), then
                run the one-time install command it gives you on the box to
                install the agent. Add more Linux hosts the same way. The agent
                calls home and provisions itself - Deplo never needs SSH access
                to your servers.
              </>
            }
          />
        </span>
      }
      description="Connected Docker hosts running your deployments."
      actions={actions}
    />
  );
}

export function ServersHeaderActionsSkeleton() {
  return (
    <>
      {/* The page re-checks every server as it opens, so it starts on Refreshing. */}
      <Button variant="outline" size="sm" disabled>
        <RefreshCw className="size-4 animate-spin" />
        <RefreshLabel sweeping />
      </Button>
      <Button size="sm" disabled>
        <Plus className="size-4" />
        Add
      </Button>
    </>
  );
}

export function Spec({
  icon: Icon,
  label,
  value,
  unit,
}: {
  icon: ElementType;
  label: string;
  value: React.ReactNode;
  unit: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-lg font-semibold tabular-nums">{value}</span>
        <span className="text-xs text-muted-foreground">{unit}</span>
      </div>
    </div>
  );
}

export function SpecTilesSkeleton() {
  return (
    <>
      <Spec icon={Cpu} label="CPU" value={<Bone>4</Bone>} unit="cores" />
      <Spec
        icon={MemoryStick}
        label="Memory"
        value={<Bone>16</Bone>}
        unit="GB RAM"
      />
      <Spec icon={HardDrive} label="Disk" value={<Bone>160</Bone>} unit="GB" />
      <Spec
        icon={Boxes}
        label="Docker"
        value={<Bone>29.0.1</Bone>}
        unit="engine"
      />
    </>
  );
}

export function ServerCardSkeleton() {
  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <CardTitle className="min-w-0 truncate">
              <Bone>server-name</Bone>
            </CardTitle>
            {/* An online server's health is a dot; Checking or Offline is a badge. */}
            <Bone box className="rounded-full">
              <span className="size-3" />
            </Bone>
            <Bone box>
              <ServerUseBadge use="everything" />
            </Bone>
            <Bone box>
              <Badge variant="muted">All teams</Badge>
            </Bone>
          </div>
          <div className="contents max-md:hidden">
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="size-8 shrink-0"
                disabled
                aria-hidden
              >
                <RefreshCw className="size-4" />
              </Button>
              <Button variant="outline" size="sm" disabled>
                <Settings2 className="size-4" />
                Manage
              </Button>
            </div>
          </div>
          <div className="ml-auto flex justify-end md:hidden">
            <Button variant="ghost" size="icon-sm" disabled aria-hidden>
              <MoreHorizontal className="size-4" />
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
          <span className="flex items-center gap-0.5">
            <span className="font-mono text-muted-foreground">
              <Bone>203.0.113.10</Bone>
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6 text-muted-foreground"
              disabled
              aria-hidden
            >
              <Copy />
            </Button>
          </span>
          <Bone box>
            <AgentVersionBadge
              version={AGENT_VERSION}
              expected={AGENT_VERSION}
              reach="usable"
            />
          </Bone>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <SpecTilesSkeleton />
        </div>
      </CardContent>
    </Card>
  );
}
