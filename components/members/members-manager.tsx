"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UserPlus, Trash2, MoreHorizontal, Pencil } from "lucide-react";
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
import { CapabilityPicker } from "@/components/settings/capability-picker";
import { AddMemberDialog } from "@/components/members/add-member-dialog";
import { gqlAction } from "@/lib/graphql-client";
import type { Capability, Role } from "@/lib/types";
import type { MemberDTO } from "@/lib/data/members";

/**
 * The menu-primitive set used to render a member row's actions once and reuse
 * them for BOTH the ⋯ dropdown (left-click) and the right-click context menu —
 * same items, same handlers, no duplication. Radix dropdown and context menus
 * share an isomorphic API, so the renderer just takes whichever set applies.
 */
type MenuKit = {
  Item: React.ElementType;
  Separator: React.ElementType;
};

const DROPDOWN_KIT: MenuKit = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
};
const CONTEXT_KIT: MenuKit = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
};

export function MembersManager({
  members,
  currentUserId,
  canManage,
}: {
  members: MemberDTO[];
  currentUserId: string;
  canManage: boolean;
}) {
  const [addOpen, setAddOpen] = React.useState(false);
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
        {canManage && (
          <>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <UserPlus className="size-4" />
              Add member
            </Button>
            <AddMemberDialog open={addOpen} onOpenChange={setAddOpen} />
          </>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {members.map((m) => (
          <MemberRow
            key={m.userId}
            member={m}
            isSelf={m.userId === currentUserId}
            canManage={canManage}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function MemberRow({
  member,
  isSelf,
  canManage,
}: {
  member: MemberDTO;
  isSelf: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [editOpen, setEditOpen] = React.useState(false);
  // The team owner is immutable — no edit/remove controls (the data layer
  // enforces this too). They keep their "Owner" role badge.
  const isOwner = member.role === "owner";

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

  // The row's actions, rendered once for whichever menu primitive is passed.
  // Each item carries a native `title` so hovering it for ~a second explains
  // what it does (reliable inside menus, unlike a nested styled tooltip).
  const menu = (K: MenuKit) => (
    <>
      <K.Item
        onSelect={(e: Event) => {
          e.preventDefault();
          setEditOpen(true);
        }}
        title="Adjust this member's role and capabilities"
      >
        <Pencil className="size-4" />
        Edit permissions
      </K.Item>
      {!isSelf && (
        <K.Item
          variant="destructive"
          disabled={pending}
          onSelect={(e: Event) => {
            e.preventDefault();
            remove();
          }}
          title="Remove this member from the team"
        >
          <Trash2 className="size-4" />
          Remove
        </K.Item>
      )}
    </>
  );

  const row = (
    <div
      onContextMenu={(e) => e.stopPropagation()}
      className="flex items-center justify-between rounded-lg border border-border p-3"
    >
      <div className="flex items-center gap-3">
        <Avatar>
          <AvatarFallback
            style={{ backgroundColor: member.avatarColor, color: "#000" }}
          >
            {member.username.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div>
          <p className="text-sm font-medium">
            @{member.username}
            {isSelf && (
              <span className="ml-2 text-xs text-muted-foreground">(you)</span>
            )}
          </p>
          {member.name && member.name !== member.username && (
            <p className="text-xs text-muted-foreground">{member.name}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="capitalize">
          {member.role}
        </Badge>
        {canManage && !isOwner && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Member menu">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {menu(DROPDOWN_KIT)}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {editOpen && (
        <EditMemberDialog
          member={member}
          open={editOpen}
          onOpenChange={setEditOpen}
        />
      )}
    </div>
  );

  // The owner row (and rows the viewer can't manage) has no actions, so it
  // gets no right-click menu — the global shell menu still opens there.
  if (!canManage || isOwner) return row;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        {menu(CONTEXT_KIT)}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/* ------------------------------------------------------------------ */
/* Edit member permissions                                             */
/* ------------------------------------------------------------------ */

function EditMemberDialog({
  member,
  open,
  onOpenChange,
}: {
  member: MemberDTO;
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
