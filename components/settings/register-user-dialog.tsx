"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, Users, UserCog } from "lucide-react";
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
import { CapabilityPicker } from "@/components/settings/capability-picker";
import { gqlAction } from "@/lib/graphql-client";
import { capabilitiesForRole } from "@/lib/membership-shared";
import type { Capability, Role } from "@/lib/types";

type Mode = "own_team" | "existing_teams";
type TeamOption = { id: string; name: string };
type Assignment = { role: Role; capabilities: Capability[] };

/**
 * Register a new instance user by minting a single-use registration link
 * (instance-admin only). The admin must first choose, up front, how the new
 * user's team is decided:
 *   • "Own team": the registrant names and owns a fresh team at registration
 *     (the first-run-style flow) — they ARE asked for a team name.
 *   • "Join existing teams": the admin assigns them to one or more existing
 *     teams now (role + capabilities each); the registrant is NOT asked for a
 *     team name, since the team(s) are already decided.
 * The choice is baked into the link and cannot be changed by the registrant.
 * Controlled (no trigger of its own) so it can be opened from the Users settings
 * header, the overview "Add new" menu, or the Add-member modal.
 */
export function RegisterUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [link, setLink] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<Mode | null>(null);
  const [teams, setTeams] = React.useState<TeamOption[]>([]);
  const [teamsLoaded, setTeamsLoaded] = React.useState(false);
  const [loadingTeams, setLoadingTeams] = React.useState(false);
  const [assign, setAssign] = React.useState<Record<string, Assignment>>({});

  function reset() {
    setLink(null);
    setMode(null);
    setAssign({});
    setTeams([]);
    setTeamsLoaded(false);
  }

  // Close from our own footer buttons. Flipping the controlled `open` prop does
  // NOT fire the Dialog's onOpenChange wrapper (Radix only fires it on internal
  // Esc/overlay/X), so we must reset here too — otherwise the next open reopens
  // into the stale link/mode/teams instead of a fresh mandatory mode picker.
  function close() {
    onOpenChange(false);
    reset();
  }

  // Lazily load the team roster the first time the admin picks existing_teams.
  // All state writes happen inside the deferred timeout (never synchronously in
  // the effect body) to avoid cascading renders.
  React.useEffect(() => {
    if (!open || mode !== "existing_teams" || teamsLoaded) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      if (!cancelled) setLoadingTeams(true);
      const res = await gqlAction<
        { allTeamsForAdmin: TeamOption[] },
        TeamOption[]
      >(`query { allTeamsForAdmin { id name } }`, {}, (d) => d.allTeamsForAdmin);
      if (cancelled) return;
      setTeams(res.ok && res.data ? res.data : []);
      setTeamsLoaded(true);
      setLoadingTeams(false);
      if (!res.ok) toast.error(res.error);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, mode, teamsLoaded]);

  function toggleTeam(id: string, on: boolean) {
    setAssign((prev) => {
      const next = { ...prev };
      if (on)
        next[id] = { role: "member", capabilities: capabilitiesForRole("member") };
      else delete next[id];
      return next;
    });
  }

  const selectedCount = Object.keys(assign).length;
  const canGenerate =
    mode === "own_team" || (mode === "existing_teams" && selectedCount > 0);

  function mint() {
    if (!mode) return;
    startTransition(async () => {
      const input =
        mode === "existing_teams"
          ? {
              mode,
              teamAssignments: Object.entries(assign).map(([teamId, a]) => ({
                teamId,
                role: a.role,
                capabilities: a.capabilities,
              })),
            }
          : { mode };
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
            Generate a single-use link. First choose whether the new user gets
            their own team or joins existing ones.
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
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2">
              <ModeCard
                active={mode === "own_team"}
                onClick={() => setMode("own_team")}
                icon={<UserCog className="size-4" />}
                title="Own team"
                desc="They name and own a new team when they register."
              />
              <ModeCard
                active={mode === "existing_teams"}
                onClick={() => setMode("existing_teams")}
                icon={<Users className="size-4" />}
                title="Join existing teams"
                desc="Assign them to one or more existing teams now."
              />
            </div>

            {mode === "own_team" && (
              <p className="text-sm text-muted-foreground">
                When they open the link they create their own team and become its
                owner — like the first-run setup.
              </p>
            )}

            {mode === "existing_teams" && (
              <div className="space-y-3">
                {loadingTeams && (
                  <p className="text-sm text-muted-foreground">Loading teams…</p>
                )}
                {!loadingTeams && teams.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    No teams exist yet.
                  </p>
                )}
                {teams.map((tm) => {
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
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {link ? "Done" : "Cancel"}
          </Button>
          {!link && (
            <Button onClick={mint} disabled={pending || !canGenerate}>
              {pending ? "Generating…" : "Generate link"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModeCard({
  active,
  onClick,
  icon,
  title,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors ${
        active ? "border-primary bg-accent" : "border-border hover:bg-accent"
      }`}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
      </span>
      <span className="text-xs text-muted-foreground">{desc}</span>
    </button>
  );
}
