"use client";

import * as React from "react";
import { Server as ServerIcon } from "lucide-react";
import {
  Card,
  CardContent,
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
import { InfoTip } from "@/components/ui/info-tip";
import { DatabaseConnectionString } from "@/components/storage/database-connection-string";
import {
  useDatabaseExposure,
  ExposureSwitch,
  ExposurePortRow,
} from "@/components/storage/database-exposure";
import { DB_NAMES, ENGINE_CREDS } from "@/components/storage/db-engines";
import { timeAgoShort } from "@/lib/utils";
import type { DatabaseDTO } from "@/lib/data/databases/rows";

export function DatabaseConnectionCard({
  db,
  serverHost,
  serverName,
  canReveal,
  canConfigure,
  canExposePorts,
  environmentLabel,
  environments = [],
}: {
  db: DatabaseDTO;
  serverHost: string;
  serverName: string;
  canReveal: boolean;
  canConfigure: boolean;
  canExposePorts: boolean;
  environmentLabel?: string | null;
  environments?: { id: string; label: string }[];
}) {
  const exposure = useDatabaseExposure(db);
  const creds = ENGINE_CREDS[db.type];
  const internal = `${db.host}:${db.port}`;
  const published =
    db.exposedPublicly && db.exposedPort && serverHost
      ? `${serverHost}:${db.exposedPort}`
      : null;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <CardTitle className="text-base">Connection</CardTitle>
        <SettingsShortcut
          href={`/storage/databases/${db.id}/settings/connection`}
          label="Connection settings"
          className="-mt-1"
        />
      </CardHeader>
      <CardContent className="space-y-5">
        <DatabaseConnectionString
          id={db.id}
          masked={db.connectionStringMasked}
          canReveal={canReveal}
        />

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="min-w-0">
            <AddressLabel
              label="Internal"
              info={`Apps ${environmentLabel ? `in ${environmentLabel}` : "outside any project"} on ${serverName} reach it by name. A network lives on one machine, so another server never does.`}
            />
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
              <code className="truncate font-mono text-sm">{internal}</code>
              <CopyButton value={internal} />
            </div>
          </div>

          <div className="min-w-0 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <AddressLabel
                  label="Public"
                  warning={
                    exposure.exposed
                      ? "Traffic is not encrypted - only the engine password protects it."
                      : undefined
                  }
                />
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
          </div>
        </div>

        <dl className="grid grid-cols-2 items-start gap-x-6 gap-y-4 border-t border-border pt-4 text-sm lg:grid-cols-3">
          <Field label="Engine">
            {DB_NAMES[db.type] ?? db.type} · v{db.version}
          </Field>
          {creds.username && (
            <Field label="Username">
              <code className="font-mono text-xs">{db.username}</code>
            </Field>
          )}
          {creds.dbName && (
            <Field label="Database">
              <code className="font-mono text-xs">{db.dbName}</code>
            </Field>
          )}
          <Field label="Server">
            <span className="flex items-center gap-1">
              <ServerIcon className="size-3.5 text-muted-foreground" />
              {serverName}
            </span>
          </Field>
          <Field
            label="Environment"
            info={`Only apps here, on ${serverName}, reach the internal address.`}
          >
            <EnvironmentPicker
              value={db.environmentId ?? null}
              environments={environments}
              canConfigure={canConfigure}
              databaseId={db.id}
              label={environmentLabel ?? "No environment"}
            />
          </Field>
          <Field label="Created">{timeAgoShort(db.createdAt)}</Field>
        </dl>
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

function AddressLabel({
  label,
  info,
  warning,
}: {
  label: string;
  info?: string;
  warning?: string;
}) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {label}
      {info && <InfoTip content={info} side="right" />}
      {warning && (
        <InfoTip
          tone="warning"
          side="right"
          label="Encryption warning"
          content={warning}
        />
      )}
    </p>
  );
}

function Field({
  label,
  info,
  children,
}: {
  label: string;
  info?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {label}
        {info && <InfoTip content={info} side="right" />}
      </dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

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
      <SelectTrigger className="mt-1 h-8 w-full">
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
