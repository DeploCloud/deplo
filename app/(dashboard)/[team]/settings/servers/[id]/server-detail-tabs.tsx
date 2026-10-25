"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "@/lib/nav";
import { toast } from "sonner";
import {
  AppWindow,
  Boxes,
  Brush,
  Cpu,
  Gauge,
  Globe,
  HardDrive,
  LayoutDashboard,
  ListChecks,
  MemoryStick,
  ShieldCheck,
  Tag,
  SlidersHorizontal,
  Users,
  Wrench,
} from "lucide-react";

import {
  Tabs,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import {
  SettingGroup,
  SettingItem,
} from "@/components/settings/deplo-settings-panel/setting-item";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SlidingButtonGroup } from "@/components/ui/sliding-button-group";
import { cn } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";
import {
  TeamChecklist,
  accessIsComplete,
  type ServerAccess,
  type TeamOption,
} from "@/components/servers/server-team-access";
import { ServerReadinessDialog } from "@/components/servers/server-readiness-dialog";
import type { CleanupPolicy } from "@/lib/data/docker-cleanup/policy";
import type { CleanupRunDTO } from "@/lib/data/docker-cleanup/run-history";
import type { ServerWorkload } from "@/lib/data/servers/workloads";
import { AgentVersionBadge } from "../agent-version-badge";
import { ServerMaintenanceTab } from "./maintenance-tab";
import { ServerCleanupTab } from "./cleanup-tab";
import { ServerAdvancedTab } from "./advanced-tab/server-advanced-tab";
import { ServerCertificatesTab } from "./certificates-tab";
import { ServerWorkloads } from "@/components/servers/server-workloads";
import { AgentUpdateStatus } from "@/components/servers/agent-update-status";
import type { AgentUpdateDTO } from "@/lib/data/servers/agent-update-state";

export type ServerSummary = {
  id: string;
  name: string;
  ip: string;
  host: string;
  agentPort: number | null;
  /** Its agent links in to Deplo, so its address is only for its apps (ADR-0038). */
  linked: boolean;
  status: string;
  cpuCores: number;
  memoryMb: number;
  diskGb: number;
  dockerVersion: string;
  allTeams: boolean;
  deployConcurrency: number;
  role: "everything" | "build" | "storage";
  buildFallback: boolean;
  generatedAddressFamily: "ipv4" | "ipv6" | null;
  isDeploHost: boolean;
  provisioning: boolean;
  agentVersion: string | null;
  expectedAgentVersion: string;
  agentUsable: boolean;
  agentUpdate: AgentUpdateDTO | null;
};

const TABS = [
  "overview",
  "apps",
  "certificates",
  "maintenance",
  "cleanup",
  "advanced",
] as const;
type TabId = (typeof TABS)[number];

export function ServerDetailTabs({
  server,
  teams,
  accessTeamIds,
  cleanup,
  workloads,
}: {
  server: ServerSummary;
  teams: TeamOption[];
  accessTeamIds: string[];
  cleanup: { policy: CleanupPolicy; runs: CleanupRunDTO[] };
  workloads: ServerWorkload[];
}) {
  const params = useSearchParams();
  const requested = params.get("tab");
  const active: TabId = (TABS as readonly string[]).includes(requested ?? "")
    ? (requested as TabId)
    : "overview";

  function selectTab(tab: string) {
    const next = new URLSearchParams(params.toString());
    if (tab === "overview") next.delete("tab");
    else next.set("tab", tab);
    const s = next.toString();
    window.history.replaceState(
      null,
      "",
      s ? `?${s}` : window.location.pathname,
    );
  }

  return (
    <Tabs value={active} onValueChange={selectTab}>
      <UnderlineTabsList>
        <UnderlineTabsTrigger value="overview">
          <LayoutDashboard className="size-4" />
          Overview
        </UnderlineTabsTrigger>
        <UnderlineTabsTrigger value="apps">
          <AppWindow className="size-4" />
          Apps
        </UnderlineTabsTrigger>
        <UnderlineTabsTrigger value="certificates">
          <ShieldCheck className="size-4" />
          Certificates
        </UnderlineTabsTrigger>
        <UnderlineTabsTrigger value="maintenance">
          <Wrench className="size-4" />
          Maintenance
        </UnderlineTabsTrigger>
        <UnderlineTabsTrigger value="cleanup">
          <Brush className="size-4" />
          Cleanup
        </UnderlineTabsTrigger>
        <UnderlineTabsTrigger value="advanced">
          <SlidersHorizontal className="size-4" />
          Advanced
        </UnderlineTabsTrigger>
      </UnderlineTabsList>

      <TabsContent value="overview" className="space-y-4 pt-4">
        <OverviewTab
          server={server}
          teams={teams}
          accessTeamIds={accessTeamIds}
        />
      </TabsContent>
      <TabsContent value="apps" className="space-y-4 pt-4">
        <ServerWorkloads serverId={server.id} initial={workloads} />
      </TabsContent>
      <TabsContent value="certificates" className="space-y-4 pt-4">
        <ServerCertificatesTab server={server} />
      </TabsContent>
      <TabsContent value="maintenance" className="space-y-4 pt-4">
        <ServerMaintenanceTab server={server} />
      </TabsContent>
      <TabsContent value="cleanup" className="space-y-4 pt-4">
        <ServerCleanupTab server={server} cleanup={cleanup} />
      </TabsContent>
      <TabsContent value="advanced" className="space-y-4 pt-4">
        <ServerAdvancedTab server={server} />
      </TabsContent>
    </Tabs>
  );
}

