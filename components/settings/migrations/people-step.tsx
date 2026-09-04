"use client";

import * as React from "react";
import { Link2, Loader2, UserPlus } from "lucide-react";

import { TeamAvatar, UserAvatar } from "@/components/shared/user-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/shared/copy-button";
import { EmptyState } from "@/components/shared/empty-state";
import { StepShell } from "./step-shell";
import { copyFor, type SourceKind, stepDocs } from "./sources";
import type { Invite, PlanMember } from "./types";

/**
 * One team's people: who was on the panel's team, their links once minted, and
 * the extra link for whoever was not there at all. A single migration is one
 * group; several teams at once are several, each under its own name.
 */
export interface PeopleGroup {
  key: string;
  team: { name: string; avatarUrl: string | null };
  people: PlanMember[];
  /** Null until the links have been minted; then one entry per person. */
  invites: Invite[] | null;
  /** False until there is a run to record the invites against. */
  canInvite: boolean;
  onInvite: () => void;
  inviteLink: string | null;
  minting: boolean;
  onMintLink: () => void;
}

/**
 * The people who were on that panel, as the team page draws people. Each link is
 * single-use and expires on its own, so minting one for somebody who is never
 * invited costs nothing.
 */
export function PeopleStep({
  kind,
  groups,
  inviting,
  onContinue,
}: {
  /** Which panel these people came from. */
  kind: SourceKind | null;
  /** One per team that came over, in the order they did. */
  groups: PeopleGroup[];
  inviting: boolean;
  onContinue: () => void;
}) {
  // Once per team, on arrival. A ref rather than the `invites == null` test
  // alone, because development re-invokes effects and a second call mints a
  // second link for everybody.
  const asked = React.useRef(new Set<string>());
  React.useEffect(() => {
    for (const g of groups) {
      if (asked.current.has(g.key) || g.invites != null || !g.canInvite)
        continue;
      if (g.people.length === 0) continue;
      asked.current.add(g.key);
      g.onInvite();
    }
  }, [groups]);

  const several = groups.length > 1;
  const nobody = groups.every((g) => g.people.length === 0);

  return (
    <StepShell
      title={`The people who were on ${copyFor(kind).name}`}
      docs={stepDocs(kind, "people")}
      lead="Everyone joins with a single-use link and arrives as a plain member, whatever they were over there. You can invite anyone else later from Members."
    >
      {nobody && !several && (
        <EmptyState
          icon={UserPlus}
          title="Nobody else to bring over"
          description={`${copyFor(kind).name} listed no other members for this team.`}
        />
      )}
      {groups.map((g) => (
        <TeamPeople
          key={g.key}
          group={g}
          kind={kind}
          inviting={inviting}
          named={several}
        />
      ))}

      {/* One button, because there is nothing on this step to fill in: pressing
          Continue without touching anything IS skipping it. A Skip beside a
          Continue that does the same thing is two names for one action. */}
      <div className="flex justify-end">
        <Button onClick={onContinue}>Continue</Button>
      </div>
    </StepShell>
  );
}

/** One team's cards and its extra link - under the team's name when several
 *  came over, so nobody hands a link for one team to a person of another. */
function TeamPeople({
  group: g,
  kind,
  inviting,
  named,
}: {
  group: PeopleGroup;
  kind: SourceKind | null;
  inviting: boolean;
  named: boolean;
}) {
  const byEmail = new Map((g.invites ?? []).map((i) => [i.email, i]));
  const body = (
    <>
      {g.people.length === 0 ? (
        named ? (
          <p className="text-sm text-muted-foreground">
            {copyFor(kind).name} listed no other members for this team.
          </p>
        ) : null
      ) : (
        // Two columns at most: the wizard's column is a fixed measure now, so
        // a viewport-driven third column would be three 180px cards holding
        // email addresses.
        <div className="grid gap-3 sm:grid-cols-2">
          {g.people.map((p) => (
            <PersonCard
              panel={copyFor(kind).name}
              key={p.email}
              person={p}
              invite={byEmail.get(p.email) ?? null}
              pending={inviting || g.invites == null}
            />
          ))}
        </div>
      )}

      {/* For whoever was not on that panel at all. Secondary, and below: it is the
          exception, and the cards above are the errand. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={g.onMintLink} disabled={g.minting}>
          {g.minting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Link2 className="size-4" />
          )}
          {g.inviteLink ? "Create another link" : "Create an extra invite link"}
        </Button>
        {g.inviteLink && (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Input readOnly value={g.inviteLink} className="min-w-0 flex-1" />
            <CopyButton value={g.inviteLink} />
          </div>
        )}
      </div>
    </>
  );
  if (!named) return body;
  return (
    <section className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-center gap-2 text-sm">
        <TeamAvatar name={g.team.name} avatarUrl={g.team.avatarUrl} size="sm" />
        <span className="font-medium">{g.team.name}</span>
      </div>
      {body}
    </section>
  );
}

/** Two letters for the avatar. The local part, which is the half people read. */
function PersonCard({
  person,
  invite,
  pending,
  panel,
}: {
  person: PlanMember;
  invite: Invite | null;
  /** The links are still being minted, so the foot of the card is not empty. */
  pending: boolean;
  /** The panel's name. Coolify hides a member's role, so the line goes with it. */
  panel: string;
}) {
  return (
    <div className="flex h-full flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex w-full items-center gap-3">
        {/* Their real picture once they already have an account here; the
            neutral mark otherwise, with their name or the local part of their
            address for the letters. */}
        <UserAvatar
          name={person.name}
          username={person.email}
          avatarUrl={person.avatarUrl}
          size="lg"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{person.email}</p>
          {person.sourceRole && (
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {person.sourceRole} on {panel}
            </p>
          )}
        </div>
      </div>

      {/* On its own row, not beside the address: an email is the identity here
          and a badge sharing its line takes the half that says which person. */}
      {person.hasAccount && (
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="info">Has an account</Badge>
        </div>
      )}

      {/* The link is the point of the card, so it sits at its foot with a rule
          above it - the same shape a member card uses for its badges. */}
      <div className="mt-auto border-t border-border pt-3">
        {invite?.link ? (
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={invite.link}
              className="h-8 min-w-0 flex-1"
            />
            <CopyButton value={invite.link} />
          </div>
        ) : invite ? (
          // No link means Deplo did something else with them - added them
          // straight away, or could not. Its own message says which.
          <p className="text-xs text-muted-foreground">
            {invite.message ?? invite.outcome}
          </p>
        ) : pending ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Creating their link
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">No link for this one.</p>
        )}
      </div>
    </div>
  );
}
