"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  UserPlus,
  ShieldCheck,
  ShieldOff,
  Ban,
  Crown,
  UserCheck,
  UserCog,
  MoreHorizontal,
  ChevronRight,
  Trash2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UserAvatar } from "@/components/shared/user-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { InfoTip } from "@/components/ui/info-tip";
import { RegisterUserWizard } from "@/components/settings/users/register-user-wizard";
import { EditUserDialog } from "@/components/settings/user-account-settings";
import { DeleteUserDialog } from "@/components/settings/delete-user-dialog";
import { RegistrationLinkRow } from "@/components/settings/registration-link-row";
import { useOptimisticRemove } from "@/components/shared/use-optimistic-remove";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";
import { cn, timeAgo } from "@/lib/utils";
import type { GlobalUserDTO, RegistrationLinkDTO } from "@/lib/data/members";

export function UsersPanel({
  users,
  links,
  currentUserId,
}: {
  users: GlobalUserDTO[];
  links: RegistrationLinkDTO[];
  currentUserId: string;
}) {
  const [registerOpen, setRegisterOpen] = React.useState(false);
  // A revoked link leaves the list on the click — the row is dead server-side
  // the moment the mutation is sent, and a live Revoke on a dead link is only
  // good for a red "Not found".
  const {
    visible: liveLinks,
    remove,
    restore,
  } = useOptimisticRemove(links, (l) => l.id);
  const pendingLinks = liveLinks.filter((l) => l.status === "pending");
  // `?user=<id>` opens that account's editor on arrival — the deep link a
  // member's page uses, since accounts are instance-wide and edited here.
  const focusUserId = useSearchParams().get("user");
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <div>
            <CardTitle className="flex w-fit items-center gap-2 text-base">
              Users
              <InfoTip content="Everyone registered on this instance. Click a user to view details and edit their global permissions." />
            </CardTitle>
          </div>
          <Button size="sm" onClick={() => setRegisterOpen(true)}>
            <UserPlus className="size-4" />
            Register user
          </Button>
          <RegisterUserWizard
            open={registerOpen}
            onOpenChange={setRegisterOpen}
            pinActiveTeam={false}
          />
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {users.map((u) => (
              <UserRow
                key={u.userId}
                user={u}
                isSelf={u.userId === currentUserId}
                defaultOpen={u.userId === focusUserId}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      {pendingLinks.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex w-fit items-center gap-2 text-base">
              Pending registration links
              <InfoTip content="Single-use links that haven't been used yet. Each one works for 24 hours from the moment it was minted — copy it as often as you need until then, and revoke it if it goes astray." />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {pendingLinks.map((l) => (
              <RegistrationLinkRow
                key={l.id}
                link={l}
                onRemoved={() => remove(l.id)}
                onRestored={() => restore(l.id)}
              />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function UserRow({
  user,
  isSelf,
  defaultOpen = false,
}: {
  user: GlobalUserDTO;
  isSelf: boolean;
  /** Arrived here linked straight at this account — open its editor. */
  defaultOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(defaultOpen);
  const [confirmSuspend, setConfirmSuspend] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  // The owner's row is closed to everyone, THEMSELVES INCLUDED, for these two
  // actions: no admin may demote or suspend them, and they may not uncrown
  // themselves either (ownership leaves only via transfer, which names a
  // successor). Server-enforced in lib/data/members.ts; this only spares the
  // operator a click that would toast an error.
  const ownerLocked = user.isInstanceOwner;

  // Quick ⋯-menu actions flip ONE global flag while preserving the rest
  // (updateUserAdmin replaces the whole set). The last-admin and can't-touch-self
  // guards are enforced server-side and surfaced verbatim as a toast.
  function flip(patch: { isInstanceAdmin?: boolean; suspended?: boolean }) {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation ($input: UpdateUserAdminInput!) {
          updateUserAdmin(input: $input) { userId }
        }`,
        {
          input: {
            userId: user.userId,
            isInstanceAdmin: patch.isInstanceAdmin ?? user.isInstanceAdmin,
            suspended: patch.suspended ?? user.suspended,
            canExposePorts: user.canExposePorts,
            canMountHostVolumes: user.canMountHostVolumes,
          },
        },
      );
      if (res.ok) {
        toast.success("User updated");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  // Compact, horizontal card — deliberately distinct from the team Members
  // cards (which stack vertically with a badge row): here the avatar sits left,
  // status badges sit inline with the handle, and a single meta line carries
  // name · team count · join date.
  const meta = [
    user.name && user.name !== user.username ? user.name : null,
    `${user.teamCount} team${user.teamCount === 1 ? "" : "s"}`,
    `joined ${timeAgo(user.createdAt)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const card = (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="flex min-w-0 flex-1 items-center gap-3 text-left"
    >
      <UserAvatar
        name={user.name}
        username={user.username}
        avatarColor={user.avatarColor}
        avatarUrl={user.avatarUrl}
        size="lg"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-sm font-medium">
            @{user.username}
            {isSelf && (
              <span className="ml-1 text-xs text-muted-foreground">(you)</span>
            )}
          </p>
          {/* Owner supersedes Admin — the owner IS an admin, so showing both
              would just be noise on the one row that matters most. */}
          {user.isInstanceOwner ? (
            <Badge variant="secondary" className="gap-1 px-1.5 py-0">
              <Crown className="size-3" />
              Owner
            </Badge>
          ) : (
            user.isInstanceAdmin && (
              <Badge variant="secondary" className="gap-1 px-1.5 py-0">
                <ShieldCheck className="size-3" />
                Admin
              </Badge>
            )
          )}
          {user.suspended && (
            <Badge variant="destructive" className="gap-1 px-1.5 py-0">
              <Ban className="size-3" />
              Suspended
            </Badge>
          )}
        </div>
        <p className="truncate text-xs text-muted-foreground">{meta}</p>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );

  return (
    <>
      {/* Left-click the card to open the full editor; the ⋯ menu offers the
          quick admin/suspend actions. */}
      <div
        className={cn(
          "flex items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:border-foreground/20 hover:bg-accent",
          user.suspended && "opacity-60",
        )}
      >
        {card}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="-mr-1 shrink-0"
              aria-label={`@${user.username} menu`}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <SimpleTooltip
              content="View details and edit this user's global permissions"
              side="left"
            >
              <DropdownMenuItem onSelect={() => setOpen(true)}>
                <UserCog className="size-4" />
                Manage user
              </DropdownMenuItem>
            </SimpleTooltip>
            <DropdownMenuSeparator />
            <SimpleTooltip
              content={
                ownerLocked
                  ? "The instance owner is always an instance admin. Transfer ownership on Settings, Deplo first."
                  : "Grant or revoke instance-admin"
              }
              side="left"
            >
              <DropdownMenuItem
                disabled={isSelf || ownerLocked || pending}
                onSelect={() =>
                  flip({ isInstanceAdmin: !user.isInstanceAdmin })
                }
              >
                {user.isInstanceAdmin ? (
                  <ShieldOff className="size-4" />
                ) : (
                  <ShieldCheck className="size-4" />
                )}
                {user.isInstanceAdmin
                  ? "Remove instance admin"
                  : "Make instance admin"}
              </DropdownMenuItem>
            </SimpleTooltip>
            <SimpleTooltip
              content={
                ownerLocked
                  ? "The instance owner's account can't be suspended."
                  : "Suspend or reactivate this account"
              }
              side="left"
            >
              <DropdownMenuItem
                variant={user.suspended ? undefined : "destructive"}
                disabled={isSelf || ownerLocked || pending}
                onSelect={() => {
                  // Reactivating is safe → apply straight away. Suspending is
                  // guarded by a confirm modal (opened once the menu closes).
                  if (user.suspended) {
                    flip({ suspended: false });
                  } else {
                    setConfirmSuspend(true);
                  }
                }}
              >
                {user.suspended ? (
                  <UserCheck className="size-4" />
                ) : (
                  <Ban className="size-4" />
                )}
                {user.suspended ? "Reactivate account" : "Suspend account"}
              </DropdownMenuItem>
            </SimpleTooltip>
            {/* Permanent deletion sits below the reversible actions, behind its
                own separator: suspending is the answer to "they shouldn't be
                able to log in", and only the operator who means "and everything
                they own goes too" should reach past it. */}
            <DropdownMenuSeparator />
            <SimpleTooltip
              content={
                isSelf
                  ? "You can't delete your own account."
                  : ownerLocked
                    ? "The instance owner's account can't be deleted. Transfer ownership on Settings, Deplo first."
                    : "Permanently delete this account — and, optionally, what it owns"
              }
              side="left"
            >
              <DropdownMenuItem
                variant="destructive"
                disabled={isSelf || ownerLocked || pending}
                onSelect={() => setConfirmDelete(true)}
              >
                <Trash2 className="size-4" />
                Delete user
              </DropdownMenuItem>
            </SimpleTooltip>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open && (
        <EditUserDialog
          user={{
            userId: user.userId,
            username: user.username,
            name: user.name,
            avatarColor: user.avatarColor,
            avatarUrl: user.avatarUrl,
          }}
          seed={{
            isInstanceAdmin: user.isInstanceAdmin,
            isInstanceOwner: user.isInstanceOwner,
            suspended: user.suspended,
            canExposePorts: user.canExposePorts,
            canMountHostVolumes: user.canMountHostVolumes,
            createdAt: user.createdAt,
            teamCount: user.teamCount,
          }}
          isSelf={isSelf}
          open={open}
          onOpenChange={setOpen}
        />
      )}
      {confirmSuspend && (
        <ConfirmAction
          open={confirmSuspend}
          onOpenChange={setConfirmSuspend}
          title={`Suspend @${user.username}?`}
          description="This blocks the account from signing in. Team memberships are kept and you can reactivate at any time."
          confirmLabel="Suspend account"
          successMessage="Account suspended"
          onConfirm={async () => {
            const res = await gqlAction(
              `mutation ($input: UpdateUserAdminInput!) {
                updateUserAdmin(input: $input) { userId }
              }`,
              {
                input: {
                  userId: user.userId,
                  isInstanceAdmin: user.isInstanceAdmin,
                  suspended: true,
                  canExposePorts: user.canExposePorts,
                  canMountHostVolumes: user.canMountHostVolumes,
                },
              },
            );
            if (res.ok) router.refresh();
            return res;
          }}
        />
      )}
      {confirmDelete && (
        <DeleteUserDialog
          userId={user.userId}
          username={user.username}
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
        />
      )}
    </>
  );
}
