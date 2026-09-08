"use client";

import * as React from "react";
import { Link2, Loader2, UserPlus } from "lucide-react";

import { TeamAvatar, UserAvatar } from "@/components/shared/user-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CopyButton } from "@/components/shared/copy-button";
import { DownloadButton } from "@/components/shared/download-button";
import { EmptyState } from "@/components/shared/empty-state";
import { ListToolbar } from "@/components/shared/list-toolbar";
import { StepShell } from "./step-shell";
import { copyFor, type SourceKind, stepDocs } from "./sources";
import {
  ALL_TEAMS,
  filterPeople,
  hasLink,
  linkGroups,
  linksCsv,
  linksTsv,
  mergePeople,
  notesFor,
  teamsOf,
  type MergedPerson,
  type PersonLanding,
} from "./people";
import type { Invite } from "./types";

/** One team of the migration: who the panel listed on it, and the extra link
 *  for whoever was not there at all. */
export interface PeopleGroup {
  key: string;
  team: { name: string; avatarUrl: string | null };
  people: Invite[];
  inviteLink: string | null;
  minting: boolean;
  onMintLink: () => void;
}

/**
 * The people who were on that panel, as the team page draws people: one card per
 * address, whatever number of teams they were on, because one address is one
 * account here and one link.
 */
