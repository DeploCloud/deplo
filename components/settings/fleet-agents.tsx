"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { Loader2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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

// The servers still short of the pinned agent; nothing when the whole fleet is on it.
export function FleetBehind({
  fleet,
  onSettled,
}: {
  fleet: FleetSummary;
  onSettled: () => void;
}) {
  if (fleet.behind.length === 0 && !fleet.pausedBy) return null;
  return (
    <div className="space-y-2">
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
    </div>
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
          version={server.version}
          update={server.update}
          onSettled={onSettled}
        />
      </div>
    </div>
  );
}
