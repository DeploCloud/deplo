"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  UserPlus,
  Trash2,
  Pencil,
  MoreHorizontal,
  UserCog,
  Crown,
  ShieldCheck,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CapabilityPicker } from "@/components/settings/capability-picker";
import { AddMemberDialog } from "@/components/members/add-member-dialog";
import { RegisterUserDialog } from "@/components/settings/register-user-dialog";
import { EditUserDialog } from "@/components/settings/edit-user-dialog";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";
import type { Capability, Role } from "@/lib/types";
import type { MemberDTO } from "@/lib/data/members";

export function MembersManager({
  members,
  currentUserId,
  canManage,
  isAdmin = false,
}: {
  members: MemberDTO[];
  currentUserId: string;
  canManage: boolean;
  /** Instance admin: can create a brand-new user from the add-member modal. */
  isAdmin?: boolean;
}) {
  const [addOpen, setAddOpen] = React.useState(false);
  const [userOpen, setUserOpen] = React.useState(false);
  // The viewer's own rank in this team. Owners (the founder OR an assigned
  // owner) may grant the owner role and act on other owners; everyone else is
  // capped at member/viewer. Derived from the member list — no extra query.
  const viewerIsOwner = members.some(
    (m) => m.userId === currentUserId && m.role === "owner",
  );
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">Members</CardTitle>
          <CardDescription>
            {members.length} member{members.length === 1 ? "" : "s"} in this
            team.
          </CardDescription>
        </div>
        {(isAdmin || canManage) && (
          <div className="flex items-center gap-2">
            {/* Instance admins get a shortcut into instance-wide user
                administration, sitting just before the team-scoped add. */}
            {isAdmin && (
              <Button variant="outline" size="sm" asChild>
                <Link href="/settings/users">
                  <UserCog className="size-4" />
                  Manage users
                </Link>
              </Button>
            )}
            {canManage && (
              <>
                <Button size="sm" onClick={() => setAddOpen(true)}>
                  <UserPlus className="size-4" />
                  Add member
                </Button>
                <AddMemberDialog
                  open={addOpen}
                  onOpenChange={setAddOpen}
                  canCreateUser={isAdmin}
                  canAssignOwner={viewerIsOwner}
                  onCreateUser={() => setUserOpen(true)}
                />
                {isAdmin && (
                  <RegisterUserDialog
                    open={userOpen}
                    onOpenChange={setUserOpen}
                  />
                )}
              </>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {members.map((m) => (
            <MemberCard
              key={m.userId}
              member={m}
              isSelf={m.userId === currentUserId}
              canManage={canManage}
              isAdmin={isAdmin}
              viewerIsOwner={viewerIsOwner}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function MemberCard({
  member,
  isSelf,
  canManage,
  isAdmin,
  viewerIsOwner,
}: {
  member: MemberDTO;
  isSelf: boolean;
  canManage: boolean;
  /** Viewer is an instance admin — may edit any user's global account. */
  isAdmin: boolean;
  /** Viewer holds the owner role in this team (founder or assigned owner). */
  viewerIsOwner: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [editOpen, setEditOpen] = React.useState(false);
  const [userEditOpen, setUserEditOpen] = React.useState(false);
  // The ABSOLUTE owner (founder / "crown") is immutable — never editable or
  // removable by anyone (the data layer enforces this too). An *assigned* owner
  // (owner role, but not the founder) can be edited/removed, but only BY another
  // owner — a plain manager can't act on any owner.
  const isFounder = member.isPrimaryOwner;
  const isOwner = member.role === "owner";

  // What this viewer may do to THIS member. Editing team permissions and
  // removing need `manage_members`, a non-founder target, and — when the target
  // is an (assigned) owner — that the viewer is themselves an owner. Editing the
  // global account is an instance-admin power, independent of team role.
  const canEditPerms = canManage && !isFounder && (!isOwner || viewerIsOwner);
  const canEditGlobal = isAdmin;
  const canRemove = canManage && !isFounder && (!isOwner || viewerIsOwner);
  // The ⋯ menu only appears on OTHER members with at least one available
  // action — never on your own card.
  const actionable = !isSelf && (canEditPerms || canEditGlobal);

  function remove() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($userId: String!) { removeMember(userId: $userId) }`,
        { userId: member.userId },
      );
      if (res.ok) {
        toast.success("Member removed");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  const inner = (
    <div className="flex h-full flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex w-full items-center gap-3">
        <Avatar>
          <AvatarFallback
            style={{ backgroundColor: member.avatarColor, color: "#000" }}
          >
            {member.username.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 text-sm font-medium">
            <span className="truncate">@{member.username}</span>
            {/* Discord-style crown next to the nickname for the absolute owner,
                and a shield for an instance admin — both can show at once. */}
            {isFounder && (
              <SimpleTooltip content="Primary owner — created this team; can't be removed or demoted">
                <span className="shrink-0 leading-none">
                  <Crown className="size-3.5 text-amber-500" aria-label="Primary owner" />
                </span>
              </SimpleTooltip>
            )}
            {member.isInstanceAdmin && (
              <SimpleTooltip content="Instance admin — platform-wide administrator">
                <span className="shrink-0 leading-none">
                  <ShieldCheck className="size-3.5 text-sky-500" aria-label="Instance admin" />
                </span>
              </SimpleTooltip>
            )}
            {isSelf && (
              <span className="ml-0.5 shrink-0 text-xs text-muted-foreground">
                (you)
              </span>
            )}
          </p>
          {member.name && member.name !== member.username && (
            <p className="truncate text-xs text-muted-foreground">
              {member.name}
            </p>
          )}
        </div>
        {actionable && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="-mr-1 shrink-0"
                aria-label={`@${member.username} menu`}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {canEditPerms && (
                <SimpleTooltip
                  content="Adjust this member's role and capabilities in the team"
                  side="left"
                >
                  <DropdownMenuItem
                    onSelect={(e: Event) => {
                      e.preventDefault();
                      setEditOpen(true);
                    }}
                  >
                    <Pencil className="size-4" />
                    Edit permissions
                  </DropdownMenuItem>
                </SimpleTooltip>
              )}
              {canEditGlobal && (
                <SimpleTooltip
                  content="View and edit this user's instance-wide account and permissions"
                  side="left"
                >
                  <DropdownMenuItem
                    onSelect={(e: Event) => {
                      e.preventDefault();
                      setUserEditOpen(true);
                    }}
                  >
                    <UserCog className="size-4" />
                    Manage user account
                  </DropdownMenuItem>
                </SimpleTooltip>
              )}
              {canRemove && (
                <>
                  <DropdownMenuSeparator />
                  <SimpleTooltip
                    content="Remove this member from the team"
                    side="left"
                  >
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={pending}
                      onSelect={(e: Event) => {
                        e.preventDefault();
                        remove();
                      }}
                    >
                      <Trash2 className="size-4" />
                      Remove from team
                    </DropdownMenuItem>
                  </SimpleTooltip>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {/* The absolute owner reads as "Primary owner"; an assigned owner is a
            plain "Owner". This is the functional rank, not just decoration. */}
        {isFounder ? (
          <Badge className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <Crown className="size-3" />
            Primary owner
          </Badge>
        ) : (
          <Badge variant="outline" className="capitalize">
            {member.role}
          </Badge>
        )}
        <Badge variant="outline">
          {member.capabilities.length} capabilit
          {member.capabilities.length === 1 ? "y" : "ies"}
        </Badge>
      </div>
    </div>
  );

  const dialogs = (
    <>
      {editOpen && (
        <EditMemberDialog
          member={member}
          canAssignOwner={viewerIsOwner}
          open={editOpen}
          onOpenChange={setEditOpen}
        />
      )}
      {userEditOpen && (
        <EditUserDialog
          user={{
            userId: member.userId,
            username: member.username,
            name: member.name,
            avatarColor: member.avatarColor,
          }}
          isSelf={isSelf}
          open={userEditOpen}
          onOpenChange={setUserEditOpen}
        />
      )}
    </>
  );

  // Inert cards (your own, the owner with nothing to manage, or a viewer who
  // can't act) get no ⋯ menu. No triggers ⇒ no dialogs to mount.
  if (!actionable) return inner;

  return (
    <>
      {inner}
      {dialogs}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Edit member permissions                                             */
/* ------------------------------------------------------------------ */

function EditMemberDialog({
  member,
  canAssignOwner,
  open,
  onOpenChange,
}: {
  member: MemberDTO;
  /** Viewer is an owner — only then may "Owner" be offered as a role. */
  canAssignOwner: boolean;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [role, setRole] = React.useState<Role>(member.role);
  const [caps, setCaps] = React.useState<Capability[]>(member.capabilities);

  function submit() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($input: UpdateMemberInput!) {
          updateMember(input: $input) { userId }
        }`,
        { input: { userId: member.userId, role, capabilities: caps } },
      );
      if (res.ok) {
        toast.success("Permissions updated");
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
          <DialogTitle>Edit @{member.username}&apos;s permissions</DialogTitle>
          <DialogDescription>
            Adjust this member&apos;s role and capabilities in the team.
          </DialogDescription>
        </DialogHeader>
        <CapabilityPicker
          role={role}
          capabilities={caps}
          onRoleChange={setRole}
          onCapabilitiesChange={setCaps}
          idPrefix={`edit-${member.userId}`}
          availableRoles={canAssignOwner ? undefined : ["member", "viewer"]}
        />
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? "Saving…" : "Save permissions"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