function Spec({
  icon: Icon,
  label,
  value,
  unit,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  unit: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="size-3.5" />
          {label}
        </div>
        <div className="mt-1 flex items-baseline gap-1">
          <span
            className="min-w-0 truncate text-2xl font-semibold tabular-nums"
            title={value}
          >
            {value}
          </span>
          <span className="text-xs text-muted-foreground">{unit}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function OverviewTab({
  server,
  teams,
  accessTeamIds,
}: {
  server: ServerSummary;
  teams: TeamOption[];
  accessTeamIds: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [readinessOpen, setReadinessOpen] = React.useState(false);
  const [name, setName] = React.useState(server.name);
  const [concurrency, setConcurrency] = React.useState(
    String(server.deployConcurrency),
  );

  const ramGb = server.memoryMb ? Math.round(server.memoryMb / 1024) : 0;
  const num = (n: number) => (n > 0 ? String(n) : "-");

  function saveName(e: React.FormEvent) {
    e.preventDefault();
    const next = name.trim();
    startTransition(async () => {
      const res = await gqlAction<{ renameServer: { id: string } }>(
        `mutation RenameServer($id: String!, $name: String!) {
          renameServer(id: $id, name: $name) { id }
        }`,
        { id: server.id, name: next },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setName(next);
      toast.success(`Server renamed to ${next}`);
      router.refresh();
    });
  }

  function saveConcurrency(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(concurrency);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      toast.error("Enter a whole number between 1 and 50");
      return;
    }
    startTransition(async () => {
      const res = await gqlAction<{
        setServerDeployConcurrency: { id: string };
      }>(
        `mutation SetServerDeployConcurrency($id: String!, $concurrency: Int!) {
          setServerDeployConcurrency(id: $id, concurrency: $concurrency) { id }
        }`,
        { id: server.id, concurrency: n },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        n === 1
          ? `${server.name} runs one deploy at a time`
          : `${server.name} runs up to ${n} deploys at once`,
      );
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Spec
          icon={Cpu}
          label="CPU"
          value={num(server.cpuCores)}
          unit={server.cpuCores === 1 ? "core" : "cores"}
        />
        <Spec
          icon={MemoryStick}
          label="Memory"
          value={num(ramGb)}
          unit="GB RAM"
        />
        <Spec
          icon={HardDrive}
          label="Disk"
          value={num(server.diskGb)}
          unit="GB"
        />
        <Spec
          icon={Boxes}
          label="Docker"
          value={server.dockerVersion || "-"}
          unit="engine"
        />
      </div>

      <Card>
        <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface">
              <ShieldCheck className="size-5 text-muted-foreground" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-medium">Server agent</h2>
                <AgentVersionBadge
                  version={server.agentVersion}
                  expected={server.expectedAgentVersion}
                />
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Keeps this server ready to build and run your apps.
              </p>
              <div className="mt-2 empty:hidden">
                <AgentUpdateStatus
                  serverId={server.id}
                  usable={server.agentUsable}
                  update={server.agentUpdate}
                  onSettled={() => router.refresh()}
                />
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={() => setReadinessOpen(true)}
              disabled={pending}
            >
              <ListChecks className="size-4" />
              Check readiness
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <SettingGroup icon={SlidersHorizontal} title="Settings">
          <SettingItem
            icon={Tag}
            title="Display name"
            htmlFor="server-display-name"
            info="The name shown in Deplo. Changing it does not rename the machine."
            control={
              <form className="flex items-center gap-2" onSubmit={saveName}>
                <Input
                  id="server-display-name"
                  aria-label="Display name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={pending}
                  className="w-36"
                />
                <Button
                  type="submit"
                  disabled={
                    pending || !name.trim() || name.trim() === server.name
                  }
                >
                  {pending ? "Saving" : "Save"}
                </Button>
              </form>
            }
          />
          <SettingItem
            icon={Gauge}
            title="Concurrent deployments"
            htmlFor="deploy-concurrency"
            info="1 means one deploy at a time. Extra deploys wait in a queue; other servers are unaffected."
            docs="deploy.queue"
            control={
              <form
                className="flex items-center gap-2"
                onSubmit={saveConcurrency}
              >
                <Input
                  id="deploy-concurrency"
                  aria-label="Concurrent deployments"
                  type="number"
                  min={1}
                  max={50}
                  value={concurrency}
                  onChange={(e) => setConcurrency(e.target.value)}
                  disabled={pending}
                  className="w-20"
                />
                <Button
                  type="submit"
                  disabled={
                    pending || concurrency === String(server.deployConcurrency)
                  }
                >
                  {pending ? "Saving" : "Save"}
                </Button>
              </form>
            }
          />
        </SettingGroup>

        <AccessCard
          server={server}
          teams={teams}
          accessTeamIds={accessTeamIds}
        />
      </div>

      <ServerReadinessDialog
        serverId={server.id}
        serverName={server.name}
        open={readinessOpen}
        onOpenChange={setReadinessOpen}
      />
    </div>
  );
}

function AccessCard({
  server,
  teams,
  accessTeamIds,
}: {
  server: ServerSummary;
  teams: TeamOption[];
  accessTeamIds: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [access, setAccess] = React.useState<ServerAccess>({
    allTeams: server.allTeams,
    teamIds: accessTeamIds,
  });

  function saveAccess(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await gqlAction<{ setServerTeams: { id: string } }>(
        `mutation SetServerTeams($input: SetServerTeamsInput!) {
          setServerTeams(input: $input) { id }
        }`,
        {
          input: {
            serverId: server.id,
            allTeams: access.allTeams,
            teamIds: access.allTeams ? [] : access.teamIds,
          },
        },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        access.allTeams
          ? `${server.name} is now available to all teams`
          : `${server.name} team access updated`,
      );
      router.refresh();
    });
  }

  const accessDirty =
    access.allTeams !== server.allTeams ||
    (!access.allTeams &&
      [...access.teamIds].sort().join() !== [...accessTeamIds].sort().join());

  return (
    <SettingGroup icon={Users} title="Team access">
      <form onSubmit={saveAccess} className="divide-y divide-border">
        <SettingItem
          icon={access.allTeams ? Globe : Users}
          title="Who can deploy"
          info="Which teams are allowed to deploy to this server."
          docs="servers.teams"
          description={
            access.allTeams
              ? "Every team can deploy here"
              : "Only the teams you pick"
          }
          control={
            <SlidingButtonGroup aria-label="Team access">
              {[
                { all: true, label: "All teams" },
                { all: false, label: "Specific teams" },
              ].map((o) => (
                <button
                  key={o.label}
                  type="button"
                  aria-pressed={access.allTeams === o.all}
                  disabled={pending}
                  onClick={() =>
                    setAccess({
                      allTeams: o.all,
                      teamIds: o.all ? [] : access.teamIds,
                    })
                  }
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50",
                    access.allTeams === o.all
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {o.label}
                </button>
              ))}
            </SlidingButtonGroup>
          }
        />
        {!access.allTeams && (
          <TeamChecklist
            teams={teams}
            value={access.teamIds}
            onChange={(teamIds) => setAccess({ allTeams: false, teamIds })}
            disabled={pending}
            className="p-2 sm:px-3"
          />
        )}
        <div className="flex items-center justify-between gap-3 p-4 sm:px-5">
          <span className="text-xs text-muted-foreground">
            {!access.allTeams &&
              `${access.teamIds.length} team${access.teamIds.length === 1 ? "" : "s"} selected`}
          </span>
          <Button
            type="submit"
            disabled={pending || !accessDirty || !accessIsComplete(access)}
          >
            Save access
          </Button>
        </div>
      </form>
    </SettingGroup>
  );
}
