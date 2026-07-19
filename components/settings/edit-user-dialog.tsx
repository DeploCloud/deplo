"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ban, Loader2 } from "lucide-react";
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
import { FieldLabel } from "@/components/ui/info-tip";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";
import { cn, timeAgo } from "@/lib/utils";
import type { UserDetailDTO } from "@/lib/data/members";

/* ------------------------------------------------------------------ */
/* Instance-wide user editor (shared)                                  */
/* ------------------------------------------------------------------ */

/** Header/identity seed — the minimum any caller already has on hand. */
export interface EditUserSeedUser {
  userId: string;
  username: string;
  name: string;
  avatarColor: string;
}

/**
 * Optional instant-render seed of the editable global flags. Callers that list
 * users already hold these (the settings Users panel), so the editor renders
 * immediately; callers that don't (the team Members page) omit it and the
 * editor initialises from the fetched `userDetail` instead.
 */
export interface EditUserSeedFlags {
  isInstanceAdmin: boolean;
  /** Owns the instance — see the owner lock in the component body. */
  isInstanceOwner: boolean;
  suspended: boolean;
  canExposePorts: boolean;
  canMountHostVolumes: boolean;
  createdAt: string;
  teamCount: number;
}

/**
 * The instance-admin editor for ONE user's global account — admin flag,
 * suspended state, infra grants and password. The same dialog opened from both
 * Settings → Users (seeded from the list row) and the team Members page (no
 * seed; it fetches the user first). Every field here is instance-wide, NOT
 * team-scoped — that distinction is why this is separate from the member
 * permissions editor. Backed by the `userDetail`/`updateUserAdmin` GraphQL
 * fields, both instance-admin only.
 */
