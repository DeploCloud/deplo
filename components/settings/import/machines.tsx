"use client";

import * as React from "react";
import { toast } from "sonner";
import { Check, Copy, Server as ServerIcon, TriangleAlert } from "lucide-react";

import { gqlAction } from "@/lib/graphql-client";
import { Button } from "@/components/ui/button";
import type { PlanServer } from "./types";

/**
 * The machines behind that Dokploy, and whether Deplo can reach their disks.
 *
 * This is a GATE, not a summary. Deplo copies a volume by asking the agent ON the
 * host that holds it - there is no other way in, and agents cannot dial each
 * other - so a Dokploy machine with no agent is a machine whose databases arrive
 * empty and stay empty. Finding that out at the end, with the old platform
 * already stopped, is the failure this screen exists to prevent.
 *
 * Adding the server happens HERE rather than by sending someone to Settings:
 * they are mid-import, they know the address, and the only thing missing is one
 * command on a box they are already logged into.
 */

const ADD_SERVER = /* GraphQL */ `
  mutation AddServerForImport($input: AddServerInput!) {
    addServer(input: $input) {
      server {
        id
        name
      }
      installCommand
    }
  }
`;

const SERVER_STATUS = /* GraphQL */ `
  query ImportServerStatus($id: String!) {
    server(id: $id) {
      id
      name
      status
    }
  }
`;

interface Pending {
  serverId: string;
  name: string;
  installCommand: string;
}

export function MachineGate({
  machines,
  canAddServers,
  onResolved,
}: {
  machines: PlanServer[];
  /** Registering a host is instance-admin only, like everywhere else. */
  canAddServers: boolean;
  /** One machine just came online: it now maps to this Deplo server. */
  onResolved: (sourceId: string, serverId: string, serverName: string) => void;
}) {
  const [pending, setPending] = React.useState<Record<string, Pending>>({});
  const [adding, setAdding] = React.useState<string | null>(null);

  const missing = machines.filter((m) => !m.deploServerId);

  async function addOne(m: PlanServer) {
    if (!m.ipAddress) {
      toast.error("Deplo could not work out that machine's address.");
      return;
    }
    setAdding(m.sourceId);
    const res = await gqlAction<
      { addServer: { server: { id: string; name: string }; installCommand: string } },
      { server: { id: string; name: string }; installCommand: string }
    >(
      ADD_SERVER,
      {
        input: {
          name: m.sourceId ? m.name : "dokploy-host",
          host: m.ipAddress,
          // A MIGRATION SOURCE, not a server: the install command touches nothing
          // on the box but the agent itself, the host stays out of every picker
          // and every sweep, and finishing the migration uninstalls it from here.
          importOnly: true,
        },
      },
      (d) => d.addServer,
    );
    setAdding(null);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    if (!res.data) return;
    setPending((prev) => ({
      ...prev,
      [m.sourceId]: {
        serverId: res.data!.server.id,
        name: res.data!.server.name,
        installCommand: res.data!.installCommand,
      },
    }));
  }

  // One poll for every machine still waiting for its agent to call home. Stops
  // by itself: a resolved machine is removed from `pending`.
  React.useEffect(() => {
    const waiting = Object.entries(pending);
    if (waiting.length === 0) return;
    const timer = setInterval(async () => {
      for (const [sourceId, p] of waiting) {
        const res = await gqlAction<
          { server: { status: string } | null },
          { status: string } | null
        >(SERVER_STATUS, { id: p.serverId }, (d) => d.server);
        if (!res.ok) continue;
        // A null server means the row is GONE (removed elsewhere, or the
        // migration was finished in another tab). Waiting for it forever would
        // leave this line stuck on "Waiting for the agent" with nothing coming.
        if (!res.data) {
          setPending((prev) => {
            const next = { ...prev };
            delete next[sourceId];
            return next;
          });
          toast.error(`${p.name} is no longer registered - add it again`);
          continue;
        }
        if (res.data.status !== "provisioning") {
          setPending((prev) => {
            const next = { ...prev };
            delete next[sourceId];
            return next;
          });
          onResolved(sourceId, p.serverId, p.name);
        }
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [pending, onResolved]);

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div>
        <div className="text-sm font-medium">Machines behind that Dokploy</div>
        <p className="mt-1 text-sm text-muted-foreground">
          Deplo copies your data by reading it on the machine that holds it, so it
          needs its agent on each one. Nothing else is installed there, and Deplo
          removes it for you when the migration is done.
        </p>
      </div>

      {machines.map((m) => {
        const p = pending[m.sourceId];
        return (
          <div key={m.sourceId || "own"} className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <ServerIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm font-medium">{m.name}</span>
                {m.ipAddress && (
                  <span className="truncate text-xs text-muted-foreground">
                    {m.ipAddress}
                  </span>
                )}
              </div>
              {m.deploServerId ? (
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-success">
                  <Check className="size-3.5" />
                  {m.deploServerName}
                </span>
              ) : p ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  Waiting for the agent
                </span>
              ) : canAddServers ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void addOne(m)}
                  disabled={adding != null}
                >
                  Add it as a server
                </Button>
              ) : (
                <span className="shrink-0 text-xs text-warning">
                  No agent - ask an instance admin
                </span>
              )}
            </div>

            {p && (
              <div className="space-y-2 rounded-md bg-muted/40 p-2.5">
                <p className="text-xs text-muted-foreground">
                  Run this on {m.ipAddress}, then this screen carries on by itself.
                </p>
                <pre className="overflow-x-auto rounded bg-background p-2 text-xs">
                  {p.installCommand}
                </pre>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    navigator.clipboard.writeText(p.installCommand);
                    toast.success("Install command copied");
                  }}
                >
                  <Copy className="size-4" />
                  Copy
                </Button>
              </div>
            )}
          </div>
        );
      })}

      {missing.length > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning" />
          <div className="min-w-0">
            <div className="font-medium text-warning">
              {missing.length} machine(s) have no Deplo agent
            </div>
            <p className="mt-1 text-muted-foreground">
              Their apps would arrive without their data, and their databases
              empty. Add them before importing.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
