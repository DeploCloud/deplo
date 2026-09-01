"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Link2,
  Loader2,
  Search,
  UserPlus,
  Users,
} from "lucide-react";
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
import { TeamAvatar } from "@/components/shared/user-avatar";
import { ChoiceCard } from "@/components/shared/choice-card";
import { WizardStepper } from "@/components/shared/wizard-stepper";
import { atClock } from "@/components/settings/registration-link-row";
import { copyText } from "@/lib/clipboard";
import { gqlAction } from "@/lib/graphql-client";
import { capabilitiesForRole } from "@/lib/membership-shared";
import { cn } from "@/lib/utils";
import type { Capability, Role } from "@/lib/types";

type TeamOption = { id: string; name: string; avatarUrl: string | null };
type Assignment = { role: Role; capabilities: Capability[] };
type Choice = "own_team" | "existing_teams";
type StepId = "access" | "teams" | "link";

const STEP_LABEL: Record<StepId, string> = {
  access: "Access",
  teams: "Teams",
  link: "Link",
};

/**
 * Register a new instance user by minting a single-use registration link
 * (instance-admin only), as a wizard.
 */
export function RegisterUserWizard({
  open,
  onOpenChange,
  pinActiveTeam = true,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Pre-select the join branch with the active team ticked (default true). */
  pinActiveTeam?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [step, setStep] = React.useState<StepId>("access");
  const [choice, setChoice] = React.useState<Choice | null>(null);
  const [link, setLink] = React.useState<string | null>(null);
  const [expiresAt, setExpiresAt] = React.useState<string | null>(null);
  const [teams, setTeams] = React.useState<TeamOption[]>([]);
  const [teamsLoaded, setTeamsLoaded] = React.useState(false);
  const [loadingTeams, setLoadingTeams] = React.useState(false);
  const [assign, setAssign] = React.useState<Record<string, Assignment>>({});
  const [teamQuery, setTeamQuery] = React.useState("");

  function reset() {
    setStep("access");
    setChoice(null);
    setLink(null);
    setExpiresAt(null);
    setAssign({});
    setTeams([]);
    setTeamsLoaded(false);
    setTeamQuery("");
  }

  // Close from our own footer buttons.
  function close() {
    onOpenChange(false);
    reset();
  }

  // Load the admin's own teams the first time the dialog opens, and pre-select
  // the active team unless the caller opted out. All state writes are deferred
  // to avoid cascading renders.
  React.useEffect(() => {
    if (!open || teamsLoaded) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      if (!cancelled) setLoadingTeams(true);
      const res = await gqlAction<
        { myTeams: TeamOption[]; viewerTeam: { id: string } | null },
        { myTeams: TeamOption[]; activeTeamId: string | null }
      >(`query { myTeams { id name } viewerTeam { id } }`, {}, (d) => ({
        myTeams: d.myTeams,
        activeTeamId: d.viewerTeam?.id ?? null,
      }));
      if (cancelled) return;
      const myTeams = res.ok && res.data ? res.data.myTeams : [];
      const activeId = res.ok && res.data ? res.data.activeTeamId : null;
      setTeams(myTeams);
      if (
        pinActiveTeam &&
        activeId &&
        myTeams.some((tm) => tm.id === activeId)
      ) {
        setChoice("existing_teams");
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
  const teamFilter = teamQuery.trim().toLowerCase();
  // Filtering only hides rows - a ticked team the query hides stays ticked, which
  // is why the step's subtitle carries the running count.
  const shownTeams = teamFilter
    ? teams.filter((tm) => tm.name.toLowerCase().includes(teamFilter))
    : teams;

  // The fork IS the step count: the own-team branch has nothing to configure, so
  // it never shows an empty middle step.
  const steps: StepId[] = [
    "access",
    ...(choice === "existing_teams" ? (["teams"] as const) : []),
    "link",
  ];
  const index = steps.indexOf(step);
  const valid: Record<StepId, boolean> = {
    access: choice !== null,
    teams: selectedCount > 0,
    link: link !== null,
  };
  /** The step the primary button leads to, or null when it mints instead. */
  const nextStep =
    step === "access" && choice === "existing_teams" ? "teams" : null;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (step === "link") return close();
    if (nextStep) return setStep(nextStep);
    if (!valid[step]) return;
    mint();
  }

  function mint() {
    startTransition(async () => {
      const input =
        choice === "existing_teams"
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
        // The server stamps the TTL from the same instant it answered, so a
        // clock started here is right to the second, and it saves a round trip
        // just to read back the row we minted.
        setExpiresAt(new Date(Date.now() + 24 * 3_600_000).toISOString());
        setStep("link");
        router.refresh();
      } else if (!res.ok) {
        toast.error(res.error);
      }
    });
  }

  async function copy() {
    if (!link) return;
    if (!(await copyText(link))) return;
    toast.success("Registration link copied");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      {/* Fixed height so the stepper and the footer hold their place instead of
          jumping between a two-card choice, a team list and a link. */}
      <DialogContent
        selfManaged
        className="h-[min(92vh,34rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-lg"
      >
        <DialogHeader className="space-y-0 pr-8">
          <DialogTitle className="sr-only">Register a new user</DialogTitle>
          <DialogDescription className="sr-only">
            Generate a single-use link. You never set their password.
          </DialogDescription>
          <WizardStepper
            steps={steps.map((id) => ({ id, label: STEP_LABEL[id] }))}
            current={step}
            // Once the link exists there is nothing left to edit: re-minting from
            // a revisited step would quietly leave a second live link behind.
            reachable={(s) =>
              link
                ? s === "link"
                : steps.slice(0, steps.indexOf(s)).every((p) => valid[p])
            }
            onSelect={setStep}
          />
        </DialogHeader>

        <form
          onSubmit={onSubmit}
          className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-4 overflow-hidden"
        >
          <div className="focus-safe-scroll flex flex-col overflow-y-auto">
            <div className="m-auto flex w-full max-w-sm shrink-0 flex-col gap-5 py-2">
              {step === "access" && (
                <>
                  <div className="flex flex-col items-center gap-2 text-center">
                    <span className="flex size-10 items-center justify-center rounded-full bg-primary/10">
                      <UserPlus className="size-5 text-primary" />
                    </span>
                    <h2 className="text-base font-semibold lg:text-lg">
                      Where does this person work?
                    </h2>
                    <p className="text-sm text-balance text-muted-foreground">
                      You can change this later from their account page.
                    </p>
                  </div>
                  <div
                    role="radiogroup"
                    aria-label="Access"
                    className="space-y-2"
                  >
                    <ChoiceCard
                      title="They get their own team"
                      blurb="They name and own a fresh team when they open the link."
                      icon={UserPlus}
                      selected={choice === "own_team"}
                      onSelect={() => setChoice("own_team")}
                    />
                    <ChoiceCard
                      title="They join your teams"
                      blurb="Pick which of your teams they join, and what they can do there."
                      icon={Users}
                      selected={choice === "existing_teams"}
                      disabled={teamsLoaded && teams.length === 0}
                      disabledNote="You are not in any team yet."
                      onSelect={() => setChoice("existing_teams")}
                    />
                  </div>
                </>
              )}

              {step === "teams" && (
                <>
                  <div className="flex flex-col items-center gap-2 text-center">
                    <span className="flex size-10 items-center justify-center rounded-full bg-primary/10">
                      <Users className="size-5 text-primary" />
                    </span>
                    <h2 className="text-base font-semibold lg:text-lg">
                      Which teams?
                    </h2>
                    <p className="text-sm text-balance text-muted-foreground">
                      They can be in more than one.
                      {selectedCount > 0 && ` ${selectedCount} selected.`}
                    </p>
                  </div>

                  <div className="relative">
                    <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={teamQuery}
                      onChange={(e) => setTeamQuery(e.target.value)}
                      placeholder="Search teams"
                      aria-label="Search teams"
                      className="h-9 pl-9"
                      // A filter box, not a field of the form: Enter here would
                      // otherwise mint the link mid-search.
                      onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
                    />
                  </div>

                  {/* No scroller of its own: the dialog's body is the ONE
                      scrolling region, so a long team list never traps the wheel
                      in a nested box. */}
                  <div className="space-y-2">
                    {loadingTeams &&
                      [0, 1].map((i) => (
                        <div
                          key={i}
                          className="rounded-lg border border-border p-3"
                        >
                          <div className="flex items-center gap-2">
                            <Skeleton shimmer className="size-4 rounded" />
                            <Skeleton shimmer className="size-5 rounded-full" />
                            <Skeleton shimmer className="h-4 w-32 rounded" />
                          </div>
                        </div>
                      ))}

                    {!loadingTeams && shownTeams.length === 0 && (
                      <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                        {teamFilter
                          ? `No team matches “${teamQuery.trim()}”.`
                          : "You are not in any team yet."}
                      </p>
                    )}

                    {!loadingTeams &&
                      shownTeams.map((tm) => {
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
                                onCheckedChange={(v) =>
                                  toggleTeam(tm.id, v === true)
                                }
                              />
                              {/* The same mark the topbar switcher shows, so a
                                  team looks the same wherever it is named. */}
                              <TeamAvatar
                                name={tm.name}
                                avatarUrl={tm.avatarUrl}
                                size="sm"
                              />
                              <span className="text-sm font-medium">
                                {tm.name}
                              </span>
                            </label>
                            {/**
                             * Which of that team's two joinable default roles they land in.
                             */}
                            {a && (
                              <div className="mt-3 flex flex-wrap gap-2">
                                {(["member", "viewer"] as Role[]).map((r) => (
                                  <button
                                    key={r}
                                    type="button"
                                    aria-pressed={a.role === r}
                                    onClick={() =>
                                      setAssign((p) => ({
                                        ...p,
                                        [tm.id]: {
                                          role: r,
                                          capabilities: capabilitiesForRole(r),
                                        },
                                      }))
                                    }
                                    className={cn(
                                      "rounded-md border px-2.5 py-1 text-xs font-medium capitalize transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                                      a.role === r
                                        ? "border-primary bg-primary/5 text-foreground"
                                        : "border-border text-muted-foreground hover:bg-accent",
                                    )}
                                  >
                                    {r}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>
                </>
              )}

              {step === "link" && link && (
                <>
                  <div className="flex flex-col items-center gap-2 text-center">
                    <span className="flex size-10 items-center justify-center rounded-full bg-primary/10">
                      <Link2 className="size-5 text-primary" />
                    </span>
                    <h2 className="text-base font-semibold lg:text-lg">
                      Share this link
                    </h2>
                    <p className="text-sm text-balance text-muted-foreground">
                      It works once and expires in 24 hours
                      {expiresAt ? ` - ${atClock(expiresAt)}` : ""}. You can
                      copy it again from Settings &rarr; Users until then.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      readOnly
                      value={link}
                      className="font-mono text-xs"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={copy}
                      aria-label="Copy link"
                    >
                      <Copy className="size-4" />
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setStep(steps[index - 1])}
              disabled={index === 0 || step === "link" || pending}
              className={cn((index === 0 || step === "link") && "invisible")}
            >
              <ChevronLeft className="size-4" />
              Back
            </Button>
            <div className="flex gap-2">
              {step !== "link" && (
                <Button type="button" variant="outline" onClick={close}>
                  Cancel
                </Button>
              )}
              {step === "link" ? (
                <Button type="submit">
                  <Check className="size-4" />
                  Done
                </Button>
              ) : (
                <Button
                  type="submit"
                  disabled={pending || loadingTeams || !valid[step]}
                  aria-busy={pending}
                >
                  {/* Spinner over the label rather than a changed label - the
                      button keeps its width and the footer doesn't jump. */}
                  <span className="grid place-items-center">
                    <span
                      className={cn(
                        "col-start-1 row-start-1 flex items-center gap-1.5",
                        pending && "invisible",
                      )}
                    >
                      {nextStep ? (
                        <>
                          Continue
                          <ChevronRight className="size-4" />
                        </>
                      ) : (
                        "Generate link"
                      )}
                    </span>
                    {pending && (
                      <Loader2 className="col-start-1 row-start-1 size-4 animate-spin" />
                    )}
                  </span>
                </Button>
              )}
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