export function PeopleStep({
  kind,
  groups,
  onContinue,
}: {
  /** Which panel these people came from. */
  kind: SourceKind | null;
  /** One per team that came over, in the order they did. */
  groups: PeopleGroup[];
  onContinue: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const [team, setTeam] = React.useState(ALL_TEAMS);

  const panel = copyFor(kind).name;
  const people = React.useMemo(() => mergePeople(groups), [groups]);
  const teams = teamsOf(people);
  const shown = filterPeople(people, query, team);
  const anyLink = people.some(hasLink);
  const single = groups.length === 1;

  return (
    <StepShell
      hero
      title={`The people who were on ${panel}`}
      docs={stepDocs(kind, "people")}
      lead="Everyone joins with a single-use link and arrives as a plain member, whatever they were over there. You can invite anyone else later from Members."
    >
      {people.length === 0 ? (
        <EmptyState
          icon={UserPlus}
          title="Nobody else to bring over"
          description={`${panel} listed no other members${single ? " for this team" : ""}.`}
        />
      ) : (
        <>
          {/* One person needs no search box, and neither does a single team. */}
          {people.length > 1 && (
            <ListToolbar
              query={query}
              onQuery={setQuery}
              placeholder="Search people"
              filters={
                teams.length > 1 && (
                  <Select value={team} onValueChange={setTeam}>
                    <SelectTrigger className="w-full sm:w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_TEAMS}>All teams</SelectItem>
                      {teams.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )
              }
              action={
                anyLink && (
                  <div className="flex gap-2">
                    {/* Read at click time, so both follow the filter rather than
                        whatever was on screen when the step mounted. */}
                    <CopyButton
                      label="Copy all links"
                      value={() => linksTsv(shown)}
                      className="h-9 px-4 text-sm"
                    />
                    <DownloadButton
                      label="CSV"
                      filename="deplo-invite-links.csv"
                      value={() => linksCsv(shown)}
                      className="h-9 px-4 text-sm"
                    />
                  </div>
                )
              }
            />
          )}

          {/* One team names itself once: a chip repeating it on every card is the
              same word five times, and a link still has to say which team. */}
          {teams.length === 1 && (
            <div className="flex items-center gap-2 text-sm">
              <TeamAvatar
                name={groups[0]!.team.name}
                avatarUrl={groups[0]!.team.avatarUrl}
                size="sm"
              />
              <span className="min-w-0 truncate font-medium">
                {groups[0]!.team.name}
              </span>
            </div>
          )}

          {shown.length === 0 ? (
            <EmptyState
              icon={UserPlus}
              title="No matching people"
              description="Nobody here matches the current search and filter."
            />
          ) : (
            // Two columns at most: the column is a fixed measure even on this
            // wider step, so a third would be three cards holding an address.
            <div className="grid gap-3 sm:grid-cols-2">
              {shown.map((p) => (
                <PersonCard
                  key={p.email}
                  person={p}
                  panel={panel}
                  activeTeam={team}
                  onPickTeam={teams.length > 1 ? setTeam : null}
                />
              ))}
            </div>
          )}

          {!single && <ExtraLinks groups={groups} />}
        </>
      )}

      {/* No Skip: there is nothing here to fill in, so pressing Continue without
          touching anything IS skipping it, and two names for one action is one
          too many. With a single team its extra link shares this row. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {single ? <ExtraLink group={groups[0]!} /> : <span />}
        <Button onClick={onContinue}>Continue</Button>
      </div>
    </StepShell>
  );
}

/** One person, their teams, and the one link that joins them to all of them. */
function PersonCard({
  person,
  panel,
  activeTeam,
  onPickTeam,
}: {
  person: MergedPerson;
  /** The panel's name. Coolify hides a member's role, so the line goes with it. */
  panel: string;
  activeTeam: string;
  /** Null when one team landed: it is named above the grid instead. */
  onPickTeam: ((team: string) => void) | null;
}) {
  const links = linkGroups(person);
  const notes = notesFor(person);
  const named = person.name.trim().length > 0;

  return (
    <div className="flex h-full flex-col gap-3 rounded-lg border border-border bg-background p-4">
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
          <p className="truncate text-sm font-medium">
            {named ? person.name : person.email}
          </p>
          {/* The address stays visible whatever the panel called them: it is
              what gets pasted into a mail. */}
          {named && (
            <p className="truncate text-xs text-muted-foreground">
              {person.email}
            </p>
          )}
          {person.sourceRole && (
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {person.sourceRole} on {panel}
            </p>
          )}
        </div>
      </div>

      {/* On its own row, not beside the address: an email is the identity here
          and a badge sharing its line takes the half that says which person. */}
      <div className="flex flex-wrap gap-1.5">
        {person.hasAccount && <Badge variant="info">Has an account</Badge>}
        {onPickTeam &&
          person.landings.map((l) => (
            <TeamChip
              key={l.team}
              landing={l}
              active={activeTeam === l.team}
              onPick={onPickTeam}
            />
          ))}
      </div>

      {/* The link is the point of the card, so it sits at its foot with a rule
          above it - the same shape a member card uses for its badges. */}
      <div className="mt-auto space-y-2 border-t border-border pt-3">
        {links.map((g) => (
          <div key={g.link} className="space-y-1">
            <div className="flex items-center gap-2">
              <Input readOnly value={g.link} className="h-8 min-w-0 flex-1" />
              <CopyButton value={g.link} />
            </div>
            {/* Only when a second link exists does it matter which teams this
                one opens - one link opens the chips above and says so itself. */}
            {links.length > 1 && (
              <p className="text-xs text-muted-foreground">
                {g.teams.join(", ")}
              </p>
            )}
          </div>
        ))}
        {/* No link means Deplo did something else with them on that team - added
            them straight away, or could not. Its own message says which. */}
        {notes.map((n) => (
          <p key={n.message} className="text-xs text-muted-foreground">
            {n.teams.length > 0 && `${n.teams.join(", ")}: `}
            {n.message}
          </p>
        ))}
      </div>
    </div>
  );
}

/** Where one person landed. Clicking it narrows the grid to that team. */
function TeamChip({
  landing,
  active,
  onPick,
}: {
  landing: PersonLanding;
  active: boolean;
  onPick: (team: string) => void;
}) {
  const variant =
    landing.outcome === "failed" ? "destructive" : active ? "default" : "muted";
  return (
    <Badge asChild variant={variant} className="gap-1.5 font-normal">
      <button
        type="button"
        onClick={() => onPick(active ? ALL_TEAMS : landing.team)}
        className="cursor-pointer"
      >
        <TeamAvatar
          name={landing.team}
          avatarUrl={landing.teamAvatarUrl}
          size="xs"
        />
        <span className="max-w-32 truncate">{landing.team}</span>
      </button>
    </Badge>
  );
}

/** The link for whoever was not on that panel at all, one team at a time. */
function ExtraLinks({ groups }: { groups: PeopleGroup[] }) {
  return (
    <section className="space-y-3 rounded-lg border border-border bg-background p-3">
      <p className="text-sm font-medium">
        Somebody who wasn&apos;t on the panel
      </p>
      {groups.map((g) => (
        <div
          key={g.key}
          className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center"
        >
          <span className="flex items-center gap-2 text-sm sm:min-w-32">
            <TeamAvatar
              name={g.team.name}
              avatarUrl={g.team.avatarUrl}
              size="sm"
            />
            <span className="min-w-0 truncate">{g.team.name}</span>
          </span>
          <ExtraLink group={g} />
        </div>
      ))}
    </section>
  );
}

function ExtraLink({ group: g }: { group: PeopleGroup }) {
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      {/* One width for both labels, so a row that already minted one lines up
          with the rows that have not. */}
      <Button
        variant="outline"
        onClick={g.onMintLink}
        disabled={g.minting}
        className="w-full sm:w-56"
      >
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
  );
}
