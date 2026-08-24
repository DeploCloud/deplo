"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { DownloadCloud } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { CommandLine } from "@/components/shared/code-block";
import { gql, gqlAction } from "@/lib/graphql-client";

/**
 * The FALLBACK for taking Deplo's agent back off the machines it was installed on,
 * and it appears only once Deplo has GIVEN UP.
 *
 * Finishing an import does this by itself and keeps doing it on a ladder that
 * outlives the request: one attempt while the wizard is open, two more from the
 * sweep over the following minutes. A source that is merely still being worked on
 * shows nothing at all - asking someone to press a button next to a job already
 * running is how a person learns to press it every time, and then to distrust the
 * automatic half entirely.
 *
 * So the filter is `uninstallError`, not "is there a migration source": non-empty
 * means three attempts failed, and the sentence in it is the host's own. The one
 * other way to get here is a volume copy that failed, which stops the ladder
 * before it starts because the bytes are still on that machine.
 */
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

/**
 * The exit that needs no network. `removeServer` revokes the pin and forgets the
 * row without dialing anything, which is the only thing that still works once the
 * host cannot be reached - and this card exists precisely because it could not be.
 *
 * Without it the card was a dead end that told you to "try again once that machine
 * is reachable", which for a host behind a firewall nobody will open is advice
 * that cannot be followed. Worse, uninstalling the agent BY HAND made it more
 * stuck, not less: there is then even less answering than before.
 */
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
  /** Why Deplo stopped trying. Empty ⇒ nothing to ask anyone. */
  uninstallError: string;
}

export function RemoveMigrationSources() {
  const router = useRouter();
  const [sources, setSources] = React.useState<Source[]>([]);
  const [command, setCommand] = React.useState("");
  const [forgetting, setForgetting] = React.useState<string | null>(null);

  // Read on mount rather than passed as a prop: this component has two homes (the
  // wizard's last step and the report page opened days later), and in the first
  // one the sources are created by the very run that is finishing.
  const load = React.useCallback(async (): Promise<{
    rows: Source[];
    command: string;
  }> => {
    try {
      const data = await gql<{
        servers: Source[] | null;
        agentUninstallCommand: string | null;
      }>(SOURCES);
      return {
        rows: (data.servers ?? []).filter(
          (s) => s.role === "import" && s.uninstallError,
        ),
        command: data.agentUninstallCommand ?? "",
      };
    } catch {
      // The report is worth reading on its own; a failed side query must not
      // take it down.
      return { rows: [], command: "" };
    }
  }, []);

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

  if (sources.length === 0) return null;

  async function finish() {
    const failures: string[] = [];
    for (const s of sources) {
      const res = await gqlAction<
        { uninstallServerAgent: { removed: boolean; error: string | null } },
        { removed: boolean; error: string | null }
      >(UNINSTALL, { id: s.id }, (d) => d.uninstallServerAgent);
      if (!res.ok) failures.push(`${s.name}: ${res.error}`);
      else if (!res.data?.removed)
        failures.push(
          `${s.name}: ${res.data?.error ?? "the agent is still installed"}`,
        );
    }
    await reload();
    router.refresh();
    if (failures.length > 0) {
      // Named, one by one: "some of them failed" is not something anyone can act
      // on. Each one stays in Settings → Servers with its own uninstall command.
      for (const f of failures) toast.error(f);
      return {
        ok: false as const,
        error: `${failures.length} could not be removed`,
      };
    }
    return { ok: true as const, data: null };
  }

  /**
   * Stop tracking one machine. The agent stays where it is - the command below
   * takes it off - but the row goes, which is the part Deplo can still do.
   */
  async function forget(id: string) {
    setForgetting(id);
    const res = await gqlAction<
      { removeServer: { warning: string | null } },
      { warning: string | null }
    >(FORGET, { id }, (d) => d.removeServer);
    setForgetting(null);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    if (res.data?.warning) toast.warning(res.data.warning);
    await reload();
    router.refresh();
    toast.success("Deplo stopped tracking it");
  }

  const names = sources.map((s) => s.name).join(", ");
  const one = sources.length === 1;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <DownloadCloud className="size-4 text-muted-foreground" />
            Agent still installed
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {one
              ? "Deplo tried three times to take its agent off the machine it imported from, and could not. Take it off from the host, or stop tracking the machine."
              : "Deplo tried three times to take its agent off the machines it imported from, and could not. Take them off from each host, or stop tracking them."}
          </p>
        </div>
        <ConfirmAction
          trigger={
            <Button variant="outline" size="sm">
              {one ? "Remove the agent" : "Remove the agents"}
            </Button>
          }
          title={one ? `Remove the agent from ${names}?` : "Remove the agents?"}
          description={`Deplo uninstalls itself from ${names} and stops tracking ${
            one ? "that machine" : "those machines"
          }. Any data still there can no longer be copied, so finish importing first.`}
          confirmLabel={one ? "Remove the agent" : "Remove the agents"}
          successMessage={
            one
              ? "Deplo removed itself from the migration source"
              : "Deplo removed itself from the migration sources"
          }
          onConfirm={finish}
        />
      </CardHeader>
      <CardContent>
        <ul className="space-y-2 text-sm">
          {sources.map((s) => (
            <li key={s.id}>
              <p className="font-medium">{s.name}</p>
              {/* The host's own words, verbatim: whether this is worth retrying
                  or the machine is simply gone is not something Deplo can tell
                  the reader, and the sentence usually can. */}
              <p className="mt-1 font-mono text-xs break-words text-muted-foreground">
                {s.uninstallError}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                disabled={forgetting !== null}
                onClick={() => void forget(s.id)}
              >
                Remove from Deplo
              </Button>
            </li>
          ))}
        </ul>
        {/* One command for every host: it is `<panel>/uninstall-agent.sh` and
            nothing else, so asking once is honest and asking per row would be
            noise. Shown up front rather than behind a press, because running it
            by hand is a legitimate first move - and it is the only move that
            actually takes the agent off a machine Deplo cannot reach. */}
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
