"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  Ban,
  Check,
  Crown,
  Loader2,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserCheck,
} from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { Switch } from "@/components/ui/switch";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DeleteUserDialog } from "@/components/settings/delete-user-dialog";
import { UserAccessSection } from "@/components/settings/users/user-access-section";
import { gqlAction } from "@/lib/graphql-client";
import { cn, timeAgo } from "@/lib/utils";
import type { UserDetailDTO } from "@/lib/data/members";
import type { ScopeTreeTeam } from "@/lib/data/tokens";
import type { TeamRoleOption, UserTeamAccessDTO } from "@/lib/data/user-access";

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
 * One account, as an instance admin manages it: what they have done, the data
 * only an admin can reset, what they may do on every server, and their access
 * team by team.
 *
 * Two kinds of control, and the shape says which: FIELDS and switches are staged
 * and wait for Save, while destructive things are BUTTONS behind a confirm and
 * apply the moment you confirm them. That distinction is why the danger actions
 * live in the rail rather than among the switches.
 *
 * `updateUserAdmin` replaces the whole flag set, so the immediate actions send
 * the grants as the SERVER holds them, never what the form currently shows —
 * suspending someone must not silently commit a permission toggle the admin
 * flipped but has not saved.
 */
export function UserEditor({
  user,
  access,
  roles,
  tree,
  joinable,
  activity,
  isSelf,
}: {
  user: UserDetailDTO;
  access: UserTeamAccessDTO[];
  roles: Record<string, TeamRoleOption[]>;
  tree: ScopeTreeTeam[];
  joinable: { id: string; name: string }[];
  activity: React.ReactNode;
  isSelf: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  const [admin, setAdmin] = React.useState(user.isInstanceAdmin);
  const [exposePorts, setExposePorts] = React.useState(user.canExposePorts);
  const [mountHostVolumes, setMountHostVolumes] = React.useState(
    user.canMountHostVolumes,
  );
  const [password, setPassword] = React.useState("");

  // Server truth. `suspended` is NOT a form field: the danger zone applies it
  // immediately, so this only ever mirrors what the server confirmed.
  const [suspended, setSuspended] = React.useState(user.suspended);
  const [twoFactorEnabled, setTwoFactorEnabled] = React.useState(
    user.twoFactorEnabled,
  );
  const [savedGrants, setSavedGrants] = React.useState<Grants>({
    isInstanceAdmin: user.isInstanceAdmin,
    canExposePorts: user.canExposePorts,
    canMountHostVolumes: user.canMountHostVolumes,
  });

  const [confirmSuspend, setConfirmSuspend] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [confirmResetTwoFactor, setConfirmResetTwoFactor] = React.useState(false);
  // Folded away is not hidden: a grant that is ON opens the panel, or the admin
  // would have to go looking for state nothing on screen mentions.
  const [advancedOpen, setAdvancedOpen] = React.useState(
    user.canExposePorts || user.canMountHostVolumes,
  );

  // The instance owner's account is editable only by the owner themselves — no
  // other admin may demote, suspend, reset or delete them, because all of those
  // are routes to the same takeover. Server-enforced; the form goes read-only so
  // the operator sees the rule instead of a toast.
  const ownerLocked = user.isInstanceOwner && !isSelf;
  /** Ownership leaves only through a transfer that names a successor. */
  const ownerFlagsLocked = user.isInstanceOwner;
  const showDanger = !isSelf && !user.isInstanceOwner;

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
    return gqlAction<{ updateUserAdmin: { userId: string } }, { userId: string }>(
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
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  /** Clear the user's enrolment. Applies on confirm, like the danger zone. */
  async function resetTwoFactor() {
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
    if (!res.ok) return { ok: false as const, error: res.error };
    setTwoFactorEnabled(false);
    router.refresh();
    return { ok: true as const };
  }

  /** Reactivating is safe, so it applies on the spot — no confirm to sit through. */
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
    <form
      className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]"
      onSubmit={onSubmit}
    >
      <div className="min-w-0 space-y-6">
        {ownerLocked && (
          <p className="rounded-lg border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
            This account owns the instance. Only its owner can change it — no
            other admin can demote, suspend, reset or delete them. Ownership moves
            only when the owner transfers it.
          </p>
        )}

        {activity}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5 text-base">
              Account
              <InfoTip content="What they can't reset themselves." />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <FieldLabel
                htmlFor="reset-pw"
                info="Leave blank to keep the current password. A new one must be at least 8 characters and replaces theirs the moment you save — nobody is emailed about it, so hand it over yourself."
              >
                New password
              </FieldLabel>
              <Input
                id="reset-pw"
                type="password"
                value={password}
                disabled={ownerLocked}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  ownerLocked
                    ? "Only the instance owner can reset their own password"
                    : "Leave blank to keep the current password"
                }
              />
            </div>

            {twoFactorEnabled && !isSelf && !ownerLocked && (
              <Row
                title="Reset two-factor"
                info="For someone who lost their phone and their recovery codes. Their account goes back to password only, and they can set it up again. Nothing else changes: not their password, not their sessions."
                control={
                  <Button
                    type="button"
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5 text-base">
              Instance capabilities
              <InfoTip content="They apply in every team and on every server. What they can do inside one team is set below." />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Row
              title="Instance admin"
              info="Manage every user, mint registration links, and administer every team and server. Instance admins also hold both advanced grants implicitly."
              control={
                <Switch
                  aria-label="Instance admin"
                  checked={admin}
                  disabled={isSelf || ownerFlagsLocked}
                  onCheckedChange={setAdmin}
                />
              }
            />
            {/* WHY the switch above is dead. A state, not field help, so it stays
                on screen rather than hiding behind an icon. */}
            {(ownerFlagsLocked || isSelf) && (
              <p className="text-xs text-muted-foreground">
                {ownerFlagsLocked
                  ? "The instance owner is always an instance admin — transfer ownership first."
                  : "You can't change your own admin status — another instance admin has to."}
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
                <AccordionContent className="space-y-2 pb-1 pt-1">
                  <Row
                    title="Publish ports"
                    info="Declare published ports in a compose stack — a service's ports: (bound to the host) or expose:. Public domains and routes don't need this."
                    control={
                      <Switch
                        aria-label="Publish ports"
                        checked={admin || exposePorts}
                        disabled={admin || ownerLocked}
                        onCheckedChange={setExposePorts}
                      />
                    }
                  />
                  <Row
                    title="Bind server folders"
                    info="Let this account point an app at a folder that already exists on the server (the Bind kind in an app's Storage settings)."
                    control={
                      <Switch
                        aria-label="Bind server folders"
                        checked={admin || mountHostVolumes}
                        disabled={admin || ownerLocked}
                        onCheckedChange={setMountHostVolumes}
                      />
                    }
                  />
                  {admin && (
                    <p className="text-xs text-muted-foreground">
                      On because this account is an instance admin — these two
                      only matter once that switch is off.
                    </p>
                  )}
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </CardContent>
        </Card>

        <UserAccessSection
          userId={user.userId}
          access={access}
          roles={roles}
          tree={tree}
          joinable={joinable}
          disabled={ownerLocked}
        />
      </div>

      <aside className="h-fit space-y-4 lg:sticky lg:top-20">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5 text-base">
              Summary
              <InfoTip content="Exactly what this account can do once you save." />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="space-y-2.5 text-sm">
              <Meta
                label="Instance role"
                value={
                  user.isInstanceOwner
                    ? "Owner"
                    : savedGrants.isInstanceAdmin
                      ? "Admin"
                      : "Member"
                }
                icon={user.isInstanceOwner ? Crown : undefined}
              />
              <Meta label="Sign-in" value={suspended ? "Blocked" : "Allowed"} />
              <Meta
                label="Two-factor"
                value={twoFactorEnabled ? "On" : "Off"}
              />
              <Meta label="Teams" value={String(access.length)} />
              <Meta label="Joined" value={timeAgo(user.createdAt)} />
            </dl>

            {access.length > 0 && (
              <div className="space-y-1.5 border-t border-border pt-3">
                {access.map((a) => (
                  <div
                    key={a.teamId}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <span className="truncate text-muted-foreground">
                      {a.teamName}
                    </span>
                    <span className="shrink-0 font-medium">
                      {a.roleName ?? "Custom"}
                      {a.granular ? ` + ${a.nodes.length}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={
                pending ||
                ownerLocked ||
                !dirty ||
                (password.length > 0 && password.length < 8)
              }
              aria-busy={pending}
            >
              <span className="grid place-items-center">
                <span
                  className={cn(
                    "col-start-1 row-start-1 flex items-center gap-1.5",
                    pending && "invisible",
                  )}
                >
                  {dirty ? (
                    <>
                      <ShieldCheck className="size-4" />
                      Save changes
                    </>
                  ) : (
                    <>
                      <Check className="size-4" />
                      Saved
                    </>
                  )}
                </span>
                {pending && (
                  <Loader2 className="col-start-1 row-start-1 size-4 animate-spin" />
                )}
              </span>
            </Button>
            <p className="text-xs text-muted-foreground">
              Their access changes on their next request.
            </p>
          </CardContent>
        </Card>

        {showDanger && (
          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5 text-base text-destructive">
                <AlertTriangle className="size-4" />
                Danger zone
                <InfoTip content="These apply the moment you confirm them. They don't wait for Save." />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {suspended ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={pending}
                  onClick={reactivate}
                >
                  <UserCheck className="size-4" />
                  Reactivate account
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={pending}
                  onClick={() => setConfirmSuspend(true)}
                >
                  <Ban className="size-4" />
                  Suspend account
                </Button>
              )}
              <Button
                type="button"
                variant="destructive"
                className="w-full"
                disabled={pending}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="size-4" />
                Delete account
              </Button>
              <p className="mt-1 text-xs text-muted-foreground">
                Suspending signs them out and blocks sign-in, and is reversible.
                Deleting is not.
              </p>
            </CardContent>
          </Card>
        )}
      </aside>

      {/* Outside the form above: each confirm renders its own form, and a submit
          from a portalled subtree still propagates up the React tree. */}
      <ConfirmAction
        open={confirmSuspend}
        onOpenChange={setConfirmSuspend}
        title={`Suspend @${user.username}?`}
        description="They are signed out immediately and can't sign back in until you reactivate them. Team memberships, apps and everything they own are kept — nothing is deleted."
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
        description="Their next sign-in asks for the password only, and their old authenticator entry and recovery codes stop working. Do this when they have lost the phone AND the codes — check it is really them asking."
        confirmLabel="Reset two-factor"
        variant="default"
        successMessage="Two-factor reset"
        onConfirm={resetTwoFactor}
      />
      {confirmDelete && (
        <DeleteUserDialog
          userId={user.userId}
          username={user.username}
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          onDeleted={() => router.push("/settings/users")}
        />
      )}
    </form>
  );
}

/** One labelled row: name, its tooltip, and the control. */
function Row({
  title,
  info,
  control,
}: {
  title: string;
  info: React.ReactNode;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
      <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
        <span className="truncate">{title}</span>
        <InfoTip content={info} label={`About ${title}`} />
      </p>
      {/* `flex` on purpose: an inline-flex control in a block box sits on the
          text baseline and drags 5px of descender space in with it. */}
      <div className="flex shrink-0 items-center">{control}</div>
    </div>
  );
}

function Meta({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-1 font-medium">
        {Icon && <Icon className="size-3.5" />}
        {value}
      </dd>
    </div>
  );
}
