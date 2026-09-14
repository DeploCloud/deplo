"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PasswordField } from "@/components/ui/password-field";
import { passwordMeetsPolicy } from "@/lib/password-policy";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import type { UserDetailDTO } from "@/lib/data/members/instance-users";
import { AccountHeader, AccountMeta } from "./account-header";
import {
  AccountConfirmDialogs,
  DangerZone,
  SecondFactorsSection,
} from "./danger-zone";
import { EditorSkeleton } from "./editor-skeleton";
import { PermissionsSection } from "./permissions-section";
import { Section } from "./section-shell";

// EditUserSeedUser - header/identity seed, the minimum any caller already has.
export interface EditUserSeedUser {
  userId: string;
  username: string;
  name: string;
  avatarColor: string;
  avatarUrl: string | null;
}

// EditUserSeedFlags - optional instant-render seed of the editable global flags.
export interface EditUserSeedFlags {
  isInstanceAdmin: boolean;
  isInstanceOwner: boolean;
  suspended: boolean;
  canExposePorts: boolean;
  canMountHostVolumes: boolean;
  createdAt: string;
  teamCount: number;
}

interface Grants {
  isInstanceAdmin: boolean;
  canExposePorts: boolean;
  canMountHostVolumes: boolean;
}

const UPDATE_USER = /* GraphQL */ `
  mutation ($input: UpdateUserAdminInput!) {
    updateUserAdmin(input: $input) {
      userId
    }
  }
`;

