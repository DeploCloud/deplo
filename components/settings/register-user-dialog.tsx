"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { CapabilityPicker } from "@/components/settings/capability-picker";
import { gqlAction } from "@/lib/graphql-client";
import { capabilitiesForRole } from "@/lib/membership-shared";
import type { Capability, Role } from "@/lib/types";

type TeamOption = { id: string; name: string };
type Assignment = { role: Role; capabilities: Capability[] };

/**
 * Register a new instance user by minting a single-use registration link
 * (instance-admin only). The admin optionally adds the new user to one or more
 * of THEIR OWN teams (role + capabilities each); if none are selected the link
 * is an "own team" link — the registrant names and owns a fresh team when they
 * open it, like the first-run setup. There is no up-front mode choice anymore:
 * the mode is derived from whether any team is selected.
 *
 * `pinActiveTeam` (default true) pre-selects the active team on open, so creating
 * a user from a team's Members page defaults to adding them to that team without
 * asking. The instance-wide Settings → Users panel opts out (no "current team"
 * context there). Only the viewer's own teams are offered, and the server
 * re-checks, so an admin can place a new user only into teams they belong to.
 *
 * Controlled (no trigger of its own) so it can be opened from the Users settings
 * header, the overview "Add new" menu, or the Add-member modal.
 */
export function RegisterUserDialog({
  open,
  onOpenChange,
  pinActiveTeam = true,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Pre-select the active team when the dialog opens (default true). */
  pinActiveTeam?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [link, setLink] = React.useState<string | null>(null);
  const [teams, setTeams] = React.useState<TeamOption[]>([]);
  const [teamsLoaded, setTeamsLoaded] = React.useState(false);
  const [loadingTeams, setLoadingTeams] = React.useState(false);
  const [assign, setAssign] = React.useState<Record<string, Assignment>>({});

  function reset() {
    setLink(null);
    setAssign({});
    setTeams([]);
    setTeamsLoaded(false);
  }

  // Close from our own footer buttons. Flipping the controlled `open` prop does
  // NOT fire the Dialog's onOpenChange wrapper (Radix only fires it on internal
  // Esc/overlay/X), so we must reset here too — otherwise the next open reopens
  // into the stale link/teams instead of a fresh picker.
  function close() {
    onOpenChange(false);
    reset();
  }

  // Load the admin's own teams the first time the dialog opens, and pre-select
  // the active team unless the caller opted out. Only the viewer's teams are
  // offered (the server re-checks membership on mint). All state writes are
  // deferred to avoid cascading renders.
  React.useEffect(() => {
    if (!open || teamsLoaded) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      if (!cancelled) setLoadingTeams(true);
      const res = await gqlAction<
        { myTeams: TeamOption[]; viewerTeam: { id: string } | null },
        { myTeams: TeamOption[]; activeTeamId: string | null }
      >(
        `query { myTeams { id name } viewerTeam { id } }`,
        {},
        (d) => ({ myTeams: d.myTeams, activeTeamId: d.viewerTeam?.id ?? null }),
      );
      if (cancelled) return;
      const myTeams = res.ok && res.data ? res.data.myTeams : [];
      const activeId = res.ok && res.data ? res.data.activeTeamId : null;
      setTeams(myTeams);
      // Default the selection to the active team (the one we're creating the
      // user "inside"), when the viewer actually belongs to it.
      if (pinActiveTeam && activeId && myTeams.some((tm) => tm.id === activeId)) {
        setAssign({
          [activeId]: {
            role: "member",
            capabilities: capabilitiesForRole("member"),
          },
        });
      }
      setTeamsLoaded(true);
      setLoadingTeams(false);
      if (!res.ok) toast.error(res.error);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, teamsLoaded, pinActiveTeam]);

  function toggleTeam(id: string, on: boolean) {
    setAssign((prev) => {
      const next = { ...prev };
      if (on)
        next[id] = {
          role: "member",
          capabilities: capabilitiesForRole("member"),
        };
      else delete next[id];
      return next;
    });
  }

  const selectedCount = Object.keys(assign).length;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Once the link is minted the form only shows it (the footer's single button
    // just closes), so Enter must not re-mint a second link.
    if (link) return;
    mint();
  }

  function mint() {
    startTransition(async () => {
      // No team selected ⇒ an "own team" link (the registrant creates their own
      // team). One or more ⇒ an "existing_teams" link pre-assigning them.
      const input =
        selectedCount > 0
          ? {
              mode: "existing_teams" as const,
              teamAssignments: Object.entries(assign).map(([teamId, a]) => ({
                teamId,
                role: a.role,
                capabilities: a.capabilities,
              })),
            }
          : { mode: "own_team" as const };
      const res = await gqlAction<
        { mintRegistrationLink: string },
        { link: string }
      >(
        `mutation($input: MintRegistrationLinkInput!) {
          mintRegistrationLink(input: $input)
        }`,
        { input },
        (d) => ({ link: d.mintRegistrationLink }),
      );
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
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Register a new user</DialogTitle>
          <DialogDescription>
            Generate a single-use link. Optionally add them to one of your teams
            — or leave none and they&apos;ll create their own.
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={onSubmit}>
          {link ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Share this link. It works once and expires in 24 hours.
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
            <div className="space-y-3">
              <p className="text-sm font-medium">Add to your teams (optional)</p>

              {loadingTeams &&
                [0, 1].map((i) => (
                  <div key={i} className="rounded-lg border border-border p-3">
                    <div className="flex items-center gap-2">
                      <Skeleton shimmer className="size-4 rounded" />
                      <Skeleton shimmer className="h-4 w-32 rounded" />
                    </div>
                  </div>
                ))}

              {!loadingTeams &&
                teams.map((tm) => {
                  const a = assign[tm.id];
                  return (
                    <div
                      key={tm.id}
                      className="rounded-lg border border-border p-3"
                    >
                      <label
                        htmlFor={`regteam-${tm.id}`}
                        className="flex cursor-pointer items-center gap-2"
                      >
                        <Checkbox
                          id={`regteam-${tm.id}`}
                          checked={!!a}
                          onCheckedChange={(v) => toggleTeam(tm.id, v === true)}
                        />
                        <span className="text-sm font-medium">{tm.name}</span>
                      </label>
                      {a && (
                        <div className="mt-3">
                          <CapabilityPicker
                            role={a.role}
                            capabilities={a.capabilities}
                            availableRoles={["member", "viewer"]}
                            onRoleChange={(role) =>
                              setAssign((p) => ({
                                ...p,
                                [tm.id]: { ...p[tm.id], role },
                              }))
                            }
                            onCapabilitiesChange={(capabilities) =>
                              setAssign((p) => ({
                                ...p,
                                [tm.id]: { ...p[tm.id], capabilities },
                              }))
                            }
                            idPrefix={`regteam-${tm.id}`}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}

              {/* "faglielo notare se non seleziona nulla" — make the own-team
                  outcome explicit whenever no team is selected. */}
              {!loadingTeams && teamsLoaded && selectedCount === 0 && (
                <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                  No team selected — the new user will create and own their own
                  team when they open the link.
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={close}>
              {link ? "Done" : "Cancel"}
            </Button>
            {!link && (
              <Button type="submit" disabled={pending || loadingTeams}>
                {pending ? "Generating…" : "Generate link"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
