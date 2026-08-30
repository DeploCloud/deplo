"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Search, Check, Loader2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UserAvatar } from "@/components/shared/user-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { FieldLabel } from "@/components/ui/info-tip";
import { gql, gqlAction } from "@/lib/graphql-client";
import { CAPABILITY_META } from "@/lib/membership-shared";
import { ALL_CAPABILITIES } from "@/lib/types";
import type { Capability } from "@/lib/types";

/** A current access grant on the folder, as returned by `folderGrants`. */
interface FolderGrant {
  folderId: string;
  userId: string;
  username: string;
  name: string;
  avatarColor: string;
  avatarUrl: string | null;
  capabilities: string[];
  isOwner: boolean;
}

/** A team member who could be granted access, from `folderShareCandidates`. */
interface ShareCandidate {
  userId: string;
  username: string;
  name: string;
  avatarColor: string;
  avatarUrl: string | null;
}

const GRANTS_QUERY = `query($folderId: ID!) {
  folderGrants(folderId: $folderId) {
    folderId
    userId
    username
    name
    avatarColor
    avatarUrl
    capabilities
    isOwner
  }
}`;

const GRANTABLE_QUERY = `query($folderId: ID!) {
  grantableFolderCapabilities(folderId: $folderId)
}`;

const CANDIDATES_QUERY = `query($folderId: ID!, $query: String) {
  folderShareCandidates(folderId: $folderId, query: $query) {
    userId
    username
    name
    avatarColor
    avatarUrl
  }
}`;

/** Two-letter avatar initials from a username, matching the member picker. */
function initials(username: string): string {
  return username.slice(0, 2).toUpperCase();
}

/**
 * Manage who can access a folder.
 */