// UserAccountSettings - the instance-admin editor for ONE user's global account.
export function UserAccountSettings({
  user,
  seed,
  isSelf,
  showHeader = true,
  onCancel,
  onSaved,
  onDeleted,
}: {
  user: EditUserSeedUser;
  // Present ⇒ render immediately; absent ⇒ fetch then render.
  seed?: EditUserSeedFlags;
  isSelf: boolean;
  // Draw the avatar + name + state badges; a page with a header of its own passes false.
  showHeader?: boolean;
  onCancel?: () => void;
  onSaved?: () => void;
  onDeleted?: () => void;
}) {
  const router = useRouter();
  // Email and the team list are never in a list row, so they are always fetched.
  const [detail, setDetail] = React.useState<UserDetailDTO | null>(null);
  const [pending, startTransition] = React.useTransition();

  // Staged form state - committed by "Save changes".
  const [admin, setAdmin] = React.useState(seed?.isInstanceAdmin ?? false);
  const [exposePorts, setExposePorts] = React.useState(
    seed?.canExposePorts ?? false,
  );
  const [mountHostVolumes, setMountHostVolumes] = React.useState(
    seed?.canMountHostVolumes ?? false,
  );
  const [password, setPassword] = React.useState("");

  // Server truth: `suspended` is NOT a form field, the danger zone applies it
  // immediately, so this only ever mirrors what the server confirmed.
  const [suspended, setSuspended] = React.useState(seed?.suspended ?? false);
  const [savedGrants, setSavedGrants] = React.useState<Grants>({
    isInstanceAdmin: seed?.isInstanceAdmin ?? false,
    canExposePorts: seed?.canExposePorts ?? false,
    canMountHostVolumes: seed?.canMountHostVolumes ?? false,
  });

  const [confirmSuspend, setConfirmSuspend] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [confirmResetTwoFactor, setConfirmResetTwoFactor] =
    React.useState(false);
  const [confirmResetPasskeys, setConfirmResetPasskeys] = React.useState(false);
  const [twoFactorEnabled, setTwoFactorEnabled] = React.useState(false);
  const [passkeyCount, setPasskeyCount] = React.useState(0);
  const [advancedOpen, setAdvancedOpen] = React.useState(
    Boolean(seed?.canExposePorts || seed?.canMountHostVolumes),
  );
  // A boolean, not the inline-rebuilt `seed` object, so it is safe both as an
  // effect dependency and read during render.
  const hasSeed = seed != null;

  React.useEffect(() => {
    let cancelled = false;
    gqlAction<{ userDetail: UserDetailDTO }, UserDetailDTO>(
      `query ($userId: String!) {
        userDetail(userId: $userId) {
          userId
          username
          name
          email
          avatarColor
          avatarUrl
          createdAt
          isInstanceAdmin
          isInstanceOwner
          suspended
          canExposePorts
          canMountHostVolumes
          twoFactorEnabled
          passkeyCount
          teams { teamId teamName teamAvatarUrl role }
        }
      }`,
      { userId: user.userId },
      (d) => d.userDetail,
    ).then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) {
        setDetail(res.data);
        // The fetch is the freshest truth there is, so it always refreshes the
        // server-side baseline (a seeded list row can be minutes old)…
        setSavedGrants({
          isInstanceAdmin: res.data.isInstanceAdmin,
          canExposePorts: res.data.canExposePorts,
          canMountHostVolumes: res.data.canMountHostVolumes,
        });
        setSuspended(res.data.suspended);
        setTwoFactorEnabled(res.data.twoFactorEnabled);
        setPasskeyCount(res.data.passkeyCount);
        // …but it seeds the FORM only when the caller had nothing to seed it
        // with, never clobber a switch the admin just flipped.
        if (!hasSeed) {
          setAdmin(res.data.isInstanceAdmin);
          setExposePorts(res.data.canExposePorts);
          setMountHostVolumes(res.data.canMountHostVolumes);
          if (res.data.canExposePorts || res.data.canMountHostVolumes)
            setAdvancedOpen(true);
        }
      } else if (!res.ok) {
        toast.error(res.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [user.userId, hasSeed]);

  const ready = hasSeed || detail != null;
  const createdAt = seed?.createdAt ?? detail?.createdAt ?? null;
  const teams = detail?.teams ?? null;
  const teamCount = teams?.length ?? seed?.teamCount ?? 0;

  // The instance owner's account is editable only by the owner themselves, no other
  // admin may demote, suspend, reset or delete them, because all of those are routes
  // to the same takeover (see lib/data/instance-owner.ts).
  const isOwner = seed?.isInstanceOwner ?? detail?.isInstanceOwner ?? false;
  const ownerLocked = isOwner && !isSelf;
  // Ownership leaves only through a transfer that names a successor.
  const ownerFlagsLocked = isOwner;
  // Suspending and deleting are refused for your own account and for the owner's.
  const showDanger = !isSelf && !isOwner;

  const dirty =
    admin !== savedGrants.isInstanceAdmin ||
    exposePorts !== savedGrants.canExposePorts ||
    mountHostVolumes !== savedGrants.canMountHostVolumes ||
    password.length > 0;

  function commit(patch: {
    grants?: Grants;
    suspended?: boolean;
    newPassword?: string;
  }) {
    const grants = patch.grants ?? savedGrants;
    return gqlAction<
      { updateUserAdmin: { userId: string } },
      { userId: string }
    >(
      UPDATE_USER,
      {
        input: {
          userId: user.userId,
          isInstanceAdmin: grants.isInstanceAdmin,
          canExposePorts: grants.canExposePorts,
          canMountHostVolumes: grants.canMountHostVolumes,
          suspended: patch.suspended ?? suspended,
          newPassword: patch.newPassword || undefined,
        },
      },
      (d) => d.updateUserAdmin,
    );
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const grants: Grants = {
        isInstanceAdmin: admin,
        canExposePorts: exposePorts,
        canMountHostVolumes: mountHostVolumes,
      };
      const res = await commit({ grants, newPassword: password || undefined });
      if (res.ok) {
        setSavedGrants(grants);
        setPassword("");
        toast.success("User updated");
        onSaved?.();
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  async function resetTwoFactor() {
    setTwoFactorEnabled(false);
    const res = await gqlAction<
      { resetUserTwoFactor: { userId: string } },
      { userId: string }
    >(
      `mutation ($userId: String!) {
        resetUserTwoFactor(userId: $userId) { userId }
      }`,
      { userId: user.userId },
      (d) => d.resetUserTwoFactor,
    );
    if (!res.ok) {
      setTwoFactorEnabled(true);
      router.refresh();
      return { ok: false as const, error: res.error };
    }
    router.refresh();
    return { ok: true as const };
  }

  async function resetPasskeys() {
    const before = passkeyCount;
    setPasskeyCount(0);
    const res = await gqlAction(
      `mutation ($userId: String!) {
        resetUserPasskeys(userId: $userId) { userId }
      }`,
      { userId: user.userId },
    );
    if (!res.ok) {
      setPasskeyCount(before);
      router.refresh();
      return { ok: false as const, error: res.error };
    }
    router.refresh();
    return { ok: true as const };
  }

  // Reactivating is safe, so it applies on the spot - no confirm to sit through.
  function reactivate() {
    startTransition(async () => {
      const res = await commit({ suspended: false });
      if (res.ok) {
        setSuspended(false);
        toast.success("Account reactivated");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <>
      {showHeader && (
        <AccountHeader
          user={user}
          isOwner={isOwner}
          isAdmin={savedGrants.isInstanceAdmin}
          suspended={suspended}
          email={detail?.email}
        />
      )}

      <form className="grid gap-4" onSubmit={onSubmit}>
        {!ready ? (
          // `isSelf` is a prop, so the one section whose presence we can't know
          // before the fetch is the danger zone on the instance OWNER.
          <EditorSkeleton withDanger={!isSelf} />
        ) : (
          <>
            {ownerLocked && (
              <p className="rounded-lg border border-border bg-surface-strong p-3 text-xs text-muted-foreground">
                This account owns the instance. Only its owner can change it -
                no other admin can demote, suspend, reset or delete them.
                Ownership moves only when the owner transfers it.
              </p>
            )}

            <AccountMeta
              createdAt={createdAt}
              teamCount={teamCount}
              suspended={suspended}
              teams={teams}
            />

            <PermissionsSection
              admin={admin}
              onAdminChange={setAdmin}
              exposePorts={exposePorts}
              onExposePortsChange={setExposePorts}
              mountHostVolumes={mountHostVolumes}
              onMountHostVolumesChange={setMountHostVolumes}
              isSelf={isSelf}
              ownerLocked={ownerLocked}
              ownerFlagsLocked={ownerFlagsLocked}
              advancedOpen={advancedOpen}
              onAdvancedOpenChange={setAdvancedOpen}
            />

            <Section
              icon={KeyRound}
              title="Password"
              info="Optional: leave it blank to keep the current one. A new password applies the moment you save, and nobody is emailed about it, so hand it over yourself."
              docs="team.password"
            >
              <PasswordField
                id="reset-pw"
                label={null}
                value={password}
                onChange={setPassword}
                disabled={ownerLocked}
                placeholder={
                  ownerLocked
                    ? "Only the instance owner can reset their own password"
                    : "Leave blank to keep the current password"
                }
              />
            </Section>

            {passkeyCount > 0 && !isSelf && !ownerLocked && (
              <SecondFactorsSection
                pending={pending}
                onRemovePasskeys={() => setConfirmResetPasskeys(true)}
              />
            )}

            {showDanger && (
              <DangerZone
                suspended={suspended}
                twoFactorEnabled={twoFactorEnabled}
                pending={pending}
                onResetTwoFactor={() => setConfirmResetTwoFactor(true)}
                onSuspend={() => setConfirmSuspend(true)}
                onReactivate={reactivate}
                onDelete={() => setConfirmDelete(true)}
              />
            )}
          </>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {onCancel && (
            <Button variant="outline" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
          )}
          <Button
            type="submit"
            disabled={
              !ready ||
              pending ||
              ownerLocked ||
              !dirty ||
              (password.length > 0 && !passwordMeetsPolicy(password))
            }
            aria-busy={pending}
          >
            {/* The label stays mounted (just hidden) under the spinner so the
                button keeps its width and the footer doesn't jump. */}
            <span className="grid place-items-center">
              <span
                className={cn(
                  "col-start-1 row-start-1",
                  pending && "invisible",
                )}
              >
                Save changes
              </span>
              {pending && (
                <Loader2 className="col-start-1 row-start-1 size-4 animate-spin" />
              )}
            </span>
          </Button>
        </div>
      </form>

      <AccountConfirmDialogs
        userId={user.userId}
        username={user.username}
        passkeyCount={passkeyCount}
        confirmSuspend={confirmSuspend}
        onConfirmSuspendChange={setConfirmSuspend}
        onSuspend={async () => {
          const res = await commit({ suspended: true });
          if (res.ok) {
            setSuspended(true);
            router.refresh();
          }
          return res;
        }}
        confirmResetTwoFactor={confirmResetTwoFactor}
        onConfirmResetTwoFactorChange={setConfirmResetTwoFactor}
        onResetTwoFactor={resetTwoFactor}
        confirmResetPasskeys={confirmResetPasskeys}
        onConfirmResetPasskeysChange={setConfirmResetPasskeys}
        onResetPasskeys={resetPasskeys}
        confirmDelete={confirmDelete}
        onConfirmDeleteChange={setConfirmDelete}
        onDeleted={() => onDeleted?.()}
      />
    </>
  );
}
