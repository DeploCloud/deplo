"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { useRouter } from "@/lib/nav";
import { Crown } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UserAvatar } from "@/components/shared/user-avatar";
import { Button } from "@/components/ui/button";
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

/**
 * Who owns this instance, and the one place ownership changes hands.
 */
export function InstanceOwnerCard({
  ownerName,
  viewerIsOwner,
  candidates,
}: {
  /** The current owner's display name, or null on an unowned instance. */
  ownerName: string | null;
  viewerIsOwner: boolean;
  /** Active instance admins who could take it. Empty is a real state. */
  candidates: OwnerCandidate[];
}) {
  const router = useRouter();
  const [successor, setSuccessor] = React.useState("");
  const [password, setPassword] = React.useState("");
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
          // Nothing to offer the crown to: the server would refuse a transfer to
          // a non-admin, so say what to do instead of showing an empty picker.
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
              {/* Typed, not picked: an instance with many admins is a list to
                  scroll, and the name is the thing the operator already knows. */}
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
            if (!v) setPassword("");
          }}
          title={`Make @${picked.username} the instance owner?`}
          description="They become the only person who can edit their own account, transfer ownership, or be locked out of nothing. You stay an instance admin - but they can demote you, and only they can give the crown back."
          confirmLabel="Transfer ownership"
          confirmText={picked.username}
          successMessage="Instance ownership transferred"
          extra={
            <div className="space-y-2">
              <Label htmlFor="transfer-password">Your password</Label>
              <RevealInput
                id="transfer-password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          }
          onConfirm={async () => {
            const res = await gqlAction(
              `mutation ($userId: String!, $password: String!) {
                transferInstanceOwner(userId: $userId, password: $password)
              }`,
              { userId: picked.userId, password },
            );
            // The crown moved: this viewer is no longer the owner, so the card
            // has to re-render as the read-only half rather than keep offering
            // a transfer it can no longer perform.
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
