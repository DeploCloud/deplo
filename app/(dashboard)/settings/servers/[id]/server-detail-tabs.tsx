"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  Boxes,
  Brush,
  CircleFadingArrowUp,
  Cpu,
  Gauge,
  HardDrive,
  LayoutDashboard,
  ListChecks,
  MemoryStick,
  ShieldCheck,
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
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import { gqlAction } from "@/lib/graphql-client";
import {
  ServerTeamAccess,
  type ServerAccess,
  type TeamOption,
} from "@/components/servers/server-team-access";
import { ServerReadinessDialog } from "@/components/servers/server-readiness-dialog";
import type { CleanupPolicy, CleanupRunDTO } from "@/lib/data/docker-cleanup";
import { AgentVersionBadge } from "../agent-version-badge";
import { ServerMaintenanceTab } from "./maintenance-tab";
import { ServerCleanupTab } from "./cleanup-tab";
import { ServerAdvancedTab } from "./advanced-tab";
import { ServerCertificatesTab } from "./certificates-tab";

/**
 * The six tabs of a server's management page. Horizontal, using the same
 * underline nav Storage and Variables already use — the sidebar is untouched.
 *
 * The active tab rides in `?tab=`, so a link can point at the thing being talked
 * about ("your Traefik panel is under Advanced") instead of at a page plus
 * instructions. Nothing here fetches on mount: the tabs that need the host ask
 * for it when they are opened, which is what keeps this page fast on the very
 * server whose agent is wedged.
 */

export type ServerSummary = {
  id: string;
  name: string;
  ip: string;
  status: string;
  cpuCores: number;
  memoryMb: number;
  diskGb: number;
  dockerVersion: string;
  allTeams: boolean;
  deployConcurrency: number;
  /** What this server is for, editable from the Advanced tab. All three are
   *  settable on a host that HAS Docker; one installed without it stays on
   *  "storage" until its install command is re-run. */
  role: "everything" | "build" | "storage";
  traefikDashboard: { domain: string; username: string } | null;
  /** A zero-config nip.io hostname for the Traefik panel on THIS server, resolved
   *  server-side. Null when the host has no address such a name could point at. */
  suggestedTraefikDomain: string | null;
  isDeploHost: boolean;
  provisioning: boolean;
  /** null when the agent has never reported one. */
  agentVersion: string | null;
  /** The version "Update agent" would install — the latest agent release. */
  expectedAgentVersion: string;
};

