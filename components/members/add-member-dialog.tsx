"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Search, Check } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CapabilityPicker } from "@/components/settings/capability-picker";
import { gqlAction } from "@/lib/graphql-client";
import { capabilitiesForRole } from "@/lib/membership-shared";
import type { Capability, Role } from "@/lib/types";
import type { UserSearchResult } from "@/lib/data/members";

/**
 * Add an already-registered user to the active team, choosing their role and
 * capabilities. Controlled (no trigger of its own) so it can be opened from the
 * Members page header or the overview "Add new" menu.
 */
export function AddMemberDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<UserSearchResult[]>([]);
  // Start true so the dialog shows "Searching…" on its first render rather than
  // flashing the empty-state before the initial roster fetch resolves.
  const [searching, setSearching] = React.useState(true);
  const [picked, setPicked] = React.useState<UserSearchResult | null>(null);
  const [role, setRole] = React.useState<Role>("member");
  const [caps, setCaps] = React.useState<Capability[]>(
    capabilitiesForRole("member"),
  );

  // Debounced username search. The empty query is a valid search that returns
  // the full available roster, so the list is populated as soon as the dialog
  // opens; typing filters it. Only run while the dialog is open and no user is
  // picked. All state writes happen asynchronously (inside the timeout) to
  // avoid cascading renders.
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
              teamName
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
    setRole("member");
    setCaps(capabilitiesForRole("member"));
  }

  function add() {
    if (!picked) return;
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($input: AddMemberInput!) {
          addExistingMember(input: $input) { userId }
        }`,
        { input: { userId: picked.userId, role, capabilities: caps } },
      );
      if (res.ok) {
        toast.success(`Added @${picked.username} to the team`);
        onOpenChange(false);
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
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a member</DialogTitle>
          <DialogDescription>
            Pick a registered user to add to this team. Search by username to
            narrow the list.
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
            <div className="min-h-24 max-h-72 space-y-1 overflow-y-auto">
              {searching && (
                <p className="px-1 py-2 text-sm text-muted-foreground">
                  Searching…
                </p>
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
                    style={{
                      backgroundColor: picked.avatarColor,
                      color: "#000",
                    }}
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
            onClick={() => onOpenChange(false)}
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
