"use client";

import * as React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TeamAvatar } from "@/components/shared/user-avatar";
import { FieldLabel } from "@/components/ui/info-tip";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gql, gqlAction } from "@/lib/graphql-client";
import { joinNames, plural } from "@/lib/utils";

type Target = {
  id: string;
  name: string;
  avatarUrl: string | null;
  serverAvailable: boolean;
  nameTaken: boolean;
};

type Info = {
  databaseName: string;
  serverName: string;
  environmentName: string | null;
  backupCount: number;
  cronCount: number;
  usedBy: string[];
  running: boolean;
  targets: Target[];
};

const INFO_QUERY = /* GraphQL */ `
  query ($id: String!) {
    databaseTransferInfo(id: $id) {
      databaseName
      serverName
      environmentName
      backupCount
      cronCount
      usedBy
      running
      targets {
        id
        name
        avatarUrl
        serverAvailable
        nameTaken
      }
    }
  }
`;

export function TransferDatabaseDialog({
  trigger,
  open: controlledOpen,
  onOpenChange,
  databaseId,
  databaseName,
  onTransferred,
}: {
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  databaseId: string;
  databaseName: string;
  onTransferred: () => void;
}) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const open = controlledOpen ?? internalOpen;
  const [info, setInfo] = React.useState<Info | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [teamId, setTeamId] = React.useState("");
  const selectId = React.useId();

  const handleOpenChange = (v: boolean) => {
    if (!v) {
      setInfo(null);
      setFailed(false);
      setTeamId("");
    }
    setInternalOpen(v);
    onOpenChange?.(v);
  };

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    gql<{ databaseTransferInfo: Info }>(INFO_QUERY, { id: databaseId })
      .then((d) => {
        if (cancelled) return;
        setInfo(d.databaseTransferInfo);
        if (d.databaseTransferInfo.targets.length === 1)
          setTeamId(d.databaseTransferInfo.targets[0].id);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, databaseId]);

  const target = info?.targets.find((t) => t.id === teamId) ?? null;
  const blocked = Boolean(
    target && (!target.serverAvailable || target.nameTaken),
  );
  const loading = open && !info && !failed;
  const usedBy = info?.usedBy ?? [];

  return (
    <ConfirmAction
      trigger={trigger}
      open={open}
      onOpenChange={handleOpenChange}
      title={`Transfer ${databaseName} to another team?`}
      description={
        <>
          Its data and connection string go with it.{" "}
          <strong>Only the new team can hand it back.</strong>
        </>
      }
      consequence={
        usedBy.length > 0
          ? `${joinNames(usedBy)} in this team will stop reaching it.`
          : "This team loses access to it."
      }
      confirmLabel="Transfer database"
      confirmText={databaseName}
      confirmDisabled={!target || blocked}
      successMessage="Database transferred"
      extra={
        <div className="grid gap-3">
          {loading && (
            <div className="grid gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-9 w-full" />
            </div>
          )}

          {failed && (
            <p className="text-sm text-muted-foreground">
              Couldn&apos;t load the teams that can take this database. Close
              this and try again.
            </p>
          )}

          {info && info.targets.length === 0 && (
            <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
              You don&apos;t belong to another team that could take this
              database. You need permission to move databases there too.
            </p>
          )}

          {info && info.targets.length > 0 && (
            <div className="space-y-2">
              <FieldLabel
                htmlFor={selectId}
                info="Only teams you belong to, and where you may move databases, can receive one."
                docs="databases.lifecycle"
              >
                Destination team
              </FieldLabel>
              <Select value={teamId} onValueChange={setTeamId}>
                <SelectTrigger id={selectId} className="w-full">
                  <SelectValue placeholder="Pick a team" />
                </SelectTrigger>
                <SelectContent>
                  {info.targets.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      <span className="flex items-center gap-2">
                        <TeamAvatar
                          name={t.name}
                          avatarUrl={t.avatarUrl}
                          size="sm"
                        />
                        {t.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {info && target && (
            <ul className="grid gap-1.5 rounded-lg border border-border p-3 text-xs text-muted-foreground">
              {!target.serverAvailable ? (
                <li className="text-destructive">
                  {target.name} can&apos;t use the server this database runs on
                  ({info.serverName}). An instance admin grants a team access to
                  a server in Settings → Servers.
                </li>
              ) : target.nameTaken ? (
                <li className="text-destructive">
                  {target.name} already has a database named {info.databaseName}
                  . Rename one of them first.
                </li>
              ) : (
                <>
                  {info.environmentName && (
                    <li>
                      Leaves the {info.environmentName} environment and lands at
                      the top level of {target.name}.
                    </li>
                  )}
                  {info.backupCount > 0 && (
                    <li>
                      {plural(
                        info.backupCount,
                        "backup schedule is",
                        "backup schedules are",
                      )}{" "}
                      removed: they write to this team&apos;s storage. Backups
                      already taken stay here.
                    </li>
                  )}
                  {info.cronCount > 0 && (
                    <li>
                      {plural(info.cronCount, "cron job is", "cron jobs are")}{" "}
                      removed.
                    </li>
                  )}
                  <li>
                    {info.running
                      ? `It restarts briefly on ${target.name}'s network; its data stays on ${info.serverName}.`
                      : `It stays stopped, on ${info.serverName}, with its data.`}
                  </li>
                </>
              )}
            </ul>
          )}
        </div>
      }
      onConfirm={async () => {
        const res = await gqlAction(
          /* GraphQL */ `
            mutation ($id: String!, $teamId: String!) {
              transferDatabaseToTeam(id: $id, teamId: $teamId)
            }
          `,
          { id: databaseId, teamId },
        );
        if (res.ok) onTransferred();
        return res;
      }}
    />
  );
}
