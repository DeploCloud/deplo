"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { useRouter } from "next/navigation";
import { Crown, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { InfoTip } from "@/components/ui/info-tip";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";

/** Both actions are outline-destructive: neither is the one you reach for. */
const dangerButton =
  "self-start border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive";

/** A member this team could be handed to. */
export interface TransferCandidate {
  userId: string;
  username: string;
  name: string;
}

/**
 * Settings → General danger zone. `onlyTeam` disables the delete with an
 * explanation: a user must always keep at least one team.
 */
export function TeamDangerZone({
  teamId,
  teamName,
  onlyTeam,
  canDelete,
  sharedVars,
  sharedVarsOtherTeamsUse,
  canTransfer,
  candidates,
  viewerTwoFactorEnabled,
}: {
  teamId: string;
  teamName: string;
  onlyTeam: boolean;
  canDelete: boolean;
  /** Shared variables this team owns - they go with it. */
  sharedVars: number;
  /** How many of those are landing in ANOTHER team's apps right now. */
  sharedVarsOtherTeamsUse: number;
  /** Only the team's primary owner may hand it over (lib/data/team-ownership.ts). */
  canTransfer: boolean;
  candidates: TransferCandidate[];
  viewerTwoFactorEnabled: boolean;
}) {
  const router = useRouter();
  // The one thing on this screen that reaches OUTSIDE the team being deleted.
  const sharedVarsCaveat =
    sharedVarsOtherTeamsUse > 0
      ? ` It also deletes ${sharedVars} shared variable${sharedVars === 1 ? "" : "s"} this team owns, ${sharedVarsOtherTeamsUse} of which ${sharedVarsOtherTeamsUse === 1 ? "is" : "are"} landing in another team's apps right now - ${sharedVarsOtherTeamsUse === 1 ? "it disappears" : "they disappear"} there on their next deploy.`
      : "";

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base text-destructive">
          Danger zone
          <InfoTip
            content="Hand this team to another member, or permanently delete it with its apps, databases and members."
            docs="team.overview"
          />
        </CardTitle>
      </CardHeader>
      <CardContent
        className={cn(
          "grid gap-6",
          canDelete && canTransfer && "md:grid-cols-2",
        )}
      >
        {canTransfer && (
          <TransferOwnership
            candidates={candidates}
            viewerTwoFactorEnabled={viewerTwoFactorEnabled}
          />
        )}
        {canDelete && (
          <div className="flex flex-col justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Delete team</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {onlyTeam
                  ? "You can't delete your only team - create another team first."
                  : "Every app and database stack is torn down (data volumes included). This cannot be undone."}
              </p>
            </div>
            <ConfirmAction
              trigger={
                <Button
                  variant="outline"
                  size="sm"
                  className={dangerButton}
                  disabled={onlyTeam}
                >
                  <Trash2 className="size-4" />
                  Delete team
                </Button>
              }
              title="Delete team?"
              description={`This tears down every app and database of ${teamName} (data volumes included) and permanently removes its folders, projects, domains, environment variables, members and every backup it has stored, wherever it stored it.${sharedVarsCaveat} Cleanup continues in the background. This cannot be undone.`}
              confirmLabel="Delete team"
              successMessage="Team deleted"
              confirmText={teamName}
              onConfirm={async () => {
                // Echo back the id the user confirmed - the server fails closed if
                // the active team changed in another tab meanwhile.
                const res = await gqlAction(
                  `mutation($teamId: String!) { deleteTeam(teamId: $teamId) }`,
                  { teamId },
                );
                if (res.ok) {
                  // The active team is gone - land on the next team's overview.
                  router.push("/");
                  router.refresh();
                }
                return res;
              }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TransferOwnership({
  candidates,
  viewerTwoFactorEnabled,
}: {
  candidates: TransferCandidate[];
  viewerTwoFactorEnabled: boolean;
}) {
  const router = useRouter();
  const [userId, setUserId] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const alone = candidates.length === 0;
  const target = candidates.find((c) => c.userId === userId) ?? null;

  return (
    <div className="flex flex-col justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">Transfer ownership</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {alone
            ? "You're the only member of this team - invite someone first."
            : "Another member becomes the primary owner. You stay an owner, and only they can hand the team back."}
        </p>
      </div>
      <ConfirmAction
        trigger={
          <Button
            variant="outline"
            size="sm"
            className={dangerButton}
            disabled={alone}
          >
            <Crown className="size-4" />
            Transfer ownership
          </Button>
        }
        onOpenChange={(v) => {
          if (!v) {
            setUserId("");
            setPassword("");
            setCode("");
          }
        }}
        title="Transfer ownership?"
        description={
          target
            ? `@${target.username} gets the Owner role and full access to this team, and becomes the one person nobody here can remove, demote or edit. You stay an owner - they can take that away, and only they can hand the team back.`
            : "The member you pick gets the Owner role and full access to this team, and becomes the one person nobody here can remove, demote or edit. You stay an owner - only they can hand the team back."
        }
        confirmLabel="Transfer ownership"
        confirmText={target?.username}
        confirmDisabled={
          !target || !password || (viewerTwoFactorEnabled && !code)
        }
        successMessage="Team ownership transferred"
        extra={
          <div className="grid gap-4">
            <div className="space-y-2">
              <Label htmlFor="transfer-target">New primary owner</Label>
              <Select value={userId} onValueChange={setUserId}>
                <SelectTrigger id="transfer-target" className="w-full">
                  <SelectValue placeholder="Pick a member" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((c) => (
                    <SelectItem key={c.userId} value={c.userId}>
                      {c.name} (@{c.username})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="transfer-password">Your password</Label>
              <Input
                id="transfer-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {/* Only when the account has a second factor: asking everyone for a
                code they may not have is a dead end, not a guard. */}
            {viewerTwoFactorEnabled && (
              <div className="space-y-2">
                <Label htmlFor="transfer-code">
                  Code from your authenticator app
                </Label>
                <Input
                  id="transfer-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </div>
            )}
          </div>
        }
        onConfirm={async () => {
          const res = await gqlAction(
            `mutation ($userId: String!, $password: String!, $code: String) {
              transferTeamOwnership(userId: $userId, password: $password, code: $code)
            }`,
            { userId, password, code: code || null },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </div>
  );
}
