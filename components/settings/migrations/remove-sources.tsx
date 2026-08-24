"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { DownloadCloud } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/shared/confirm-action";
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

  // Read on mount rather than passed as a prop: this component has two homes (the
  // wizard's last step and the report page opened days later), and in the first
  // one the sources are created by the very run that is finishing.
  const load = React.useCallback(async (): Promise<Source[]> => {
    try {
      const data = await gql<{ servers: Source[] | null }>(SOURCES);
      return (data.servers ?? []).filter(
        (s) => s.role === "import" && s.uninstallError,
      );
    } catch {
      // The report is worth reading on its own; a failed side query must not
      // take it down.
      return [];
    }
  }, []);

  React.useEffect(() => {
    let live = true;
    void load().then((rows) => {
      if (live) setSources(rows);
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
        failures.push(`${s.name}: ${res.data?.error ?? "the agent is still installed"}`);
    }
    setSources(await load());
    router.refresh();
    if (failures.length > 0) {
      // Named, one by one: "some of them failed" is not something anyone can act
      // on. Each one stays in Settings → Servers with its own uninstall command.
      for (const f of failures) toast.error(f);
      return { ok: false as const, error: `${failures.length} could not be removed` };
    }
    return { ok: true as const, data: null };
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
              ? "Deplo tried three times to take its agent off the machine it imported from, and could not. Try again once that machine is reachable."
              : "Deplo tried three times to take its agent off the machines it imported from, and could not. Try again once they are reachable."}
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
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