const TABS = [
  "overview",
  "access",
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
}: {
  server: ServerSummary;
  teams: TeamOption[];
  accessTeamIds: string[];
  cleanup: { policy: CleanupPolicy; runs: CleanupRunDTO[] };
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
    // replace, not push: flipping between tabs is not navigation the back button
    // should have to walk through one step at a time. And the NATIVE History API
    // rather than `router.replace`, which would re-render this page on the server
    // — every read it does, DNS resolution included — for a query parameter the
    // client already has the panels for. `useSearchParams` still sees it.
    window.history.replaceState(null, "", s ? `?${s}` : window.location.pathname);
  }

  return (
    <Tabs value={active} onValueChange={selectTab}>
      <UnderlineTabsList>
        <UnderlineTabsTrigger value="overview">
          <LayoutDashboard className="size-4" />
          Overview
        </UnderlineTabsTrigger>
        <UnderlineTabsTrigger value="access">
          <Users className="size-4" />
          Access
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
        <OverviewTab server={server} />
      </TabsContent>
      <TabsContent value="access" className="space-y-4 pt-4">
        <AccessTab server={server} teams={teams} accessTeamIds={accessTeamIds} />
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

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

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
    <div className="rounded-lg border border-border bg-muted/30 p-3">
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

function OverviewTab({ server }: { server: ServerSummary }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [readinessOpen, setReadinessOpen] = React.useState(false);
  const [confirmUpdate, setConfirmUpdate] = React.useState(false);

  // Stored capacity, persisted from the agent. 0 means never measured, which is
  // an em dash rather than a confident "0 cores".
  const ramGb = server.memoryMb ? Math.round(server.memoryMb / 1024) : 0;
  const num = (n: number) => (n > 0 ? String(n) : "—");

  function update() {
    startTransition(async () => {
      const res = await gqlAction<{ updateServerAgent: string }>(
        `mutation UpdateServerAgent($id: String!) { updateServerAgent(id: $id) }`,
        { id: server.id },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setConfirmUpdate(false);
      const version = res.data?.updateServerAgent;
      toast.success(
        version ? `Agent updated to v${version}` : "Agent updated",
      );
      router.refresh();
    });
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Spec
          icon={Cpu}
          label="CPU"
          value={num(server.cpuCores)}
          unit={server.cpuCores === 1 ? "core" : "cores"}
        />
        <Spec icon={MemoryStick} label="Memory" value={num(ramGb)} unit="GB RAM" />
        <Spec icon={HardDrive} label="Disk" value={num(server.diskGb)} unit="GB" />
        <Spec
          icon={Boxes}
          label="Docker"
          value={server.dockerVersion || "—"}
          unit="engine"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agent</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            The Deplo agent runs your deployments on this host over an encrypted
            connection. Deplo never needs SSH access.
          </p>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <AgentVersionBadge version={server.agentVersion} />
          {/* Always offered, never nagged about: the button is how you update an
              agent, so it does not wait for the version to fall behind a release
              before it exists. */}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmUpdate(true)}
            disabled={pending}
          >
            <CircleFadingArrowUp className="size-4" />
            Update to v{server.expectedAgentVersion}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setReadinessOpen(true)}
            disabled={pending}
          >
            <ListChecks className="size-4" />
            Check readiness
          </Button>
        </CardContent>
      </Card>

      <ServerReadinessDialog
        serverId={server.id}
        serverName={server.name}
        open={readinessOpen}
        onOpenChange={setReadinessOpen}
      />

      <Dialog open={confirmUpdate} onOpenChange={setConfirmUpdate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CircleFadingArrowUp className="size-4" />
              Update agent on {server.name}?
            </DialogTitle>
            <DialogDescription>
              Updates the agent to <strong>v{server.expectedAgentVersion}</strong>{" "}
              over its existing secure connection. Its certificates are not
              reissued, so the server stays online with the same identity. Takes a
              few seconds while the agent swaps its binary and reconnects.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmUpdate(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={() => update()} disabled={pending}>
              {pending ? "Updating" : `Update to v${server.expectedAgentVersion}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Access                                                              */
/* ------------------------------------------------------------------ */

function AccessTab({
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
  const [concurrency, setConcurrency] = React.useState(String(server.deployConcurrency));

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
      // Surfaces the "these teams still have apps/databases here" block verbatim.
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

  function saveConcurrency(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(concurrency);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      toast.error("Enter a whole number between 1 and 50");
      return;
    }
    startTransition(async () => {
      const res = await gqlAction<{ setServerDeployConcurrency: { id: string } }>(
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

  const accessDirty =
    access.allTeams !== server.allTeams ||
    (!access.allTeams &&
      [...access.teamIds].sort().join() !== [...accessTeamIds].sort().join());

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="size-4" />
            Team access
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Which teams can deploy apps and databases to this server.
          </p>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={saveAccess}>
            <ServerTeamAccess
              value={access}
              teams={teams}
              onChange={setAccess}
              disabled={pending}
            />
            <Button type="submit" disabled={pending || !accessDirty}>
              {pending ? "Saving" : "Save access"}
            </Button>
          </form>
        </CardContent>
      </Card>


      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge className="size-4" />
            Build concurrency
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            How many deployments this server runs at the same time. Extra deploys
            wait in a queue; other servers are unaffected.
          </p>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={saveConcurrency}>
            <div className="space-y-2">
              <FieldLabel
                htmlFor="deploy-concurrency"
                info="1 means one deploy at a time on this server (the safe default). Two deploys of the same app never run at once regardless of this value."
              >
                Concurrent deployments
              </FieldLabel>
              <Input
                id="deploy-concurrency"
                type="number"
                min={1}
                max={50}
                value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}
                disabled={pending}
                className="w-28"
              />
            </div>
            <Button
              type="submit"
              disabled={pending || concurrency === String(server.deployConcurrency)}
            >
              {pending ? "Saving" : "Save"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
