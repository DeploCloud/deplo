"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import {
  ArrowUpRight,
  CheckCircle2,
  Loader2,
  Server as ServerIcon,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { InfoTip } from "@/components/ui/info-tip";
import { gqlAction } from "@/lib/graphql-client";
import type { AgentUpdateDTO } from "@/lib/data/servers/agent-update-state";
import { AgentUpdateStatus } from "@/components/servers/agent-update-status";

export interface FleetSummary {
  expected: string;
  minimum: string;
  total: number;
  behind: {
    id: string;
    name: string;
    version: string | null;
    usable: boolean;
    update: AgentUpdateDTO | null;
  }[];
  updating: boolean;
  pausedBy: string | null;
}

const FLEET_QUERY = /* GraphQL */ `
  query FleetAgents {
    fleetAgents {
      expected
      minimum
      total
      updating
      pausedBy
      behind {
        id
        name
        version
        usable
        update {
          running
          failed
          gaveUp
          attempts
          failure
          lastError
          firstFailedAt
          nextRetryAt
        }
      }
    }
  }
`;

const POLL_MS = 10_000;
const POLL_TRIES = 30;

export function useFleetAgents(seed: FleetSummary): {
  fleet: FleetSummary;
  refresh: () => void;
} {
  const [fleet, setFleet] = React.useState(seed);
  const refresh = React.useCallback(async () => {
    const res = await gqlAction<{ fleetAgents: FleetSummary }, FleetSummary>(
      FLEET_QUERY,
      undefined,
      (d) => d.fleetAgents,
    );
    if (res.ok && res.data) setFleet(res.data);
  }, []);

  React.useEffect(() => {
    if (!fleet.updating) return;
    let stop = false;
    let tries = 0;
    const poll = async () => {
      await refresh();
      if (stop) return;
      if (++tries < POLL_TRIES) timer = setTimeout(poll, POLL_MS);
    };
    let timer = setTimeout(poll, POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [fleet.updating, refresh]);

  return { fleet, refresh };
}

export function FleetAgentsCard({
  fleet,
  onSettled,
}: {
  fleet: FleetSummary;
  onSettled: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          <ServerIcon className="size-4" />
          Server agents
          <InfoTip
            content="Every server runs a small agent. Deplo brings each one to the version it is paired with, one server at a time."
            docs="servers.overview"
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <FleetLine fleet={fleet} />
        {fleet.pausedBy && (
          <p className="flex items-start gap-1.5 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
            <span>
              Waiting for {fleet.pausedBy} to recover before updating the rest.
            </span>
          </p>
        )}
        {fleet.behind.slice(0, BEHIND_SHOWN).map((server) => (
          <BehindLine key={server.id} server={server} onSettled={onSettled} />
        ))}
        {fleet.behind.length > BEHIND_SHOWN && (
          <BehindDialog fleet={fleet} onSettled={onSettled} />
        )}
      </CardContent>
    </Card>
  );
}

function FleetLine({ fleet }: { fleet: FleetSummary }) {
  if (fleet.total === 0)
    return (
      <p className="text-sm text-muted-foreground">No servers connected yet.</p>
    );
  const upToDate = fleet.total - fleet.behind.length;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {fleet.behind.length === 0 ? (
        <CheckCircle2 className="size-4 text-[var(--success)]" />
      ) : (
        <ArrowUpRight className="size-4 text-[var(--success)]" />
      )}
      <span className="font-medium">
        {upToDate} of {fleet.total}
      </span>
      on v{fleet.expected}
    </p>
  );
}

const BEHIND_SHOWN = 3;

function BehindDialog({
  fleet,
  onSettled,
}: {
  fleet: FleetSummary;
  onSettled: () => void;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="link" size="sm" className="h-auto p-0">
          Read more
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {fleet.behind.length} servers are behind v{fleet.expected}
          </DialogTitle>
          <DialogDescription>
            Deplo updates each of them on its own, and retries a failed update
            for 24 hours.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {fleet.behind.map((server) => (
            <BehindLine key={server.id} server={server} onSettled={onSettled} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BehindLine({
  server,
  onSettled,
}: {
  server: FleetSummary["behind"][number];
  onSettled: () => void;
}) {
  const failed = Boolean(server.update?.failed);
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        {failed ? (
          <TriangleAlert className="size-4 text-[var(--warning)]" />
        ) : (
          <Loader2 className="size-4 animate-spin" />
        )}
        <span className="font-medium">{server.name}</span>
        <span className="text-muted-foreground">
          {server.version ? `is on v${server.version}` : "has no agent version"}
        </span>
        <Link
          href={`/settings/servers/${server.id}`}
          className="text-foreground underline underline-offset-4"
        >
          Manage
        </Link>
      </p>
      <div className="pl-6 empty:hidden">
        <AgentUpdateStatus
          serverId={server.id}
          usable={server.usable}
          update={server.update}
          onSettled={onSettled}
        />
      </div>
    </div>
  );
}
