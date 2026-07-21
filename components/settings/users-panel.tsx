"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  UserPlus,
  LinkIcon,
  ShieldCheck,
  ShieldOff,
  Ban,
  Crown,
  UserCheck,
  UserCog,
  MoreHorizontal,
  ChevronRight,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { InfoTip } from "@/components/ui/info-tip";
import { RegisterUserDialog } from "@/components/settings/register-user-dialog";
import { EditUserDialog } from "@/components/settings/edit-user-dialog";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";
import { cn, timeAgo } from "@/lib/utils";
import type { GlobalUserDTO, RegistrationLinkDTO } from "@/lib/data/members";

export function UsersPanel({
  users,
  links,
  currentUserId,
  viewerIsOwner,
}: {
  users: GlobalUserDTO[];
  links: RegistrationLinkDTO[];
  currentUserId: string;
  /** The viewer owns the instance — the only one who may hand the crown on. */
  viewerIsOwner: boolean;
}) {
  const [registerOpen, setRegisterOpen] = React.useState(false);
  const pendingLinks = links.filter((l) => l.status === "pending");
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
          <RegisterUserDialog
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
                viewerIsOwner={viewerIsOwner}
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
              <InfoTip content="Single-use links that haven't been used yet." />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {pendingLinks.map((l) => (
              <LinkRow key={l.id} link={l} />
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
  viewerIsOwner,
}: {
  user: GlobalUserDTO;
  isSelf: boolean;
  viewerIsOwner: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [confirmSuspend, setConfirmSuspend] = React.useState(false);
  const [confirmTransfer, setConfirmTransfer] = React.useState(false);
  const [transferPassword, setTransferPassword] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  // The owner's row is closed to everyone, THEMSELVES INCLUDED, for these two
  // actions: no admin may demote or suspend them, and they may not uncrown
  // themselves either (ownership leaves only via transfer, which names a
  // successor). Server-enforced in lib/data/members.ts; this only spares the
  // operator a click that would toast an error.
  const ownerLocked = user.isInstanceOwner;

  // Offer the crown only where the server would accept it: owner → an active
  // admin who isn't already the owner.
  const canTransferTo =
    viewerIsOwner &&
    !isSelf &&
    !user.isInstanceOwner &&
    user.isInstanceAdmin &&
    !user.suspended;

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
      <Avatar>
        <AvatarFallback
          style={{ backgroundColor: user.avatarColor, color: "#000" }}
        >
          {user.username.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
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
                  ? "The instance owner is always an instance admin. Transfer ownership first."
                  : "Grant or revoke instance-admin"
              }
              side="left"
            >
              <DropdownMenuItem
                disabled={isSelf || ownerLocked || pending}
                onSelect={() => flip({ isInstanceAdmin: !user.isInstanceAdmin })}
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
            {canTransferTo && (
              <>
                <DropdownMenuSeparator />
                <SimpleTooltip
                  content="Make this admin the instance owner. You stay an admin, but they take the crown."
                  side="left"
                >
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={pending}
                    onSelect={() => setConfirmTransfer(true)}
                  >
                    <Crown className="size-4" />
                    Transfer ownership
                  </DropdownMenuItem>
                </SimpleTooltip>
              </>
            )}
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
      {confirmTransfer && (
        <ConfirmAction
          open={confirmTransfer}
          onOpenChange={(v) => {
            setConfirmTransfer(v);
            if (!v) setTransferPassword("");
          }}
          title={`Make @${user.username} the instance owner?`}
          description="They become the only person who can edit their own account, transfer ownership, or be locked out of nothing. You stay an instance admin — but they can demote you, and only they can give the crown back."
          confirmLabel="Transfer ownership"
          confirmText={user.username}
          successMessage="Instance ownership transferred"
          extra={
            <div className="space-y-2">
              <Label htmlFor="transfer-password">Your password</Label>
              <Input
                id="transfer-password"
                type="password"
                autoComplete="current-password"
                value={transferPassword}
                onChange={(e) => setTransferPassword(e.target.value)}
              />
            </div>
          }
          onConfirm={async () => {
            const res = await gqlAction(
              `mutation ($userId: String!, $password: String!) {
                transferInstanceOwner(userId: $userId, password: $password)
              }`,
              { userId: user.userId, password: transferPassword },
            );
            if (res.ok) router.refresh();
            return res;
          }}
        />
      )}
    </>
  );
}

function LinkRow({ link }: { link: RegistrationLinkDTO }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  function revoke() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation ($id: String!) { revokeRegistrationLink(id: $id) }`,
        { id: link.id },
      );
      if (res.ok) {
        toast.success("Link revoked");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }
  return (
    <div className="flex items-center justify-between rounded-lg border border-border p-3">
      <div className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-full bg-muted">
          <LinkIcon className="size-4 text-muted-foreground" />
        </div>
        <div>
          <p className="text-sm font-medium">Registration link</p>
          <p className="text-xs text-muted-foreground">
            Created by {link.createdBy}
          </p>
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={revoke} disabled={pending}>
        Revoke
      </Button>
    </div>
  );
}