export function EditUserDialog({
  user,
  seed,
  isSelf,
  open,
  onOpenChange,
}: {
  user: EditUserSeedUser;
  /** Present ⇒ render immediately; absent ⇒ fetch then render. */
  seed?: EditUserSeedFlags;
  isSelf: boolean;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  // Email, the team list and recent activity are never in a list row, so they
  // are always fetched. The editable flags come from `seed` when the caller has
  // them (instant render) or from this same fetch otherwise.
  const [detail, setDetail] = React.useState<UserDetailDTO | null>(null);
  const [pending, startTransition] = React.useTransition();

  const [admin, setAdmin] = React.useState(seed?.isInstanceAdmin ?? false);
  const [suspended, setSuspended] = React.useState(seed?.suspended ?? false);
  const [exposePorts, setExposePorts] = React.useState(
    seed?.canExposePorts ?? false,
  );
  const [mountHostVolumes, setMountHostVolumes] = React.useState(
    seed?.canMountHostVolumes ?? false,
  );
  const [password, setPassword] = React.useState("");
  // Suspending is destructive and sits among a stack of benign permission
  // switches, so turning it ON is gated behind a confirm modal. Reactivating is
  // safe and stays a single flip.
  const [confirmSuspend, setConfirmSuspend] = React.useState(false);
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
          createdAt
          isInstanceAdmin
          isInstanceOwner
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
      if (res.ok && res.data) {
        setDetail(res.data);
        // Seedless open (the Members page): the fetch is the only source of the
        // editable flags, so initialise them once it lands. Seeded opens already
        // hold authoritative values — never clobber a switch the user just flipped.
        if (!hasSeed) {
          setAdmin(res.data.isInstanceAdmin);
          setSuspended(res.data.suspended);
          setExposePorts(res.data.canExposePorts);
          setMountHostVolumes(res.data.canMountHostVolumes);
        }
      } else if (!res.ok) {
        toast.error(res.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [user.userId, hasSeed]);

  // Ready once the toggles are authoritative — instantly when seeded, otherwise
  // the moment the fetch resolves (setDetail re-renders and flips this true).
  const ready = hasSeed || detail != null;
  const createdAt = seed?.createdAt ?? detail?.createdAt ?? null;
  const teamCount = seed?.teamCount ?? detail?.teams.length ?? 0;

  // The instance owner's account is editable only by the owner themselves — no
  // other admin may demote, suspend or reset them, because all three are routes
  // to the same takeover (see lib/data/instance-owner.ts). Server-enforced; the
  // form goes read-only so the operator sees the rule instead of a toast.
  const isOwner = seed?.isInstanceOwner ?? detail?.isInstanceOwner ?? false;
  const ownerLocked = isOwner && !isSelf;
  // The two flags nobody may flip on the owner, the owner included: ownership
  // leaves only through a transfer that names a successor.
  const ownerFlagsLocked = isOwner;

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
            {detail?.email ?? "Instance-wide account & permissions."}
          </DialogDescription>
        </DialogHeader>

        {!ready ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading user…
          </div>
        ) : (
          <>
            {/* General information */}
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2 rounded-lg border border-border p-3">
                <Meta
                  label="Joined"
                  value={createdAt ? timeAgo(createdAt) : "—"}
                />
                <Meta label="Teams" value={String(teamCount)} />
                <Meta
                  label="Instance admin"
                  value={isOwner ? "Owner" : admin ? "Yes" : "No"}
                />
                <Meta
                  label="Status"
                  value={suspended ? "Suspended" : "Active"}
                />
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
              {ownerLocked && (
                <p className="rounded-lg border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
                  This account owns the instance. Only its owner can change it —
                  no other admin can demote, suspend or reset them. Ownership
                  moves only when the owner transfers it.
                </p>
              )}
              <ToggleRow
                title="Instance admin"
                detail={
                  ownerFlagsLocked
                    ? "The instance owner is always an instance admin. Transfer ownership first."
                    : "Manage all users, mint registration links, and administer any team."
                }
                checked={admin}
                disabled={isSelf || ownerFlagsLocked}
                onChange={setAdmin}
              />
              <ToggleRow
                title="Suspended"
                detail={
                  ownerFlagsLocked
                    ? "The instance owner's account can't be suspended."
                    : "Block this account from signing in. Memberships are kept."
                }
                checked={suspended}
                disabled={isSelf || ownerFlagsLocked}
                tone="destructive"
                // Turning suspension ON asks for confirmation first; turning it
                // back off (reactivating) is safe and applies immediately.
                onChange={(v) =>
                  v ? setConfirmSuspend(true) : setSuspended(false)
                }
              />
              {isSelf && (
                <p className="text-xs text-muted-foreground">
                  You can&apos;t change your own admin status or suspend
                  yourself.
                </p>
              )}
              <ToggleRow
                title="Publish ports"
                detail="Declare published ports in a compose stack — a service's ports: (bound to the host) or expose:. Public domains/routes don't need this. Instance admins always can."
                checked={admin || exposePorts}
                disabled={admin || ownerLocked}
                onChange={setExposePorts}
              />
              <ToggleRow
                title="Mount host volumes"
                detail="Bind-mount host filesystem paths into containers (compose and single-container). Instance admins always can."
                checked={admin || mountHostVolumes}
                disabled={admin || ownerLocked}
                onChange={setMountHostVolumes}
              />
              {admin && (
                <p className="text-xs text-muted-foreground">
                  Instance admins hold the publish-ports and host-volume grants
                  implicitly.
                </p>
              )}
              <div className="space-y-2">
                <FieldLabel
                  htmlFor="reset-pw"
                  info={
                    <>
                      Sets a new password for this account. Leave blank to keep
                      the current one; a new password must be at least 8
                      characters.
                    </>
                  }
                >
                  Reset password (optional)
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
                      : "New password — leave blank to keep current"
                  }
                />
              </div>
            </div>

            {/* Extra safety gate for the one destructive toggle. It only stages
                the change (the switch flips on); "Save changes" still commits. */}
            <ConfirmAction
              open={confirmSuspend}
              onOpenChange={setConfirmSuspend}
              title={`Suspend @${user.username}?`}
              description="This blocks the account from signing in. Team memberships are kept and you can reactivate at any time. Takes effect when you save your changes."
              confirmLabel="Suspend account"
              onConfirm={async () => {
                setSuspended(true);
                return { ok: true };
              }}
            />
          </>
        )}

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
            disabled={
              !ready ||
              pending ||
              ownerLocked ||
              (password.length > 0 && password.length < 8)
            }
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
  tone = "default",
  onChange,
}: {
  title: string;
  detail: string;
  checked: boolean;
  disabled?: boolean;
  /** "destructive" sets a row apart from the benign permission switches: a Ban
   *  glyph on the title always, and a red accent once the toggle is active. */
  tone?: "default" | "destructive";
  onChange: (v: boolean) => void;
}) {
  const danger = tone === "destructive" && checked;
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border p-3 transition-colors",
        danger ? "border-destructive/40 bg-destructive/5" : "border-border",
      )}
    >
      <div>
        <p
          className={cn(
            "flex items-center gap-1.5 text-sm font-medium",
            danger && "text-destructive",
          )}
        >
          {tone === "destructive" && <Ban className="size-3.5 shrink-0" />}
          {title}
        </p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}
