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

export interface FleetSummary {
  expected: string;
  total: number;
  behind: { id: string; name: string; version: string | null }[];
  updating: boolean;
}

const FLEET_QUERY = /* GraphQL */ `
  query FleetAgents {
    fleetAgents {
      expected
      total
      updating
      behind {
        id
        name
        version
      }
    }
  }
`;

const POLL_MS = 10_000;
const POLL_TRIES = 30;

export function useFleetAgents(seed: FleetSummary): FleetSummary {
  const [fleet, setFleet] = React.useState(seed);

  React.useEffect(() => {
    if (!fleet.updating) return;
    let stop = false;
    let tries = 0;
    const poll = async () => {
      const res = await gqlAction<{ fleetAgents: FleetSummary }, FleetSummary>(
        FLEET_QUERY,
        undefined,
        (d) => d.fleetAgents,
      );
      if (stop) return;
      if (res.ok && res.data) setFleet(res.data);
      if (++tries < POLL_TRIES) timer = setTimeout(poll, POLL_MS);
    };
    let timer = setTimeout(poll, POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [fleet.updating]);

  return fleet;
}

export function FleetAgentsCard({ fleet }: { fleet: FleetSummary }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          <ServerIcon className="size-4" />
          Server agents
          <InfoTip
            content="Every server runs a small agent. Deplo brings them to the panel's version by itself, one server at a time."
            docs="servers.overview"
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <FleetLine fleet={fleet} />
        {fleet.behind.slice(0, BEHIND_SHOWN).map((server) => (
          <BehindLine
            key={server.id}
            server={server}
            updating={fleet.updating}
          />
        ))}
        {fleet.behind.length > BEHIND_SHOWN && <BehindDialog fleet={fleet} />}
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

function BehindDialog({ fleet }: { fleet: FleetSummary }) {
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
            Deplo updates each of them on its own, and retries every 15 minutes.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {fleet.behind.map((server) => (
            <BehindLine
              key={server.id}
              server={server}
              updating={fleet.updating}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BehindLine({
  server,
  updating,
}: {
  server: FleetSummary["behind"][number];
  updating: boolean;
}) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {updating ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <TriangleAlert className="size-4 text-[var(--warning)]" />
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
  );
}
