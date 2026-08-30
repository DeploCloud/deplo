"use client";

import * as React from "react";
import { TriangleAlert } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useGraphqlMutation } from "@/lib/use-graphql";
import { toast } from "sonner";
import { CopyButton } from "@/components/shared/copy-button";
import { SettingsShortcut } from "@/components/shared/settings-shortcut";
import { DirtyHint } from "@/components/apps/settings/settings-shared";
import {
  useDatabaseExposure,
  ExposureSwitch,
  ExposurePortRow,
} from "@/components/storage/database-exposure";
import type { DatabaseDTO } from "@/lib/data/databases";

/**
 * How clients reach this database, and the one control worth having on the
 * overview: publishing the port. Settings keeps the same control plus the move.
 */
export function DatabaseNetworkingCard({
  db,
  serverHost,
  canExposePorts,
  canConfigure,
  environmentLabel,
  environments = [],
  serverName,
}: {
  db: DatabaseDTO;
  /** The owning server's address - half of the published endpoint. */
  serverHost: string;
  canExposePorts: boolean;
  canConfigure: boolean;
  /** Where this database lives (`Project / Environment`), or null for the team's
   *  top level. It decides WHICH apps the internal address answers for. */
  environmentLabel?: string | null;
  /** Every Environment of the team - the move lives here, next to the rule. */
  environments?: { id: string; label: string }[];
  /** The owning server. A network lives on one machine, so this is half the rule. */
  serverName: string;
}) {
  const exposure = useDatabaseExposure(db);
  const internal = `${db.host}:${db.port}`;
  // The SAVED state, not the switch: an address you can copy before the save
  // lands is an address that does not answer.
  const published =
    db.exposedPublicly && db.exposedPort && serverHost
      ? `${serverHost}:${db.exposedPort}`
      : null;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Networking</CardTitle>
          <CardDescription>How clients reach this database.</CardDescription>
        </div>
        <SettingsShortcut
          href={`/storage/databases/${db.id}/settings/connection`}
          label="Connection settings"
          className="-mt-1"
        />
      </CardHeader>
      <CardContent className="space-y-4">
        <Address
          label="Internal"
          value={internal}
          hint={
            environmentLabel
              ? `Apps in ${environmentLabel} on ${serverName}, by name.`
              : `Apps outside any project, on ${serverName}, by name.`
          }
        />

        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">Environment</p>
          <div className="mt-1">
            <EnvironmentPicker
              value={db.environmentId ?? null}
              environments={environments}
              canConfigure={canConfigure}
              databaseId={db.id}
              label={environmentLabel ?? "No environment"}
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Only apps here, on {serverName}, reach the internal address. A
            network lives on one machine, so another server never does.
          </p>
        </div>

        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Public</p>
              {published ? (
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                  <code className="truncate font-mono text-sm">
                    {published}
                  </code>
                  <CopyButton value={published} />
                </div>
              ) : (
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Not published
                </p>
              )}
            </div>
            <ExposureSwitch
              checked={exposure.exposed}
              onCheckedChange={exposure.setExposed}
              canExposePorts={canExposePorts}
              canConfigure={canConfigure}
            />
          </div>

          {exposure.exposed && (
            <ExposurePortRow
              exposure={exposure}
              canExposePorts={canExposePorts}
              canConfigure={canConfigure}
            />
          )}

          {/* The port is a bare 0.0.0.0 bind: no proxy, no certificate, and the
              engine password is the only thing in front of it. */}
          {exposure.exposed && (
            <p className="flex items-start gap-2 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-2.5 text-xs">
              <TriangleAlert className="mt-px size-3.5 shrink-0 text-[var(--warning)]" />
              <span>
                Traffic is not encrypted - only the engine password protects it.
              </span>
            </p>
          )}
        </div>
      </CardContent>
      {exposure.dirty && (
        <CardFooter className="justify-between">
          <DirtyHint dirty />
          <Button
            onClick={() => exposure.save()}
            disabled={exposure.pending || !exposure.ready || !canConfigure}
          >
            {exposure.pending ? "Saving" : "Save"}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

function Address({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
        <code className="truncate font-mono text-sm">{value}</code>
        <CopyButton value={value} />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/** The move, where the rule that makes it matter is written. */
function EnvironmentPicker({
  value,
  environments,
  canConfigure,
  databaseId,
  label,
}: {
  value: string | null;
  environments: { id: string; label: string }[];
  canConfigure: boolean;
  databaseId: string;
  label: string;
}) {
  const { run, pending, error } = useGraphqlMutation(/* GraphQL */ `
    mutation ($id: String!, $environmentId: ID) {
      moveDatabaseToEnvironment(id: $id, environmentId: $environmentId)
    }
  `);
  React.useEffect(() => {
    if (error) toast.error(error);
  }, [error]);
  // Nothing to pick between, or no permission: say where it is and stop there.
  if (!canConfigure || environments.length === 0)
    return <p className="truncate text-sm">{label}</p>;
  return (
    <Select
      value={value ?? "none"}
      disabled={pending}
      onValueChange={(next) =>
        void run({
          id: databaseId,
          environmentId: next === "none" ? null : next,
        })
      }
    >
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">No environment</SelectItem>
        {environments.map((e) => (
          <SelectItem key={e.id} value={e.id}>
            {e.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
