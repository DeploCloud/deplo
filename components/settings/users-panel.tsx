"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  UserPlus,
  Copy,
  LinkIcon,
  ShieldCheck,
  Ban,
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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  mintRegistrationLinkAction,
  revokeRegistrationLinkAction,
  getUserDetailAction,
  updateUserAdminAction,
} from "@/lib/actions/members";
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
          <RegisterUserDialog />
        </CardHeader>
        <CardContent className="space-y-3">
          {users.map((u) => (
            <UserRow key={u.userId} user={u} isSelf={u.userId === currentUserId} />
          ))}
        </CardContent>
      </Card>

      {pendingLinks.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pending registration links</CardTitle>
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
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cn(
          "flex w-full items-center justify-between rounded-lg border border-border p-3 text-left transition-colors hover:bg-accent",
          user.suspended && "opacity-60",
        )}
      >
        <div className="flex items-center gap-3">
          <Avatar>
            <AvatarFallback
              style={{ backgroundColor: user.avatarColor, color: "#000" }}
            >
              {user.username.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div>
            <p className="text-sm font-medium">
              @{user.username}
              {isSelf && (
                <span className="ml-2 text-xs text-muted-foreground">(you)</span>
              )}
            </p>
            {user.name && user.name !== user.username && (
              <p className="text-xs text-muted-foreground">{user.name}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {user.isInstanceAdmin && (
            <Badge variant="secondary" className="gap-1">
              <ShieldCheck className="size-3" />
              Admin
            </Badge>
          )}
          {user.suspended && (
            <Badge variant="destructive" className="gap-1">
              <Ban className="size-3" />
              Suspended
            </Badge>
          )}
          <Badge variant="outline">
            {user.teamCount} team{user.teamCount === 1 ? "" : "s"}
          </Badge>
          <ChevronRight className="size-4 text-muted-foreground" />
        </div>
      </button>
      {open && (
        <EditUserDialog
          userId={user.userId}
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
      const res = await revokeRegistrationLinkAction(link.id);
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
  userId,
  isSelf,
  open,
  onOpenChange,
}: {
  userId: string;
  isSelf: boolean;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const [detail, setDetail] = React.useState<UserDetailDTO | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const [admin, setAdmin] = React.useState(false);
  const [suspended, setSuspended] = React.useState(false);
  const [password, setPassword] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    getUserDetailAction(userId).then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) {
        setDetail(res.data);
        setAdmin(res.data.isInstanceAdmin);
        setSuspended(res.data.suspended);
      } else if (!res.ok) {
        setError(res.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  function save() {
    startTransition(async () => {
      const res = await updateUserAdminAction({
        userId,
        isInstanceAdmin: admin,
        suspended,
        newPassword: password || undefined,
      });
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
        {!detail ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {error ?? "Loading…"}
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Avatar className="size-8">
                  <AvatarFallback
                    style={{ backgroundColor: detail.avatarColor, color: "#000" }}
                  >
                    {detail.username.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                @{detail.username}
              </DialogTitle>
              <DialogDescription>
                {detail.name && detail.name !== detail.username
                  ? `${detail.name} · `
                  : ""}
                {detail.email}
              </DialogDescription>
            </DialogHeader>

            {/* General information */}
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2 rounded-lg border border-border p-3">
                <Meta label="Joined" value={timeAgo(detail.createdAt)} />
                <Meta label="Teams" value={String(detail.teams.length)} />
                <Meta
                  label="Instance admin"
                  value={detail.isInstanceAdmin ? "Yes" : "No"}
                />
                <Meta
                  label="Status"
                  value={detail.suspended ? "Suspended" : "Active"}
                />
              </div>

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

              {detail.recentActivity.length > 0 && (
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
          </>
        )}
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
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

function RegisterUserDialog() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [link, setLink] = React.useState<string | null>(null);

  function mint() {
    startTransition(async () => {
      const res = await mintRegistrationLinkAction();
      if (res.ok && res.data) {
        setLink(res.data.link);
        router.refresh();
      } else if (!res.ok) {
        toast.error(res.error);
      }
    });
  }

  function copy() {
    if (link) {
      navigator.clipboard.writeText(link);
      toast.success("Registration link copied");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setLink(null);
      }}
    >
      <Button size="sm" onClick={() => setOpen(true)}>
        <UserPlus className="size-4" />
        Register user
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register a new user</DialogTitle>
          <DialogDescription>
            Generate a single-use link. Whoever opens it creates their own
            account and team — like the first-run setup.
          </DialogDescription>
        </DialogHeader>
        {link ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Share this link. It works once and expires in 14 days.
            </p>
            <div className="flex gap-2">
              <Input readOnly value={link} className="font-mono text-xs" />
              <Button
                variant="outline"
                size="icon"
                onClick={copy}
                aria-label="Copy link"
              >
                <Copy className="size-4" />
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            A fresh link is generated each time and can only be used once.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {link ? "Done" : "Cancel"}
          </Button>
          {!link && (
            <Button onClick={mint} disabled={pending}>
              {pending ? "Generating…" : "Generate link"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
