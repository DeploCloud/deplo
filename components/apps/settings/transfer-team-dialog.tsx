"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { useRouter } from "next/navigation";
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

type TransferTarget = {
  id: string;
  name: string;
  avatarUrl: string | null;
  serverAvailable: boolean;
  githubFollows: boolean;
};

type TransferInfo = {
  appName: string;
  serverName: string;
  homeLabel: string | null;
  sharedVarCount: number;
  backupCount: number;
  githubConnected: boolean;
  gitConnectionLabel: string | null;
  targets: TransferTarget[];
};

const INFO_QUERY = /* GraphQL */ `
  query ($appId: String!) {
    appTransferInfo(appId: $appId) {
      appName
      serverName
      homeLabel
      sharedVarCount
      backupCount
      githubConnected
      gitConnectionLabel
      targets {
        id
        name
        serverAvailable
        githubFollows
      }
    }
  }
`;

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * Hand this app to another team the viewer belongs to.
 */
export function TransferTeamDialog({
  trigger,
  appId,
  appName,
}: {
  trigger: React.ReactNode;
  appId: string;
  appName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [info, setInfo] = React.useState<TransferInfo | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [teamId, setTeamId] = React.useState("");
  const selectId = React.useId();

  const handleOpenChange = (v: boolean) => {
    // Reset on close so a reopen re-reads the impact (a shared variable may have
    // been linked, a backup scheduled) instead of flashing a stale summary.
    if (!v) {
      setInfo(null);
      setFailed(false);
      setTeamId("");
    }
    setOpen(v);
  };

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    gql<{ appTransferInfo: TransferInfo }>(INFO_QUERY, { appId })
      .then((d) => {
        if (cancelled) return;
        setInfo(d.appTransferInfo);
        // One candidate is the overwhelmingly common case - preselect it so the
        // operator only has to confirm.
        if (d.appTransferInfo.targets.length === 1)
          setTeamId(d.appTransferInfo.targets[0].id);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, appId]);

  const target = info?.targets.find((t) => t.id === teamId) ?? null;
  const blocked = Boolean(target && !target.serverAvailable);
  const loading = open && !info && !failed;

  return (
    <ConfirmAction
      trigger={trigger}
      open={open}
      onOpenChange={handleOpenChange}
      title={`Transfer ${appName} to another team?`}
      description={
        <>
          The app moves with everything it owns - variables, domains, volumes,
          deployment history, and keeps running throughout. Everyone in this
          team loses access to it; from here the move is one-way, only a member
          of the destination team can hand it back.
        </>
      }
      confirmLabel="Transfer app"
      confirmText={appName}
      confirmDisabled={!target || blocked}
      successMessage="App transferred"
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
              Couldn&apos;t load the teams that can take this app. Close this
              and try again.
            </p>
          )}

          {info && info.targets.length === 0 && (
            <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
              You don&apos;t belong to another team that could take this app. A
              destination team needs you as a member with permission to deploy
              in it.
            </p>
          )}

          {info && info.targets.length > 0 && (
            <div className="space-y-2">
              <FieldLabel
                htmlFor={selectId}
                info="Only teams you belong to, and where you may deploy, can receive an app."
                docs="team.overview"
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
              {blocked ? (
                <li className="text-destructive">
                  {target.name} can&apos;t use the server this app runs on (
                  {info.serverName}). An instance admin grants a team access to
                  a server in Settings → Servers.
                </li>
              ) : (
                <>
                  {info.homeLabel && (
                    <li>
                      Leaves its {info.homeLabel} and lands at the top level of{" "}
                      {target.name}.
                    </li>
                  )}
                  {info.sharedVarCount > 0 && (
                    <li>
                      {plural(
                        info.sharedVarCount,
                        "shared variable",
                        "shared variables",
                      )}{" "}
                      stop being injected - they belong to this team. The change
                      applies on the next deploy.
                    </li>
                  )}
                  {info.backupCount > 0 && (
                    <li>
                      {plural(
                        info.backupCount,
                        "backup schedule",
                        "backup schedules",
                      )}{" "}
                      are removed: they write to this team&apos;s storage.
                      Backups already taken stay here.
                    </li>
                  )}
                  {info.githubConnected &&
                    (target.githubFollows ? (
                      <li>
                        The repository stays connected through {target.name}
                        &apos;s own GitHub App.
                      </li>
                    ) : (
                      <li>
                        The repository is disconnected - {target.name} has no
                        GitHub App on that account. Auto-deploy turns off.
                        Reconnect the repository from {target.name}.
                      </li>
                    ))}
                  {info.gitConnectionLabel && (
                    <li>
                      The repository is disconnected - the{" "}
                      {info.gitConnectionLabel} connection belongs to this team.
                      Auto-deploy turns off. Reconnect the repository from{" "}
                      {target.name}.
                    </li>
                  )}
                  <li>
                    The app keeps running on {info.serverName}, nothing is
                    rebuilt or restarted.
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
            mutation ($appId: String!, $teamId: String!) {
              transferAppToTeam(appId: $appId, teamId: $teamId)
            }
          `,
          { appId, teamId },
        );
        // The app is gone from the active team: the settings page it was opened
        // from no longer resolves, so leave for the overview.
        if (res.ok) router.push("/");
        return res;
      }}
    />
  );
}
