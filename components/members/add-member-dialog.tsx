"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Search, Check, UserPlus, ChevronRight, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TeamAvatar, UserAvatar } from "@/components/shared/user-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AnimatedHeight } from "@/components/shared/animated-height";
import { Skeleton } from "@/components/ui/skeleton";
import { RoleSelect } from "@/components/members/role-select";
import { gqlAction } from "@/lib/graphql-client";
import type { UserSearchResult } from "@/lib/data/members/user-search";
import type { TeamRoleDTO } from "@/lib/data/roles/role-list";

export function AddMemberDialog({
  open,
  onOpenChange,
  canCreateUser = false,
  canAssignOwner = false,
  onCreateUser,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  canCreateUser?: boolean;
  canAssignOwner?: boolean;
  onCreateUser?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<UserSearchResult[]>([]);
  const [searching, setSearching] = React.useState(true);
  const [picked, setPicked] = React.useState<UserSearchResult | null>(null);
  const [roles, setRoles] = React.useState<TeamRoleDTO[]>([]);
  const [roleId, setRoleId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const res = await gqlAction<{ teamRoles: TeamRoleDTO[] }, TeamRoleDTO[]>(
        `query {
          teamRoles {
            id
            name
            description
            builtinKey
            capabilities
            memberCount
            modified
            locked
            createdAt
          }
        }`,
        {},
        (d) => d.teamRoles,
      );
      if (cancelled || !res.ok || !res.data) return;
      setRoles(res.data);
      const assignable = res.data.filter(
        (r) => canAssignOwner || r.builtinKey !== "owner",
      );
      setRoleId(
        (current) =>
          current ??
          assignable.find((r) => r.builtinKey === "member")?.id ??
          assignable[0]?.id ??
          null,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [open, canAssignOwner]);

  React.useEffect(() => {
    if (!open || picked) return;
    const q = query.trim();
    let cancelled = false;
    const t = setTimeout(
      async () => {
        if (!cancelled) setSearching(true);
        const res = await gqlAction<
          { searchUsers: UserSearchResult[] },
          UserSearchResult[]
        >(
          `query($query: String!) {
            searchUsers(query: $query) {
              userId
              username
              name
              avatarColor
              avatarUrl
              teamName
              teamAvatarUrl
            }
          }`,
          { query: q },
          (d) => d.searchUsers,
        );
        if (!cancelled) {
          setResults(res.ok && res.data ? res.data : []);
          setSearching(false);
        }
      },
      q ? 200 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, picked, open]);

  function reset() {
    setQuery("");
    setResults([]);
    setSearching(true);
    setPicked(null);
    setRoleId(null);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    add();
  }

  function add() {
    if (!picked || !roleId) return;
    const chosen = { picked, roleId };
    onOpenChange(false);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($input: AddMemberInput!) {
          addExistingMember(input: $input) { userId }
        }`,
        { input: { userId: chosen.picked.userId, roleId: chosen.roleId } },
      );
      if (res.ok) {
        toast.success(`Added @${chosen.picked.username} to the team`);
        reset();
      } else {
        setPicked(chosen.picked);
        setRoleId(chosen.roleId);
        onOpenChange(true);
        toast.error(res.error);
      }
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a member</DialogTitle>
          <DialogDescription>
            Pick a registered user to add to this team. Search by username to
            narrow the list.
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={onSubmit}>
          <AnimatedHeight className="grid gap-4" scroll={false}>
            {!picked ? (
              <div className="space-y-3">
                <div className="relative">
                  <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by username"
                    className="pl-9"
                    autoFocus
                  />
                </div>
                <div className="focus-safe-scroll max-h-44 min-h-24 space-y-1 overflow-y-auto">
                  {searching && (
                    <div className="space-y-1" aria-hidden>
                      {[0, 1, 2].map((i) => (
                        <div
                          key={i}
                          className="flex items-center gap-3 px-2 py-2"
                        >
                          <Skeleton
                            shimmer
                            className="size-8 shrink-0 rounded-full"
                          />
                          <div className="flex flex-1 flex-col gap-1.5">
                            <Skeleton shimmer className="h-3.5 w-28 rounded" />
                            <Skeleton shimmer className="h-3 w-20 rounded" />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {!searching && results.length === 0 && (
                    <p className="px-1 py-2 text-sm text-muted-foreground">
                      {query.trim()
                        ? "No matching users."
                        : "No users available to add."}
                    </p>
                  )}
                  {results.map((u) => (
                    <button
                      type="button"
                      key={u.userId}
                      onClick={() => setPicked(u)}
                      className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-transparent px-2 py-2 text-left hover:border-border hover:bg-accent"
                    >
                      <UserAvatar
                        name={u.name}
                        username={u.username}
                        avatarUrl={u.avatarUrl}
                        size="lg"
                      />
                      <span className="flex flex-col">
                        <span className="text-sm font-medium">
                          @{u.username}
                        </span>
                        {u.teamName && (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <TeamAvatar
                              name={u.teamName}
                              avatarUrl={u.teamAvatarUrl}
                              size="xs"
                            />
                            {u.teamName}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
                {canCreateUser && (
                  <div className="space-y-3 pt-1">
                    <div className="flex items-center gap-3">
                      <span className="h-px flex-1 bg-border" />
                      <span className="text-xs text-muted-foreground">
                        not registered yet?
                      </span>
                      <span className="h-px flex-1 bg-border" />
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        onOpenChange(false);
                        reset();
                        onCreateUser?.();
                      }}
                      className="group flex w-full cursor-pointer items-center gap-3 rounded-lg border border-dashed border-border px-3 py-2.5 text-left transition-colors hover:border-primary/50 hover:bg-accent"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-wash-strong text-primary transition-colors group-hover:bg-primary-wash-strong">
                        <UserPlus className="size-4" />
                      </span>
                      <span className="flex flex-col">
                        <span className="text-sm font-medium">
                          Create a new user
                        </span>
                        <span className="text-xs text-muted-foreground">
                          Register someone who isn&apos;t on Deplo yet
                        </span>
                      </span>
                      <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" />
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between rounded-lg border border-border p-3">
                  <div className="flex items-center gap-3">
                    <UserAvatar
                      name={picked.name}
                      username={picked.username}
                      avatarUrl={picked.avatarUrl}
                      size="lg"
                    />
                    <div>
                      <p className="text-sm font-medium">@{picked.username}</p>
                      {picked.teamName && (
                        <p className="flex items-center gap-1 text-xs text-muted-foreground">
                          <TeamAvatar
                            name={picked.teamName}
                            avatarUrl={picked.teamAvatarUrl}
                            size="xs"
                          />
                          {picked.teamName}
                        </p>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPicked(null)}
                  >
                    Change
                  </Button>
                </div>
                <RoleSelect
                  roles={roles}
                  value={roleId}
                  onChange={setRoleId}
                  canAssignOwner={canAssignOwner}
                />
              </div>
            )}
          </AnimatedHeight>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                onOpenChange(false);
                reset();
              }}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !picked || !roleId}>
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              Add to team
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
