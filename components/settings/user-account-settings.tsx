"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  Ban,
  Crown,
  Fingerprint,
  KeyRound,
  Loader2,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserCheck,
  type LucideIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { TeamAvatar, UserAvatar } from "@/components/shared/user-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import type { DocsTopic } from "@/lib/docs";
import { PasswordField } from "@/components/ui/password-field";
import { passwordMeetsPolicy } from "@/lib/password-policy";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DeleteUserDialog } from "@/components/settings/delete-user-dialog";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import type { UserDetailDTO } from "@/lib/data/members";
import { TimeAgo } from "@/components/shared/time-ago";

/* ------------------------------------------------------------------ */
/* Instance-wide user editor (shared)                                  */
/* ------------------------------------------------------------------ */

/** Header/identity seed - the minimum any caller already has on hand. */
export interface EditUserSeedUser {
  userId: string;
  username: string;
  name: string;
  avatarColor: string;
  /** Their resolved picture, so the drawer opens on the same face the list showed. */
  avatarUrl: string | null;
}

/**
 * Optional instant-render seed of the editable global flags.
 */
export interface EditUserSeedFlags {
  isInstanceAdmin: boolean;
  /** Owns the instance - see the owner lock in the component body. */
  isInstanceOwner: boolean;
  suspended: boolean;
  canExposePorts: boolean;
  canMountHostVolumes: boolean;
  createdAt: string;
  teamCount: number;
}

/** The three instance-wide grants, exactly as the server holds them. */
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

