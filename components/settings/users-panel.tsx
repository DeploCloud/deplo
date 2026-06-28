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
  UserCheck,
  UserCog,
  ChevronRight,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { RegisterUserDialog } from "@/components/settings/register-user-dialog";
import { gqlAction } from "@/lib/graphql-client";
import { cn, timeAgo } from "@/lib/utils";
import type {
  GlobalUserDTO,
  RegistrationLinkDTO,
  UserDetailDTO,
} from "@/lib/data/members";

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
  const pendingLinks = links.filter((l) => l.status === "pending");
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <div>
            <CardTitle className="text-base">Users</CardTitle>
            <CardDescription>
              Everyone registered on this instance. Click a user to view details
              and edit their global permissions.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setRegisterOpen(true)}>
            <UserPlus className="size-4" />
            Register user
          </Button>
          <RegisterUserDialog
            open={registerOpen}
            onOpenChange={setRegisterOpen}
          />
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {users.map((u) => (
              <UserRow
                key={u.userId}
                user={u}
                isSelf={u.userId === currentUserId}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      {pendingLinks.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Pending registration links
            </CardTitle>
            <CardDescription>
              Single-use links that haven&apos;t been used yet.
            </CardDescription>
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

function UserRow({ user, isSelf }: { user: GlobalUserDTO; isSelf: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  // Quick context-menu actions flip ONE global flag while preserving the rest
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
      onClick={() => setOpen(true)}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:border-foreground/20 hover:bg-accent",
        user.suspended && "opacity-60",
      )}
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
          {user.isInstanceAdmin && (
            <Badge variant="secondary" className="gap-1 px-1.5 py-0">
              <ShieldCheck className="size-3" />
              Admin
            </Badge>
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
      {/* Right-click the card for quick actions; left-click still opens the full
          editor. Mirrors the members row + project/server card context menus. */}
      <ContextMenu>
        <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem
            onSelect={(e: Event) => {
              e.preventDefault();
              setOpen(true);
            }}
            title="View details and edit this user's global permissions"
          >
            <UserCog className="size-4" />
            Manage user
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={isSelf || pending}
            onSelect={() => flip({ isInstanceAdmin: !user.isInstanceAdmin })}
            title="Grant or revoke instance-admin"
          >
            {user.isInstanceAdmin ? (
              <ShieldOff className="size-4" />
            ) : (
              <ShieldCheck className="size-4" />
            )}
            {user.isInstanceAdmin
              ? "Remove instance admin"
              : "Make instance admin"}
          </ContextMenuItem>
          <ContextMenuItem
            variant={user.suspended ? undefined : "destructive"}
            disabled={isSelf || pending}
            onSelect={() => flip({ suspended: !user.suspended })}
            title="Suspend or reactivate this account"
          >
            {user.suspended ? (
              <UserCheck className="size-4" />
            ) : (
              <Ban className="size-4" />
            )}
            {user.suspended ? "Reactivate account" : "Suspend account"}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {open && (
        <EditUserDialog
          user={user}
          isSelf={isSelf}
          open={open}
          onOpenChange={setOpen}
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

/* ------------------------------------------------------------------ */
/* User detail + edit                                                  */
/* ------------------------------------------------------------------ */

function EditUserDialog({
  user,
  isSelf,
  open,
  onOpenChange,
}: {
  user: GlobalUserDTO;
  isSelf: boolean;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  // Email, the team list and recent activity aren't in the list row, so they're
  // fetched in the background. Everything the editor needs to RENDER and EDIT is
  // already in `user`, so the modal shows the full editor immediately — there is
  // no blocking "Loading…" screen; the extra detail just fills in when it lands.
  const [detail, setDetail] = React.useState<UserDetailDTO | null>(null);
  const [pending, startTransition] = React.useTransition();

  const [admin, setAdmin] = React.useState(user.isInstanceAdmin);
  const [suspended, setSuspended] = React.useState(user.suspended);
  const [exposePorts, setExposePorts] = React.useState(user.canExposePorts);
  const [mountHostVolumes, setMountHostVolumes] = React.useState(
    user.canMountHostVolumes,
  );
  const [password, setPassword] = React.useState("");

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
          createdAt
          isInstanceAdmin
          suspended
          canExposePorts
          canMountHostVolumes
          teams { teamId teamName role }
          recentActivity { message createdAt }
        }
      }`,
      { userId: user.userId },
      (d) => d.userDetail,
    ).then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) setDetail(res.data);
      else if (!res.ok) toast.error(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [user.userId]);

  function save() {
    startTransition(async () => {
      const res = await gqlAction<
        { updateUserAdmin: { userId: string } },
        { userId: string }
      >(
        `mutation ($input: UpdateUserAdminInput!) {
          updateUserAdmin(input: $input) { userId }
        }`,
        {
          input: {
            userId: user.userId,
            isInstanceAdmin: admin,
            suspended,
            canExposePorts: exposePorts,
            canMountHostVolumes: mountHostVolumes,
            newPassword: password || undefined,
          },
        },
        (d) => d.updateUserAdmin,
      );
      if (res.ok) {
        toast.success("User updated");
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Avatar className="size-8">
              <AvatarFallback
                style={{ backgroundColor: user.avatarColor, color: "#000" }}
              >
                {user.username.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            @{user.username}
          </DialogTitle>
          <DialogDescription>
            {user.name && user.name !== user.username ? `${user.name} · ` : ""}
            {detail?.email ?? ""}
          </DialogDescription>
        </DialogHeader>

        {/* General information */}
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-2 rounded-lg border border-border p-3">
            <Meta label="Joined" value={timeAgo(user.createdAt)} />
            <Meta label="Teams" value={String(user.teamCount)} />
            <Meta label="Instance admin" value={admin ? "Yes" : "No"} />
            <Meta label="Status" value={suspended ? "Suspended" : "Active"} />
          </div>

          {detail && (
            <div className="rounded-lg border border-border p-3">
              <p className="mb-2 text-xs font-medium uppercase text-muted-foreground">
                Teams &amp; roles
              </p>
              {detail.teams.length === 0 ? (
                <p className="text-xs text-muted-foreground">No teams.</p>
              ) : (
                <ul className="space-y-1">
                  {detail.teams.map((t) => (
                    <li
                      key={t.teamId}
                      className="flex items-center justify-between"
                    >
                      <span>{t.teamName}</span>
                      <Badge variant="outline" className="capitalize">
                        {t.role}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {detail && detail.recentActivity.length > 0 && (
            <div className="rounded-lg border border-border p-3">
              <p className="mb-2 text-xs font-medium uppercase text-muted-foreground">
                Recent activity
              </p>
              <ul className="space-y-1">
                {detail.recentActivity.map((a, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <span className="truncate">{a.message}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {timeAgo(a.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <Separator />

        {/* Global permissions */}
        <div className="space-y-4">
          <ToggleRow
            title="Instance admin"
            detail="Manage all users, mint registration links, and administer any team."
            checked={admin}
            disabled={isSelf}
            onChange={setAdmin}
          />
          <ToggleRow
            title="Suspended"
            detail="Block this account from signing in. Memberships are kept."
            checked={suspended}
            disabled={isSelf}
            onChange={setSuspended}
          />
          {isSelf && (
            <p className="text-xs text-muted-foreground">
              You can&apos;t change your own admin status or suspend yourself.
            </p>
          )}
          <ToggleRow
            title="Publish ports"
            detail="Declare published ports in a compose stack — a service's ports: (bound to the host) or expose:. Public domains/routes don't need this. Instance admins always can."
            checked={admin || exposePorts}
            disabled={admin}
            onChange={setExposePorts}
          />
          <ToggleRow
            title="Mount host volumes"
            detail="Bind-mount host filesystem paths into containers (compose and single-container). Instance admins always can."
            checked={admin || mountHostVolumes}
            disabled={admin}
            onChange={setMountHostVolumes}
          />
          {admin && (
            <p className="text-xs text-muted-foreground">
              Instance admins hold the publish-ports and host-volume grants
              implicitly.
            </p>
          )}
          <div className="space-y-2">
            <Label htmlFor="reset-pw">Reset password (optional)</Label>
            <Input
              id="reset-pw"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="New password — leave blank to keep current"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={pending || (password.length > 0 && password.length < 8)}
          >
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}

function ToggleRow({
  title,
  detail,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  detail: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}
