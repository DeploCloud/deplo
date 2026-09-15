"use client";

import {
  AlertTriangle,
  Ban,
  Fingerprint,
  ShieldOff,
  Trash2,
  UserCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DeleteUserDialog } from "@/components/settings/delete-user-dialog";
import type { ActionResult } from "@/lib/result";
import { ActionRow, Section } from "./section-shell";

export function SecondFactorsSection({
  pending,
  onRemovePasskeys,
}: {
  pending: boolean;
  onRemovePasskeys: () => void;
}) {
  return (
    <Section icon={ShieldOff} title="Second factors">
      <ActionRow
        title="Remove passkeys"
        info="For someone whose device is gone. Until it is removed, a dead passkey still satisfies their team's two-factor policy."
        docs="team.passkeys"
        action={
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={onRemovePasskeys}
          >
            <Fingerprint className="size-4" />
            Remove
          </Button>
        }
      />
    </Section>
  );
}

export function DangerZone({
  suspended,
  twoFactorEnabled,
  pending,
  onResetTwoFactor,
  onSuspend,
  onReactivate,
  onDelete,
}: {
  suspended: boolean;
  twoFactorEnabled: boolean;
  pending: boolean;
  onResetTwoFactor: () => void;
  onSuspend: () => void;
  onReactivate: () => void;
  onDelete: () => void;
}) {
  return (
    <Section
      icon={AlertTriangle}
      title="Danger zone"
      tone="destructive"
      info="Unlike everything above, these apply the moment you confirm them - they don't wait for Save changes."
      docs="instance.users"
    >
      {twoFactorEnabled && (
        <ActionRow
          title="Reset two-factor"
          info="For someone who lost their phone and their recovery codes. Their account goes back to password only."
          docs="team.twoFactor"
          action={
            <Button
              variant="outline"
              size="sm"
              className="border-destructive/40 text-destructive hover:bg-destructive-wash-strong hover:text-destructive"
              disabled={pending}
              onClick={onResetTwoFactor}
            >
              <ShieldOff className="size-4" />
              Reset
            </Button>
          }
        />
      )}
      <ActionRow
        title={suspended ? "Reactivate account" : "Suspend account"}
        info={
          suspended
            ? "Let this person sign in again. Everything they had is still there."
            : "Signs them out and blocks sign-in. Teams, apps and data are all kept, and you can undo it here at any time."
        }
        docs="instance.users"
        action={
          suspended ? (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={onReactivate}
            >
              <UserCheck className="size-4" />
              Reactivate
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="border-destructive/40 text-destructive hover:bg-destructive-wash-strong hover:text-destructive"
              disabled={pending}
              onClick={onSuspend}
            >
              <Ban className="size-4" />
              Suspend
            </Button>
          )
        }
      />
      <ActionRow
        title="Delete account"
        info="Permanently removes this person and, if you say so, what they own. There is no undo; suspending is the reversible answer."
        docs="instance.users"
        action={
          <Button
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={onDelete}
          >
            <Trash2 className="size-4" />
            Delete
          </Button>
        }
      />
    </Section>
  );
}

export function AccountConfirmDialogs({
  userId,
  username,
  passkeyCount,
  confirmSuspend,
  onConfirmSuspendChange,
  onSuspend,
  confirmResetTwoFactor,
  onConfirmResetTwoFactorChange,
  onResetTwoFactor,
  confirmResetPasskeys,
  onConfirmResetPasskeysChange,
  onResetPasskeys,
  confirmDelete,
  onConfirmDeleteChange,
  onDeleted,
}: {
  userId: string;
  username: string;
  passkeyCount: number;
  confirmSuspend: boolean;
  onConfirmSuspendChange: (v: boolean) => void;
  onSuspend: () => Promise<ActionResult<unknown>>;
  confirmResetTwoFactor: boolean;
  onConfirmResetTwoFactorChange: (v: boolean) => void;
  onResetTwoFactor: () => Promise<ActionResult<unknown>>;
  confirmResetPasskeys: boolean;
  onConfirmResetPasskeysChange: (v: boolean) => void;
  onResetPasskeys: () => Promise<ActionResult<unknown>>;
  confirmDelete: boolean;
  onConfirmDeleteChange: (v: boolean) => void;
  onDeleted: () => void;
}) {
  return (
    <>
      <ConfirmAction
        open={confirmSuspend}
        onOpenChange={onConfirmSuspendChange}
        title={`Suspend @${username}?`}
        description="They are signed out immediately and can't sign back in until you reactivate them."
        consequence="Their teams, apps and everything they own are kept - nothing is deleted."
        confirmLabel="Suspend account"
        successMessage="Account suspended"
        onConfirm={onSuspend}
      />
      <ConfirmAction
        open={confirmResetTwoFactor}
        onOpenChange={onConfirmResetTwoFactorChange}
        title={`Reset two-factor for @${username}?`}
        description="Their authenticator and recovery codes stop working, and the next sign-in is password only."
        consequence="Check it is really them asking."
        confirmLabel="Reset two-factor"
        successMessage="Two-factor reset"
        optimistic
        onConfirm={onResetTwoFactor}
      />
      <ConfirmAction
        open={confirmResetPasskeys}
        onOpenChange={onConfirmResetPasskeysChange}
        title={
          passkeyCount === 1
            ? `Remove @${username}'s passkey?`
            : `Remove @${username}'s ${passkeyCount} passkeys?`
        }
        description="They stop signing in with any device they registered, and their account goes back to password only."
        consequence="Do this when the device is gone - check it is really them asking."
        confirmLabel="Remove passkeys"
        variant="default"
        successMessage="Passkeys removed"
        optimistic
        onConfirm={onResetPasskeys}
      />
      {confirmDelete && (
        <DeleteUserDialog
          userId={userId}
          username={username}
          open={confirmDelete}
          onOpenChange={onConfirmDeleteChange}
          onDeleted={onDeleted}
        />
      )}
    </>
  );
}