/**
 * The instance-admin editor for ONE user's global account.
 */
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
  /** Present ⇒ render immediately; absent ⇒ fetch then render. */
  seed?: EditUserSeedFlags;
  isSelf: boolean;
  /**
   * Draw the avatar + name + state badges. A page that already has a header for
   * this person passes false; the dialog, which has none of its own, keeps it.
   */
  showHeader?: boolean;
  /** Present ⇒ a Cancel button sits beside Save (the dialog's escape hatch). */
  onCancel?: () => void;
  onSaved?: () => void;
  /** The account is gone - the caller decides where the operator lands. */
  onDeleted?: () => void;
}) {
  const router = useRouter();
  // Email and the team list are never in a list row, so they are always fetched.
  // The editable flags come from `seed` when the caller has them (instant render)
  // or from this same fetch otherwise.
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

  // Server truth. `suspended` is NOT a form field: the danger zone applies it
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
  // Mirrors the server, like `suspended`: the reset applies on confirm rather
  // than waiting for Save changes, so it can only ever reflect what came back.
  const [twoFactorEnabled, setTwoFactorEnabled] = React.useState(false);
  const [passkeyCount, setPasskeyCount] = React.useState(0);
  // The two narrow grants are folded away (the house "Advanced" affordance) so the
  // section leads with the permission that actually matters.
  const [advancedOpen, setAdvancedOpen] = React.useState(
    Boolean(seed?.canExposePorts || seed?.canMountHostVolumes),
  );
  // Whether the caller seeded the editable flags. Stable per dialog instance
  // (a boolean, not the inline-rebuilt `seed` object), so it is safe both as an
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

  // Ready once the toggles are authoritative - instantly when seeded, otherwise
  // the moment the fetch resolves (setDetail re-renders and flips this true).
  const ready = hasSeed || detail != null;
  const createdAt = seed?.createdAt ?? detail?.createdAt ?? null;
  const teams = detail?.teams ?? null;
  const teamCount = teams?.length ?? seed?.teamCount ?? 0;

  // The instance owner's account is editable only by the owner themselves, no other
  // admin may demote, suspend, reset or delete them, because all of those are routes
  // to the same takeover (see lib/data/instance-owner.ts).
  const isOwner = seed?.isInstanceOwner ?? detail?.isInstanceOwner ?? false;
  const ownerLocked = isOwner && !isSelf;
  // The flags nobody may flip on the owner, the owner included: ownership leaves
  // only through a transfer that names a successor.
  const ownerFlagsLocked = isOwner;
  // Suspending and deleting are both refused for your own account and for the
  // owner's, so for those two the whole section would be dead buttons.
  const showDanger = !isSelf && !isOwner;

  const dirty =
    admin !== savedGrants.isInstanceAdmin ||
    exposePorts !== savedGrants.canExposePorts ||
    mountHostVolumes !== savedGrants.canMountHostVolumes ||
    password.length > 0;

  /**
   * One write for every caller here.
   */
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

  /** Clear the user's enrolment. Applies on confirm, like the danger zone. */
  async function resetTwoFactor() {
    // The card reads "no second factor" straight away; a refusal puts the badge
    // back with the server's reason.
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

  /** Clear every passkey. Same shape, same moment, separate control. */
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

  /** Reactivating is safe, so it applies on the spot - no confirm to sit through. */
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
        <div className="flex items-center gap-3">
          <UserAvatar
            name={user.name}
            username={user.username}
            avatarColor={user.avatarColor}
            avatarUrl={user.avatarUrl}
            size="xl"
            className="shrink-0"
          />
          <div className="min-w-0">
            <h2 className="flex flex-wrap items-center gap-2 text-base leading-none font-semibold tracking-tight lg:text-lg">
              @{user.username}
              {/* The badges read the SAVED state, never the form: the header
                  says who this account is, the form below says what you are
                  about to change it into. */}
              {isOwner ? (
                <Badge variant="secondary" className="gap-1 px-1.5 py-0">
                  <Crown className="size-3" />
                  Owner
                </Badge>
              ) : (
                savedGrants.isInstanceAdmin && (
                  <Badge variant="secondary" className="gap-1 px-1.5 py-0">
                    <ShieldCheck className="size-3" />
                    Admin
                  </Badge>
                )
              )}
              {suspended && (
                <Badge variant="destructive" className="gap-1 px-1.5 py-0">
                  <Ban className="size-3" />
                  Suspended
                </Badge>
              )}
            </h2>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {user.name && user.name !== user.username
                ? `${user.name} · `
                : ""}
              {detail?.email ?? "Instance-wide account & permissions."}
            </p>
          </div>
        </div>
      )}

      <form className="grid gap-4" onSubmit={onSubmit}>
        {!ready ? (
          // `isSelf` is a prop, so the one section whose presence we can't know
          // before the fetch is the danger zone on the instance OWNER - one
          // account out of all of them. Everything else lines up box for box.
          <EditorSkeleton withDanger={!isSelf} />
        ) : (
          <>
            {ownerLocked && (
              <p className="rounded-lg border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
                This account owns the instance. Only its owner can change it -
                no other admin can demote, suspend, reset or delete them.
                Ownership moves only when the owner transfers it.
              </p>
            )}

            {/* Who this is - read-only, so it never competes with the
                editable sections below. */}
            <div className="grid grid-cols-3 gap-2 rounded-lg border border-border p-3">
              <Meta
                label="Joined"
                value={createdAt ? <TimeAgo at={createdAt} /> : "—"}
              />
              <Meta label="Teams" value={String(teamCount)} />
              <Meta label="Sign-in" value={suspended ? "Blocked" : "Allowed"} />
            </div>
            {/**
             * The chips need the fetch, but the seed already carries the COUNT, so the row
             * that is coming is held open (and the row that isn't never appears) instead of
             * pushing the sections down a second later.
             */}
            {teams == null && teamCount > 0 && (
              <div className="flex flex-wrap gap-1.5">
                <Skeleton className="h-[22px] w-32 rounded-full" />
              </div>
            )}
            {teams && teams.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {teams.map((t) => (
                  <span
                    key={t.teamId}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs"
                  >
                    <TeamAvatar
                      name={t.teamName}
                      avatarUrl={t.teamAvatarUrl}
                      size="xs"
                    />
                    <span className="font-medium">{t.teamName}</span>
                    <span className="text-muted-foreground capitalize">
                      {t.role}
                    </span>
                  </span>
                ))}
              </div>
            )}

            <Section
              icon={ShieldCheck}
              title="Permissions"
              info={
                <>
                  Instance-wide: they apply in every team and on every server.
                  What this person may do inside a single team is a separate
                  thing, set on that team&apos;s Members page.
                </>
              }
              docs="instance.admin"
            >
              <ToggleRow
                title="Instance admin"
                info="Manage every user, mint registration links, and administer every team and server. Instance admins also hold both advanced grants implicitly."
                docs="instance.admin"
                checked={admin}
                disabled={isSelf || ownerFlagsLocked}
                onChange={setAdmin}
              />
              {/* WHY the switch above is dead. A state, not field help, so it
                  stays on screen rather than hiding behind an icon. */}
              {(ownerFlagsLocked || isSelf) && (
                <p
                  className={
                    ownerFlagsLocked
                      ? "text-xs text-warning"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {ownerFlagsLocked
                    ? "The instance owner is always an instance admin - transfer ownership first."
                    : "You can't change your own admin status - another instance admin has to."}
                </p>
              )}

              <Accordion
                type="single"
                collapsible
                value={advancedOpen ? "advanced" : ""}
                onValueChange={(v) => setAdvancedOpen(v === "advanced")}
              >
                <AccordionItem value="advanced" className="border-none">
                  <AccordionTrigger className="py-1 text-xs text-muted-foreground hover:no-underline">
                    Advanced grants
                  </AccordionTrigger>
                  <AccordionContent className="space-y-2 pt-1 pb-1">
                    <ToggleRow
                      title="Publish ports"
                      info="Let a compose stack bind a port on the server itself, with a service's ports:. Public domains and routes don't need this."
                      docs="hostAccess.ports"
                      checked={admin || exposePorts}
                      disabled={admin || ownerLocked}
                      onChange={setExposePorts}
                    />
                    <ToggleRow
                      title="Bind server folders"
                      info="Let this account point an app at a folder that already exists on the server (the Bind kind in an app's Storage settings)."
                      docs="hostAccess.gated"
                      checked={admin || mountHostVolumes}
                      disabled={admin || ownerLocked}
                      onChange={setMountHostVolumes}
                    />
                    {admin && (
                      <p className="text-xs text-muted-foreground">
                        On because this account is an instance admin - these two
                        only matter once that switch is off.
                      </p>
                    )}
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </Section>

            <Section icon={KeyRound} title="Password">
              <PasswordField
                id="reset-pw"
                label="New password (optional)"
                info="Leave blank to keep the current password. A new one replaces theirs the moment you save, and nobody is emailed about it, so hand it over yourself."
                docs="team.password"
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

            {(twoFactorEnabled || passkeyCount > 0) &&
              !isSelf &&
              !ownerLocked && (
                <Section icon={ShieldOff} title="Second factors">
                  {twoFactorEnabled && (
                    <ActionRow
                      title="Reset two-factor"
                      info="For someone who lost their phone and their recovery codes. Their account goes back to password only, and they can set it up again. Nothing else changes: not their password, not their sessions."
                      docs="team.twoFactor"
                      action={
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() => setConfirmResetTwoFactor(true)}
                        >
                          <ShieldOff className="size-4" />
                          Reset
                        </Button>
                      }
                    />
                  )}
                  {/**
                   * Separate from the reset above on purpose: the phone and the laptop are lost
                   * independently, and clearing a dead authenticator is no reason to take away a
                   * passkey that still works.
                   */}
                  {passkeyCount > 0 && (
                    <ActionRow
                      title="Remove passkeys"
                      info="For someone whose device is gone. Until it is removed, a dead passkey still satisfies their team's two-factor policy, so nobody can tell them to enrol anything. Nothing else changes: not their password, not their sessions."
                      docs="team.passkeys"
                      action={
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() => setConfirmResetPasskeys(true)}
                        >
                          <Fingerprint className="size-4" />
                          Remove
                        </Button>
                      }
                    />
                  )}
                </Section>
              )}

            {showDanger && (
              <Section
                icon={AlertTriangle}
                title="Danger zone"
                tone="destructive"
                info="Unlike everything above, these apply the moment you confirm them - they don't wait for Save changes."
                docs="instance.users"
              >
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
                        onClick={reactivate}
                      >
                        <UserCheck className="size-4" />
                        Reactivate
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        disabled={pending}
                        onClick={() => setConfirmSuspend(true)}
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
                      onClick={() => setConfirmDelete(true)}
                    >
                      <Trash2 className="size-4" />
                      Delete
                    </Button>
                  }
                />
              </Section>
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
            {/* While the save runs a spinner stands in for the label, which
                stays mounted (just hidden) so the button keeps its width and
                the footer doesn't jump - the ConfirmAction idiom. */}
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

      {/* Both danger-zone confirms live OUTSIDE the form above: each renders its
          own form, and a submit from a portalled subtree still propagates up the
          React tree. */}
      <ConfirmAction
        open={confirmSuspend}
        onOpenChange={setConfirmSuspend}
        title={`Suspend @${user.username}?`}
        description="They are signed out immediately and can't sign back in until you reactivate them. Team memberships, apps and everything they own are kept, nothing is deleted."
        confirmLabel="Suspend account"
        successMessage="Account suspended"
        onConfirm={async () => {
          const res = await commit({ suspended: true });
          if (res.ok) {
            setSuspended(true);
            router.refresh();
          }
          return res;
        }}
      />
      <ConfirmAction
        open={confirmResetTwoFactor}
        onOpenChange={setConfirmResetTwoFactor}
        title={`Reset two-factor for @${user.username}?`}
        description="Their next sign-in asks for the password only, and their old authenticator entry and recovery codes stop working. Do this when they have lost the phone AND the codes - check it is really them asking."
        confirmLabel="Reset two-factor"
        variant="default"
        successMessage="Two-factor reset"
        optimistic
        onConfirm={resetTwoFactor}
      />
      <ConfirmAction
        open={confirmResetPasskeys}
        onOpenChange={setConfirmResetPasskeys}
        title={
          passkeyCount === 1
            ? `Remove @${user.username}'s passkey?`
            : `Remove @${user.username}'s ${passkeyCount} passkeys?`
        }
        description="They stop signing in with any device they registered, and their account goes back to password only. Do this when the device is gone - check it is really them asking."
        confirmLabel="Remove passkeys"
        variant="default"
        successMessage="Passkeys removed"
        optimistic
        onConfirm={resetPasskeys}
      />
      {confirmDelete && (
        <DeleteUserDialog
          userId={user.userId}
          username={user.username}
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          // The account this editor points at no longer exists - the caller
          // takes it from here (close the dialog, leave the page).
          onDeleted={() => onDeleted?.()}
        />
      )}
    </>
  );
}

