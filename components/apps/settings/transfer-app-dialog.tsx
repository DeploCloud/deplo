"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRightLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";

interface TransferTarget {
  id: string;
  name: string;
  serverAvailable: boolean;
  githubFollows: boolean;
}

interface TransferInfo {
  serverName: string;
  homeLabel: string | null;
  sharedVarCount: number;
  backupCount: number;
  githubConnected: boolean;
  targets: TransferTarget[];
}

const INFO_QUERY = /* GraphQL */ `
  query ($appId: String!) {
    appTransfer(appId: $appId) {
      serverName
      homeLabel
      sharedVarCount
      backupCount
      githubConnected
      targets {
        id
        name
        serverAvailable
        githubFollows
      }
    }
  }
`;

/**
 * Hand this app to another team (Danger Zone → Transfer).
 *
 * The dialog's whole job is to make an irreversible-from-here move legible
 * BEFORE it happens: it loads, in one round trip, the teams that could take the
 * app and exactly what the app leaves behind — its folder/project, its
 * shared-variable links, its backup schedules, and (unless the destination team
 * has its own installation for the same account) its GitHub connection. What is
 * NOT lost gets said out loud too, because it is the question everyone asks
 * first: the containers are keyed by slug, so the app keeps serving the same
 * URLs throughout.
 *
 * A destination whose team can't target the app's server is offered but refused
 * with the reason spelled out — a silently missing row would read as a bug.
 */
export function TransferAppDialog({
  appId,
  appName,
  appSlug,
}: {
  appId: string;
  appName: string;
  /** Typed to confirm — the app is gone from this team once this lands. */
  appSlug: string;
}) {
  const router = useRouter();
  const [info, setInfo] = React.useState<TransferInfo | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [teamId, setTeamId] = React.useState<string>("");
  const [error, setError] = React.useState<string | null>(null);
  const selectId = React.useId();

  // Load on first open (and after a failed load, so a hiccup is retryable by
  // reopening) — never on mount: most visits to Advanced never open this.
  function onOpenChange(open: boolean) {
    if (!open) return;
    if (info || loading) return;
    setLoading(true);
    setError(null);
    void gqlAction<{ appTransfer: TransferInfo }, TransferInfo>(
      INFO_QUERY,
      { appId },
      (d) => d.appTransfer,
    ).then((res) => {
      setLoading(false);
      if (res.ok && res.data) setInfo(res.data);
      else if (!res.ok) setError(res.error);
    });
  }

  const target = info?.targets.find((t) => t.id === teamId) ?? null;
  const blocked = Boolean(target && !target.serverAvailable);
  const noTargets = Boolean(info && info.targets.length === 0);

  return (
    <ConfirmAction
      trigger={
        <Button variant="outline" size="sm">
          <ArrowRightLeft className="size-4" />
          Transfer
        </Button>
      }
      onOpenChange={onOpenChange}
      title={`Transfer ${appName}?`}
      description={
        <>
          The app moves to another team with its variables, domains, deployments
          and volumes. It keeps running on the same URLs — but it leaves this
          team for good, and only the new team can move it back.
        </>
      }
      confirmLabel="Transfer app"
      successMessage="App transferred"
      confirmText={appSlug}
      confirmDisabled={loading || !teamId || blocked || noTargets}
      extra={
        <div className="space-y-3">
          {loading && <Skeleton className="h-9 w-full" />}

          {error && <p className="text-sm text-destructive">{error}</p>}

          {noTargets && (
            <p className="text-sm text-muted-foreground">
              You are not a member of another team that could take this app. A
              team can only receive an app if you belong to it and can deploy
              there.
            </p>
          )}

          {info && info.targets.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor={selectId}>Destination team</Label>
              <Select value={teamId} onValueChange={setTeamId}>
                <SelectTrigger id={selectId}>
                  <SelectValue placeholder="Pick a team" />
                </SelectTrigger>
                <SelectContent>
                  {info.targets.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {blocked && target && (
            <p className="flex gap-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                {target.name} can&apos;t use this app&apos;s server (
                {info?.serverName}), so the app can&apos;t move there. An
                instance admin grants a team access in Settings → Servers.
              </span>
            </p>
          )}

          {info && !blocked && (
            <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
              {info.homeLabel && <li>It leaves {info.homeLabel}.</li>}
              {info.sharedVarCount > 0 && (
                <li>
                  {info.sharedVarCount} shared{" "}
                  {info.sharedVarCount === 1
                    ? "variable stops"
                    : "variables stop"}{" "}
                  being injected — they belong to this team. Its own variables
                  travel with it.
                </li>
              )}
              {info.backupCount > 0 && (
                <li>
                  {info.backupCount} backup{" "}
                  {info.backupCount === 1 ? "schedule is" : "schedules are"}{" "}
                  removed — they write to this team&apos;s storage. Past backups
                  stay here.
                </li>
              )}
              {info.githubConnected && target && !target.githubFollows && (
                <li className="text-destructive">
                  {target.name} has no GitHub App for this repository, so the
                  connection is cut and auto-deploy switches off. Reconnect the
                  repository from that team afterwards.
                </li>
              )}
              {info.githubConnected && target?.githubFollows && (
                <li>
                  The GitHub connection follows: {target.name} has its own App
                  installed for this repository.
                </li>
              )}
              <li>
                The container is not restarted. These changes reach the running
                stack on the next deploy.
              </li>
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
        // The app now belongs to another team, so this page reads as "not found"
        // for the active one — leave before it renders that.
        if (res.ok) router.push("/");
        return res;
      }}
    />
  );
}
