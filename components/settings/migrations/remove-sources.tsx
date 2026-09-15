"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { DownloadCloud } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { CommandLine } from "@/components/shared/code-block";
import { gql, gqlAction } from "@/lib/graphql-client";

const SOURCES = /* GraphQL */ `
  query MigrationSources {
    agentUninstallCommand
    servers {
      id
      name
      role
      uninstallError
    }
  }
`;

const UNINSTALL = /* GraphQL */ `
  mutation FinishMigration($id: String!) {
    uninstallServerAgent(id: $id) {
      removed
      error
    }
  }
`;

const FORGET = /* GraphQL */ `
  mutation ForgetMigrationSource($id: String!) {
    removeServer(id: $id) {
      warning
    }
  }
`;

interface Source {
  id: string;
  name: string;
  role: string;
  uninstallError: string;
}

export function RemoveMigrationSources({ teamId }: { teamId?: string }) {
  const router = useRouter();
  const opts = React.useMemo(() => (teamId ? { teamId } : undefined), [teamId]);
  const [sources, setSources] = React.useState<Source[]>([]);
  const [command, setCommand] = React.useState("");
  const [leftovers, setLeftovers] = React.useState<string[]>([]);

  const load = React.useCallback(async (): Promise<{
    rows: Source[];
    command: string;
  }> => {
    try {
      const data = await gql<{
        servers: Source[] | null;
        agentUninstallCommand: string | null;
      }>(SOURCES, undefined, undefined, opts);
      return {
        rows: (data.servers ?? []).filter(
          (s) => s.role === "import" && s.uninstallError,
        ),
        command: data.agentUninstallCommand ?? "",
      };
    } catch {
      return { rows: [], command: "" };
    }
  }, [opts]);

  const reload = React.useCallback(async () => {
    const next = await load();
    setSources(next.rows);
    setCommand(next.command);
  }, [load]);

  React.useEffect(() => {
    let live = true;
    void load().then((next) => {
      if (!live) return;
      setSources(next.rows);
      setCommand(next.command);
    });
    return () => {
      live = false;
    };
  }, [load]);

  if (sources.length === 0 && leftovers.length === 0) return null;

  async function finish() {
    const failures: string[] = [];
    const kept: string[] = [];
    for (const s of sources) {
      const un = await gqlAction<
        { uninstallServerAgent: { removed: boolean; error: string | null } },
        { removed: boolean; error: string | null }
      >(UNINSTALL, { id: s.id }, (d) => d.uninstallServerAgent, opts);
      if (un.ok && un.data?.removed) continue;
      const rm = await gqlAction<
        { removeServer: { warning: string | null } },
        { warning: string | null }
      >(FORGET, { id: s.id }, (d) => d.removeServer, opts);
      if (!rm.ok) {
        failures.push(`${s.name}: ${rm.error}`);
        continue;
      }
      if (rm.data?.warning) toast.warning(`${s.name}: ${rm.data.warning}`);
      kept.push(s.name);
    }
    setLeftovers((prev) => [...new Set([...prev, ...kept])]);
    await reload();
    router.refresh();
    if (failures.length > 0) {
      for (const f of failures) toast.error(f);
      return {
        ok: false as const,
        error: `${failures.length} could not be removed`,
      };
    }
    return { ok: true as const, data: null };
  }

  const names = sources.map((s) => s.name).join(", ");
  const one = sources.length === 1;
  const done = sources.length === 0;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <DownloadCloud className="size-4 text-muted-foreground" />
            Agent still installed
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {done
              ? "Deplo has stopped tracking these machines and can no longer remove their agents for you."
              : one
                ? "Deplo tried three times to take its agent off the machine it imported from, and could not."
                : "Deplo tried three times to take its agent off the machines it imported from, and could not."}
          </p>
        </div>
        {!done && (
          <ConfirmAction
            trigger={
              <Button variant="outline" size="sm">
                Remove from Deplo
              </Button>
            }
            title={one ? "Remove server?" : "Remove servers?"}
            description={
              <>
                Deplo uninstalls itself from <strong>{names}</strong> and stops
                tracking {one ? "that machine" : "those machines"}.
              </>
            }
            consequence="Data still there can no longer be copied, so finish importing first. Where a host cannot be reached, the command below is left for you."
            confirmLabel="Remove from Deplo"
            onConfirm={finish}
          />
        )}
      </CardHeader>
      <CardContent>
        <ul className="space-y-2 text-sm">
          {sources.map((s) => (
            <li key={s.id}>
              <p className="truncate font-medium">{s.name}</p>
              <p className="mt-1 font-mono text-xs break-words text-muted-foreground">
                {s.uninstallError}
              </p>
            </li>
          ))}
          {leftovers.map((name) => (
            <li key={name}>
              <p className="font-medium">{name}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                No longer tracked. Its agent is still on that machine.
              </p>
            </li>
          ))}
        </ul>
        {command && (
          <div className="mt-4 space-y-2">
            <p className="text-xs text-muted-foreground">
              Run this on each of those hosts, as root, to take the agent off.
            </p>
            <CommandLine command={command} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