/**
 * The same editor in a modal, for Settings → Users: that page lists every account
 * on the instance, most of which are in no team of yours, so there is no member
 * page to send the admin to.
 */
export function EditUserDialog({
  user,
  seed,
  isSelf,
  open,
  onOpenChange,
}: {
  user: EditUserSeedUser;
  seed?: EditUserSeedFlags;
  isSelf: boolean;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader className="sr-only">
          <DialogTitle>@{user.username}</DialogTitle>
          <DialogDescription>
            Instance-wide account and permissions.
          </DialogDescription>
        </DialogHeader>
        <UserAccountSettings
          user={user}
          seed={seed}
          isSelf={isSelf}
          onCancel={() => onOpenChange(false)}
          onSaved={() => onOpenChange(false)}
          onDeleted={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The stand-in shown until the account is loaded.
 */
function EditorSkeleton({ withDanger }: { withDanger: boolean }) {
  return (
    <>
      {/* Identity strip: each cell is a 16px line over a 20px one, which is what
          the two <p>s in Meta measure. */}
      <div className="grid grid-cols-3 gap-2 rounded-lg border border-border p-3">
        {[0, 1, 2].map((i) => (
          <div key={i}>
            <TextLine box="h-4" bar="h-3 w-12" />
            <TextLine box="h-5" bar="h-4 w-16" />
          </div>
        ))}
      </div>
      <div className="flex gap-1.5">
        <Skeleton className="h-[22px] w-32 rounded-full" />
      </div>

      {/* Permissions: heading, the admin row, the folded advanced trigger. */}
      <SkeletonSection>
        <SkeletonRow />
        <TextLine box="h-6" bar="h-4 w-28" />
      </SkeletonSection>

      {/* Password: heading, then the label (leading-none, so 14px) + input. */}
      <SkeletonSection>
        <TextLine box="h-3.5" bar="h-3 w-40" />
        <Skeleton className="h-9 w-full" />
      </SkeletonSection>

      {withDanger && (
        <SkeletonSection tone="destructive">
          <SkeletonRow button />
          <SkeletonRow button />
        </SkeletonSection>
      )}
    </>
  );
}

/** A {@link Section}-shaped placeholder - same shell, same inner spacing. */
function SkeletonSection({
  tone = "default",
  children,
}: {
  tone?: "default" | "destructive";
  children: React.ReactNode;
}) {
  return (
    <div className={sectionShell(tone)}>
      <TextLine box="h-5" bar="h-4 w-28" />
      <div className="space-y-2">{children}</div>
    </div>
  );
}

/** One {@link Row}-shaped placeholder - same shell, same control heights. */
function SkeletonRow({ button }: { button?: boolean }) {
  return (
    <div className={ROW_SHELL}>
      <TextLine box="h-5" bar="h-4 w-36" />
      <Skeleton
        className={button ? "h-8 w-24 rounded-md" : "h-5 w-9 rounded-full"}
      />
    </div>
  );
}

/**
 * A bar sitting in a box the height of the text line it replaces. Without the box
 * the placeholder would be its own (shorter) height and every section would come
 * up a few pixels short, which is the jump this whole component exists to remove.
 */
function TextLine({ box, bar }: { box: string; bar: string }) {
  return (
    <div className={cn("flex items-center", box)}>
      <Skeleton className={bar} />
    </div>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}

/**
 * A named group of controls. The heading is the whole point: it tells the admin
 * WHAT they are editing before they touch a switch, which a bare row of toggles
 * never did.
 */
function Section({
  icon: Icon,
  title,
  info,
  docs,
  tone = "default",
  children,
}: {
  icon: LucideIcon;
  title: string;
  info?: React.ReactNode;
  docs?: DocsTopic;
  tone?: "default" | "destructive";
  children: React.ReactNode;
}) {
  const danger = tone === "destructive";
  return (
    <section className={sectionShell(tone)}>
      <h3
        className={cn(
          "flex w-fit items-center gap-2 text-sm font-semibold",
          danger && "text-destructive",
        )}
      >
        <Icon className="size-4 shrink-0" />
        {title}
        {info != null && (
          <InfoTip content={info} docs={docs} label={`About ${title}`} />
        )}
      </h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

/**
 * The two shells the real components and their skeletons BOTH wear. Shared
 * rather than copied so the placeholder can't drift out of alignment with the
 * thing it stands in for the next time someone changes a padding.
 */
const ROW_SHELL =
  "flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2.5";

function sectionShell(tone: "default" | "destructive") {
  return cn(
    "space-y-3 rounded-lg border p-3",
    tone === "destructive"
      ? "border-destructive/40 bg-destructive/5"
      : "border-border",
  );
}

/** One row: name, its tooltip, and the control. */
function Row({
  title,
  info,
  docs,
  control,
}: {
  title: string;
  info: React.ReactNode;
  docs?: DocsTopic;
  control: React.ReactNode;
}) {
  return (
    <div className={ROW_SHELL}>
      <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
        <span className="truncate">{title}</span>
        <InfoTip content={info} docs={docs} label={`About ${title}`} />
      </p>
      {/* `flex` on purpose: an inline-flex control (Switch, Button) in a block
          box sits on the text baseline and drags 5px of descender space in with
          it, which no skeleton can predict. */}
      <div className="flex shrink-0 items-center">{control}</div>
    </div>
  );
}

function ToggleRow({
  title,
  info,
  docs,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  info: React.ReactNode;
  docs?: DocsTopic;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Row
      title={title}
      info={info}
      docs={docs}
      control={
        // The title is a <p>, not a <label>, so the switch carries the name
        // itself, otherwise it announces as a bare "switch, off".
        <Switch
          aria-label={title}
          checked={checked}
          onCheckedChange={onChange}
          disabled={disabled}
        />
      }
    />
  );
}

/** A row whose control fires straight away - the danger zone's shape. */
function ActionRow({
  title,
  info,
  docs,
  action,
}: {
  title: string;
  info: React.ReactNode;
  docs?: DocsTopic;
  action: React.ReactNode;
}) {
  return <Row title={title} info={info} docs={docs} control={action} />;
}