export function ShareFolderDialog({
  folderId,
  folderName,
  open,
  onOpenChange,
}: {
  folderId: string;
  folderName: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  // Current grants + the caps this granter may hand out. Loaded on open.
  const [grants, setGrants] = React.useState<FolderGrant[]>([]);
  const [grantable, setGrantable] = React.useState<Capability[]>([]);
  const [loading, setLoading] = React.useState(true);

  // "Add person" sub-flow: search → pick a candidate → choose caps → save.
  const [query, setQuery] = React.useState("");
  const [candidates, setCandidates] = React.useState<ShareCandidate[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [picked, setPicked] = React.useState<ShareCandidate | null>(null);
  const [caps, setCaps] = React.useState<Set<Capability>>(() => new Set());

  // The grantable set, ordered canonically and with `view` dropped - that one is
  // always implied by the server, so it's never a togglable box here.
  const togglableCaps = React.useMemo(
    () =>
      ALL_CAPABILITIES.filter(
        (c) => c !== "view" && grantable.includes(c) && c in CAPABILITY_META,
      ),
    [grantable],
  );

  // (Re)load the current grants + grantable caps. Called on open and after every
  // mutation so the two lists always reflect the latest server state.
  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      const [g, cap] = await Promise.all([
        gql<{ folderGrants: FolderGrant[] }>(GRANTS_QUERY, { folderId }),
        gql<{ grantableFolderCapabilities: string[] }>(GRANTABLE_QUERY, {
          folderId,
        }),
      ]);
      setGrants(g.folderGrants);
      setGrantable(cap.grantableFolderCapabilities as Capability[]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load access");
    } finally {
      setLoading(false);
    }
  }, [folderId]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- `reload` flips the loading flag before its first await; the fetch is the external system this effect exists to sync with
    if (open) reload();
  }, [open, reload]);

  // Debounced candidate search, mirroring the add-member dialog: the empty query
  // returns the full addable roster, so the list populates as the sub-flow opens.
  // Only runs while adding (no candidate picked yet) and the dialog is open.
  React.useEffect(() => {
    if (!open || picked) return;
    const q = query.trim();
    let cancelled = false;
    const t = setTimeout(
      async () => {
        if (!cancelled) setSearching(true);
        const res = await gqlAction<
          { folderShareCandidates: ShareCandidate[] },
          ShareCandidate[]
        >(
          CANDIDATES_QUERY,
          { folderId, query: q },
          (d) => d.folderShareCandidates,
        );
        if (!cancelled) {
          setCandidates(res.ok && res.data ? res.data : []);
          setSearching(false);
        }
      },
      q ? 200 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, picked, open, folderId]);

  function resetAddFlow() {
    setQuery("");
    setCandidates([]);
    setPicked(null);
    setCaps(new Set());
  }

  function pickCandidate(c: ShareCandidate) {
    setPicked(c);
    // Seed with every grantable cap ticked - sharing a folder usually means
    // "give them the same access I have"; the granter can trim before saving.
    setCaps(new Set(togglableCaps));
  }

  function toggleCap(cap: Capability, on: boolean) {
    setCaps((prev) => {
      const next = new Set(prev);
      if (on) next.add(cap);
      else next.delete(cap);
      return next;
    });
  }

  // Enter submits the step the dialog is actually on: `save` no-ops until a
  // candidate is picked, so Enter in the search field just stays put (the
  // candidate buttons handle their own Enter natively - they're type="button").
  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    save();
  }

  function save() {
    if (!picked) return;
    // `view` is always implied by the server; send the ticked caps as-is.
    const capabilities = togglableCaps.filter((c) => caps.has(c));
    // The grantee joins the list NOW, with exactly the capabilities that were
    // ticked; the server's own answer replaces the whole list a moment later.
    const chosen = picked;
    const before = grants;
    setGrants((prev) => [
      ...prev.filter((g) => g.userId !== chosen.userId),
      {
        folderId,
        userId: chosen.userId,
        username: chosen.username,
        name: chosen.name,
        avatarColor: chosen.avatarColor,
        avatarUrl: chosen.avatarUrl,
        capabilities,
        isOwner: false,
      },
    ]);
    resetAddFlow();
    startTransition(async () => {
      const res = await gqlAction<
        { setFolderGrant: FolderGrant[] },
        FolderGrant[]
      >(
        `mutation($folderId: ID!, $userId: ID!, $capabilities: [String!]!) {
          setFolderGrant(folderId: $folderId, userId: $userId, capabilities: $capabilities) {
            folderId
            userId
            username
            name
            avatarColor
            avatarUrl
            capabilities
            isOwner
          }
        }`,
        { folderId, userId: chosen.userId, capabilities },
        (d) => d.setFolderGrant,
      );
      if (res.ok) {
        toast.success(`Shared with @${chosen.username}`);
        if (res.data) setGrants(res.data);
        reload();
        router.refresh();
      } else {
        setGrants(before);
        toast.error(res.error);
      }
    });
  }

  function removeGrant(g: FolderGrant) {
    // The grantee leaves the list on the click; the server's own answer (the
    // grants that remain) lands a moment later and replaces it either way.
    const before = grants;
    setGrants((prev) => prev.filter((x) => x.userId !== g.userId));
    startTransition(async () => {
      const res = await gqlAction<
        { removeFolderGrant: FolderGrant[] },
        FolderGrant[]
      >(
        `mutation($folderId: ID!, $userId: ID!) {
          removeFolderGrant(folderId: $folderId, userId: $userId) {
            folderId
            userId
            username
            name
            avatarColor
            avatarUrl
            capabilities
            isOwner
          }
        }`,
        { folderId, userId: g.userId },
        (d) => d.removeFolderGrant,
      );
      if (res.ok) {
        toast.success(`Removed @${g.username}`);
        if (res.data) setGrants(res.data);
        reload();
        router.refresh();
      } else {
        setGrants(before);
        toast.error(res.error);
      }
    });
  }

  // Short "Deploy, Manage domains" summary of a grantee's caps (view dropped,
  // since it's always present). Empty ⇒ "View only".
  function capSummary(capabilities: string[]): string {
    const labels = ALL_CAPABILITIES.filter(
      (c) => c !== "view" && capabilities.includes(c),
    ).map((c) => CAPABILITY_META[c].label);
    return labels.length ? labels.join(", ") : "View only";
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) resetAddFlow();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share “{folderName}”</DialogTitle>
          <DialogDescription>
            Give other members access to this folder and the apps inside it.
          </DialogDescription>
        </DialogHeader>

        {/* Current access */}
        <div className="space-y-2">
          <Label>People with access</Label>
          {loading ? (
            <div className="space-y-1" aria-hidden>
              {[0, 1].map((i) => (
                <div key={i} className="flex items-center gap-3 px-2 py-2">
                  <Skeleton shimmer className="size-8 shrink-0 rounded-full" />
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Skeleton shimmer className="h-3.5 w-28 rounded" />
                    <Skeleton shimmer className="h-3 w-20 rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-1">
              {grants.map((g) => (
                <div
                  key={g.userId}
                  className="flex items-center gap-3 rounded-lg border border-border px-2 py-2"
                >
                  <UserAvatar
                    name={g.name}
                    username={g.username}
                    avatarColor={g.avatarColor}
                    avatarUrl={g.avatarUrl}
                    size="lg"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      @{g.username}
                      {g.isOwner && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          Owner
                        </span>
                      )}
                    </p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {g.isOwner ? "Full access" : capSummary(g.capabilities)}
                    </p>
                  </div>
                  {/* The owner row can't be revoked - ownership isn't a grant. */}
                  {!g.isOwner && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove @${g.username}`}
                      disabled={pending}
                      onClick={() => removeGrant(g)}
                    >
                      <X className="size-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <form className="grid gap-4" onSubmit={onSubmit}>
          {/* Add a person */}
          <div className="space-y-3 border-t border-border pt-4">
            {!picked ? (
              <>
                <Label>Add someone</Label>
                <div className="relative">
                  <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by username"
                    className="pl-9"
                  />
                </div>
                <div className="focus-safe-scroll max-h-44 min-h-20 space-y-1 overflow-y-auto">
                  {searching && (
                    <div className="space-y-1" aria-hidden>
                      {[0, 1].map((i) => (
                        <div
                          key={i}
                          className="flex items-center gap-3 px-2 py-2"
                        >
                          <Skeleton
                            shimmer
                            className="size-8 shrink-0 rounded-full"
                          />
                          <Skeleton shimmer className="h-3.5 w-28 rounded" />
                        </div>
                      ))}
                    </div>
                  )}
                  {!searching && candidates.length === 0 && (
                    <p className="px-1 py-2 text-sm text-muted-foreground">
                      {query.trim()
                        ? "No matching members."
                        : "No members left to add."}
                    </p>
                  )}
                  {candidates.map((c) => (
                    <button
                      type="button"
                      key={c.userId}
                      onClick={() => pickCandidate(c)}
                      className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-transparent px-2 py-2 text-left hover:border-border hover:bg-accent"
                    >
                      <UserAvatar
                        name={c.name}
                        username={c.username}
                        avatarColor={c.avatarColor}
                        avatarUrl={c.avatarUrl}
                        size="lg"
                      />
                      <span className="flex flex-col">
                        <span className="text-sm font-medium">
                          @{c.username}
                        </span>
                        {c.name && (
                          <span className="text-xs text-muted-foreground">
                            {c.name}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between rounded-lg border border-border p-3">
                  <div className="flex items-center gap-3">
                    <UserAvatar
                      name={picked.name}
                      username={picked.username}
                      avatarColor={picked.avatarColor}
                      avatarUrl={picked.avatarUrl}
                      size="lg"
                    />
                    <div>
                      <p className="text-sm font-medium">@{picked.username}</p>
                      {picked.name && (
                        <p className="text-xs text-muted-foreground">
                          {picked.name}
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

                <div className="space-y-2">
                  <FieldLabel
                    info="You can only grant capabilities you hold yourself on this folder. View access is always included and can't be removed."
                    docs="roles.folderGrant"
                  >
                    What can they do?
                  </FieldLabel>
                  {/* `view` is implied, always on - shown as a fixed, disabled row
                      rather than a togglable box. */}
                  <div className="flex items-start gap-3 rounded-md px-1 py-1.5 opacity-70">
                    <input
                      type="checkbox"
                      checked
                      disabled
                      className="mt-0.5 size-4 accent-primary"
                    />
                    <div className="space-y-0.5">
                      <p className="text-sm leading-none font-medium">
                        {CAPABILITY_META.view.label}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {CAPABILITY_META.view.description}
                      </p>
                    </div>
                  </div>
                  {togglableCaps.map((cap) => {
                    const id = `sharecap-${folderId}-${cap}`;
                    return (
                      <label
                        key={cap}
                        htmlFor={id}
                        className="flex cursor-pointer items-start gap-3 rounded-md px-1 py-1.5 hover:bg-accent"
                      >
                        <input
                          id={id}
                          type="checkbox"
                          checked={caps.has(cap)}
                          onChange={(e) => toggleCap(cap, e.target.checked)}
                          className="mt-0.5 size-4 accent-primary"
                        />
                        <div className="space-y-0.5">
                          <p className="text-sm leading-none font-medium">
                            {CAPABILITY_META[cap].label}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {CAPABILITY_META[cap].description}
                          </p>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Close
            </Button>
            {/* Always mounted, disabled until there is someone to share with:
                a button that appears on the pick would move Close across the
                footer, and the disabled state says the action exists. */}
            <Button type="submit" disabled={pending || !picked}>
              <span className="grid place-items-center">
                <span
                  className={cn(
                    "col-start-1 row-start-1 flex items-center gap-2",
                    pending && "invisible",
                  )}
                >
                  <Check className="size-4" />
                  Share
                </span>
                {pending && (
                  <Loader2 className="col-start-1 row-start-1 size-4 animate-spin" />
                )}
              </span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
