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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CapabilityPicker } from "@/components/settings/capability-picker";
import { AddMemberDialog } from "@/components/members/add-member-dialog";
import { gqlAction } from "@/lib/graphql-client";
import type { Capability, Role } from "@/lib/types";
import type { MemberDTO } from "@/lib/data/members";

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

  return (
    <div className="flex items-center justify-between rounded-lg border border-border p-3">
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
        {canManage && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Member menu">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  setEditOpen(true);
                }}
              >
                <Pencil className="size-4" />
                Edit permissions
              </DropdownMenuItem>
              {!isSelf && (
                <DropdownMenuItem
                  variant="destructive"
                  disabled={pending}
                  onSelect={(e) => {
                    e.preventDefault();
                    remove();
                  }}
                >
                  <Trash2 className="size-4" />
                  Remove
                </DropdownMenuItem>
              )}
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
