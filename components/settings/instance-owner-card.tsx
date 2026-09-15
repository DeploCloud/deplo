"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { useRouter } from "@/lib/nav";
import { Crown } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UserAvatar } from "@/components/shared/user-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RevealInput } from "@/components/ui/password-field";
import { Label } from "@/components/ui/label";
import { Combobox } from "@/components/shared/combobox";
import { InfoTip } from "@/components/ui/info-tip";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";

export type OwnerCandidate = {
  userId: string;
  username: string;
  avatarColor: string;
  avatarUrl: string | null;
};

export function InstanceOwnerCard({
  ownerName,
  viewerIsOwner,
  viewerTwoFactorEnabled,
  candidates,
}: {
  ownerName: string | null;
  viewerIsOwner: boolean;
  viewerTwoFactorEnabled: boolean;
  candidates: OwnerCandidate[];
}) {
  const router = useRouter();
  const [successor, setSuccessor] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [confirm, setConfirm] = React.useState(false);

  const picked = candidates.find((c) => c.userId === successor) ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          <Crown className="size-4" />
          Instance owner
          <InfoTip
            content="The owner is the one account no other admin can demote, suspend or delete. Only they can hand the instance to someone else."
            docs="instance.owner"
          />
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          {ownerName ? (
            <>
              This instance belongs to{" "}
              <span className="font-medium text-foreground">{ownerName}</span>.
            </>
          ) : (
            "Nobody owns this instance yet."
          )}
        </p>
      </CardHeader>
      <CardContent>
        {!viewerIsOwner ? (
          <p className="text-sm text-muted-foreground">
            Only the owner can hand the instance over.
          </p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            There is no other instance admin to hand it to.{" "}
            <Link
              href="/settings/users"
              className="underline underline-offset-4 hover:text-foreground"
            >
              Make someone an admin first
            </Link>
            .
          </p>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1 space-y-2">
              <Label htmlFor="instance-successor">Hand it to</Label>
              <Combobox<OwnerCandidate>
                id="instance-successor"
                items={candidates}
                value={successor}
                onChange={setSuccessor}
                getKey={(c) => c.userId}
                matches={(c, q) => c.username.toLowerCase().includes(q)}
                displayValue={(c) => `@${c.username}`}
                placeholder="Pick an instance admin"
                searchPlaceholder="Search admins"
                emptyLabel={(hasItems) =>
                  hasItems ? "No admin matches that" : "No other instance admin"
                }
                renderLeading={(c) => (
                  <UserAvatar
                    username={c.username}
                    avatarUrl={c.avatarUrl}
                    size="sm"
                  />
                )}
                renderOption={(c) => (
                  <span className="flex items-center gap-2">
                    <UserAvatar
                      username={c.username}
                      avatarUrl={c.avatarUrl}
                      size="sm"
                    />
                    @{c.username}
                  </span>
                )}
              />
            </div>
            <Button
              variant="destructive"
              disabled={!picked}
              onClick={() => setConfirm(true)}
            >
              Transfer ownership
            </Button>
          </div>
        )}
      </CardContent>

      {confirm && picked && (
        <ConfirmAction
          open={confirm}
          onOpenChange={(v) => {
            setConfirm(v);
            if (!v) {
              setPassword("");
              setCode("");
            }
          }}
          title={`Make @${picked.username} the instance owner?`}
          description={
            <>
              <strong>@{picked.username}</strong> becomes the only person who
              can edit their own account or transfer ownership.
            </>
          }
          consequence="You stay an instance admin, but they can demote you, and only they can give the crown back."
          confirmLabel="Transfer ownership"
          confirmText={picked.username}
          successMessage="Instance ownership transferred"
          extra={
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="transfer-password">Your password</Label>
                <RevealInput
                  id="transfer-password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
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
                transferInstanceOwner(userId: $userId, password: $password, code: $code)
              }`,
              { userId: picked.userId, password, code: code || null },
            );
            if (res.ok) {
              setSuccessor("");
              router.refresh();
            }
            return res;
          }}
        />
      )}
    </Card>
  );
}
