"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  UserPlus,
  Search,
  Trash2,
  MoreHorizontal,
  Pencil,
  Check,
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CapabilityPicker } from "@/components/settings/capability-picker";
import {
  searchUsersAction,
  addExistingMemberAction,
  updateMemberAction,
  removeMemberAction,
} from "@/lib/actions/members";
import { capabilitiesForRole } from "@/lib/membership-shared";
import type { Capability, Role } from "@/lib/types";
import type { MemberDTO, UserSearchResult } from "@/lib/data/members";

export function MembersManager({
  members,
  currentUserId,
  canManage,
}: {
  members: MemberDTO[];
  currentUserId: string;
  canManage: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">Members</CardTitle>
          <CardDescription>
            {members.length} member{members.length === 1 ? "" : "s"} in this team.
          </CardDescription>
        </div>
        {canManage && <AddMemberDialog />}
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
      const res = await removeMemberAction(member.userId);
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
/* Add member — search registered users by username                    */
/* ------------------------------------------------------------------ */

function AddMemberDialog() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<UserSearchResult[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [picked, setPicked] = React.useState<UserSearchResult | null>(null);
  const [role, setRole] = React.useState<Role>("member");
  const [caps, setCaps] = React.useState<Capability[]>(
    capabilitiesForRole("member"),
  );

  // Debounced username search. All state writes happen asynchronously (inside
  // the timeout), never synchronously in the effect body, to avoid cascading
  // renders — the empty-query reset is handled on the same tick.
  React.useEffect(() => {
    if (picked) return;
    const q = query.trim();
    let cancelled = false;
    const t = setTimeout(async () => {
      if (!q) {
        if (!cancelled) {
          setResults([]);
          setSearching(false);
        }
        return;
      }
      setSearching(true);
      const res = await searchUsersAction(q);
      if (!cancelled) {
        setResults(res.ok && res.data ? res.data : []);
        setSearching(false);
      }
    }, q ? 200 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, picked]);

  function reset() {
    setQuery("");
    setResults([]);
    setPicked(null);
    setRole("member");
    setCaps(capabilitiesForRole("member"));
  }

  function add() {
    if (!picked) return;
    startTransition(async () => {
      const res = await addExistingMemberAction({
        userId: picked.userId,
        role,
        capabilities: caps,
      });
      if (res.ok) {
        toast.success(`Added @${picked.username} to the team`);
        setOpen(false);
        reset();
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <Button size="sm" onClick={() => setOpen(true)}>
        <UserPlus className="size-4" />
        Add member
      </Button>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a member</DialogTitle>
          <DialogDescription>
            Search registered users by username and add them to this team.
          </DialogDescription>
        </DialogHeader>

        {!picked ? (
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by username…"
                className="pl-9"
                autoFocus
              />
            </div>
            <div className="min-h-24 space-y-1">
              {searching && (
                <p className="px-1 py-2 text-sm text-muted-foreground">
                  Searching…
                </p>
              )}
              {!searching && query.trim() && results.length === 0 && (
                <p className="px-1 py-2 text-sm text-muted-foreground">
                  No matching users.
                </p>
              )}
              {results.map((u) => (
                <button
                  key={u.userId}
                  onClick={() => setPicked(u)}
                  className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-transparent px-2 py-2 text-left hover:border-border hover:bg-accent"
                >
                  <Avatar className="size-8">
                    <AvatarFallback
                      style={{ backgroundColor: u.avatarColor, color: "#000" }}
                    >
                      {u.username.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="flex flex-col">
                    <span className="text-sm font-medium">@{u.username}</span>
                    {u.teamName && (
                      <span className="text-xs text-muted-foreground">
                        {u.teamName}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div className="flex items-center gap-3">
                <Avatar className="size-8">
                  <AvatarFallback
                    style={{ backgroundColor: picked.avatarColor, color: "#000" }}
                  >
                    {picked.username.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <p className="text-sm font-medium">@{picked.username}</p>
                  {picked.teamName && (
                    <p className="text-xs text-muted-foreground">
                      {picked.teamName}
                    </p>
                  )}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setPicked(null)}>
                Change
              </Button>
            </div>
            <CapabilityPicker
              role={role}
              capabilities={caps}
              onRoleChange={setRole}
              onCapabilitiesChange={setCaps}
              idPrefix="addmember"
            />
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={add} disabled={pending || !picked}>
            {pending ? (
              "Adding…"
            ) : (
              <>
                <Check className="size-4" />
                Add to team
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
      const res = await updateMemberAction({
        userId: member.userId,
        role,
        capabilities: caps,
      });
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
