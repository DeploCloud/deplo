"use client";

import * as React from "react";
import {
  Layers,
  Loader2,
  Server as ServerIcon,
  TriangleAlert,
} from "lucide-react";

import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TeamAvatar } from "@/components/shared/user-avatar";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/shared/empty-state";
import { CreateTeamDialog } from "@/components/teams/create-team-dialog";
import { TeamTargetGraphic } from "./team-target-graphic";
import { TargetTeamDialog } from "./target-team-dialog";
import { MigrationTree, type PortConflict } from "./migration-tree";
import { StepShell } from "./step-shell";
import { copyFor, type SourceKind, stepDocs } from "./sources";
import {
  importableOf,
  type Placement,
  type Plan,
  type PortCheck,
  type ServerChoice,
  type TargetTeam,
} from "./types";

const PORTS_IN_USE = /* GraphQL */ `
  query HostPortsInUse($serverId: ID!, $ports: [Int!]!) {
    hostPortsInUse(serverId: $serverId, ports: $ports) {
      checked
      inUse
      reason
    }
  }
`;

const SUGGEST_PORT = /* GraphQL */ `
  mutation GenerateAvailableDbPort($serverId: ID) {
    generateAvailableDbPort(serverId: $serverId)
  }
`;

/* ------------------------------------------------------------------ */
/* Host ports                                                         */
/* ------------------------------------------------------------------ */

/** Every database in the plan that publishes a port, whatever anyone has ticked. */
function databasesWithPorts(plan: Plan) {
  return plan.projects
    .flatMap(importableOf)
    .filter((s) => s.targetKind === "database" && s.exposedPort != null);
}

/**
 * Which databases would land on a host port something else already holds, and a
 * free port to offer instead.
 */
function usePortConflicts({
  plan,
  placements,
  setPlacements,
  chosen,
  servers,
  enabled,
}: {
  plan: Plan;
  placements: Record<string, Placement>;
  /** The real setter: a suggestion lands after an await, so it must merge, not overwrite. */
  setPlacements: React.Dispatch<
    React.SetStateAction<Record<string, Placement>>
  >;
  chosen: Set<string>;
  servers: ServerChoice[];
  /** False without the publish-ports grant: nothing can be published, so nothing is asked. */
  enabled: boolean;
}) {
  const [checks, setChecks] = React.useState<Record<string, PortCheck>>({});

  const dbs = React.useMemo(() => databasesWithPorts(plan), [plan]);

  /** The Deplo server that IS the source machine a service runs on, if we have one. */
  const homeHost = React.useMemo(
    () => new Map(plan.servers.map((m) => [m.sourceId, m.deploServerId])),
    [plan],
  );

  /** What a database will publish, after whatever the review has decided so far. */
  const chosenPort = React.useCallback(
    (sourceId: string, sourcePort: number | null) => {
      const p = placements[sourceId]?.exposedPort;
      return p !== undefined ? p : sourcePort;
    },
    [placements],
  );

  // The question to ask each server: the ports its databases came with, plus the ones
  // the review has since chosen, so a typed port is checked too.
  const askKey = React.useMemo(() => {
    const byServer = new Map<string, Set<number>>();
    for (const s of dbs) {
      const serverId = placements[s.sourceId]?.serverId;
      if (!serverId) continue;
      const ports = byServer.get(serverId) ?? new Set<number>();
      if (s.exposedPort != null) ports.add(s.exposedPort);
      const now = chosenPort(s.sourceId, s.exposedPort);
      if (now != null) ports.add(now);
      byServer.set(serverId, ports);
    }
    return JSON.stringify(
      [...byServer].map(([id, ports]) => [
        id,
        [...ports].sort((a, b) => a - b),
      ]),
    );
  }, [dbs, placements, chosenPort]);

  React.useEffect(() => {
    if (!enabled || dbs.length === 0) return;
    const ask: [string, number[]][] = JSON.parse(askKey);
    if (ask.length === 0) return;
    let cancelled = false;
    // Debounced: the run-server picker and the port field both feed this, and a
    // probe per keystroke is a gRPC round-trip per keystroke.
    const t = setTimeout(async () => {
      const answers = await Promise.all(
        ask.map(async ([serverId, ports]) => {
          const res = await gqlAction<{ hostPortsInUse: PortCheck }, PortCheck>(
            PORTS_IN_USE,
            { serverId, ports },
            (d) => d.hostPortsInUse,
          );
          const answer: PortCheck =
            res.ok && res.data
              ? res.data
              : {
                  checked: false,
                  inUse: [],
                  reason: res.ok ? null : res.error,
                };
          return [serverId, answer] as const;
        }),
      );
      if (cancelled) return;
      setChecks(Object.fromEntries(answers));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [askKey, enabled, dbs.length]);

  /** A port taken on the host this database lands on, by something that is not it. */
  const clashes = React.useCallback(
    (sourceId: string, sourceServerId: string, port: number | null) => {
      if (port == null) return false;
      const serverId = placements[sourceId]?.serverId;
      if (!serverId) return false;
      // The container holding it is the one we are importing; it lets go.
      if (homeHost.get(sourceServerId) === serverId) return false;
      const check = checks[serverId];
      if (check?.checked && check.inUse.includes(port)) return true;
      // Nothing on the host can see a database that does not exist yet, so two
      // arrivals wanting one port are only ever caught by comparing them.
      return dbs.some(
        (o) =>
          o.sourceId !== sourceId &&
          placements[o.sourceId]?.serverId === serverId &&
          chosenPort(o.sourceId, o.exposedPort) === port &&
          // Ordered, so exactly ONE of the pair is the one to move.
          o.sourceId < sourceId,
      );
    },
    [placements, homeHost, checks, dbs, chosenPort],
  );

  const conflicts = React.useMemo(() => {
    const out: Record<string, PortConflict> = {};
    for (const s of dbs) {
      // Only what is actually coming over: a port on a database somebody unticked
      // is a question about something that is not going to happen.
      if (!chosen.has(s.sourceId)) continue;
      if (s.exposedPort == null) continue;
      if (!clashes(s.sourceId, s.sourceServerId, s.exposedPort)) continue;
      const serverId = placements[s.sourceId]?.serverId;
      out[s.sourceId] = {
        takenPort: s.exposedPort,
        serverName:
          servers.find((v) => v.id === serverId)?.name ?? "that server",
        invalid: clashes(
          s.sourceId,
          s.sourceServerId,
          chosenPort(s.sourceId, s.exposedPort),
        ),
      };
    }
    return out;
  }, [dbs, chosen, clashes, placements, servers, chosenPort]);

  // A free port, offered rather than demanded: whoever has no opinion about which
  // port a migrated database answers on presses Import and gets a working one.
  React.useEffect(() => {
    // Only a row nobody has touched: once a port has been chosen - by this effect
    // or by the person - it stands, even if it is still taken. Which is also what
    // stops this from looping, since the pick immediately fails this test.
    const open = dbs
      .filter(
        (s) =>
          conflicts[s.sourceId]?.invalid &&
          chosenPort(s.sourceId, s.exposedPort) === s.exposedPort,
      )
      .map((s) => s.sourceId);
    if (open.length === 0) return;
    let cancelled = false;
    void (async () => {
      const picked: [string, number][] = [];
      for (const id of open) {
        const serverId = placements[id]?.serverId;
        if (!serverId) continue;
        const res = await gqlAction<
          { generateAvailableDbPort: number },
          number
        >(SUGGEST_PORT, { serverId }, (d) => d.generateAvailableDbPort);
        // Two databases suggested in one pass must not be handed the same port:
        // the server answers from what is live, and neither of them is.
        if (
          res.ok &&
          res.data != null &&
          !picked.some(([, p]) => p === res.data)
        ) {
          picked.push([id, res.data]);
        }
      }
      if (cancelled || picked.length === 0) return;
      // Merged into whatever is current, not into the copy this effect started
      // with: the picks arrive after a round-trip, and a server changed in the
      // meantime must not be undone by them.
      setPlacements((cur) => {
        const next = { ...cur };
        for (const [id, port] of picked)
          if (next[id]) next[id] = { ...next[id], exposedPort: port };
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflicts]);

  /** Servers whose agent could not answer, by name, for the one line that says so. */
  const unreachable = React.useMemo(
    () =>
      Object.entries(checks)
        .filter(([, c]) => !c.checked)
        .map(([id]) => servers.find((v) => v.id === id)?.name ?? id),
    [checks, servers],
  );

  /** Something still points at a port that is taken - the import waits. */
  const blocked = React.useMemo(
    () => Object.values(conflicts).some((c) => c.invalid),
    [conflicts],
  );

  return {
    conflicts,
    unreachable,
    blocked,
    /** How many databases would publish a port, of the ones being imported. */
    count: dbs.filter((s) => chosen.has(s.sourceId)).length,
  };
}

/* ------------------------------------------------------------------ */
/* Step 2 - review                                                    */
/* ------------------------------------------------------------------ */

export function ReviewStep({
  kind,
  plan,
  teamId,
  teamName,
  teamAvatarUrl,
  targetTeams,
  retargeting,
  retargetError,
  onRetarget,
  chosen,
  setChosen,
  servers,
  buildServers,
  placements,
  setPlacements,
  canExposePorts,
  isInstanceAdmin,
  onBack,
  onStart,
}: {
  /** Which panel the plan was read from. */
  kind: SourceKind | null;
  plan: Plan;
  /** The active team, named in the card at the top: everything lands there. */
  teamId: string;
  teamName: string;
  teamAvatarUrl: string | null;
  /** Where else it could land - every team this person may create projects in. */
  targetTeams: TargetTeam[];
  /** A team change is in flight: the plan is being read again under it. */
  retargeting: boolean;
  /** Why the last re-read failed - the plan below answers about another team. */
  retargetError: string | null;
  onRetarget: (teamId: string) => void;
  chosen: Set<string>;
  setChosen: (v: Set<string>) => void;
  servers: ServerChoice[];
  buildServers: ServerChoice[];
  placements: Record<string, Placement>;
  setPlacements: React.Dispatch<
    React.SetStateAction<Record<string, Placement>>
  >;
  canExposePorts: boolean;
  /** Creating a team is instance-admin, like every other way of making one. */
  isInstanceAdmin: boolean;
  onBack: () => void;
  onStart: () => void;
}) {
  const [newTeamOpen, setNewTeamOpen] = React.useState(false);
  const [pickTeamOpen, setPickTeamOpen] = React.useState(false);
  const ports = usePortConflicts({
    plan,
    placements,
    setPlacements,
    chosen,
    servers,
    enabled: canExposePorts,
  });
  const pickable = plan.projects.flatMap((p) => importableOf(p));
  const allChosen = pickable.length > 0 && chosen.size === pickable.length;
  // The confirm names them, in a tooltip. A search box above the tree filters
  // what you SEE and not what is ticked, so a count alone let somebody stop
  // three services while looking at one.
  const chosenNames = pickable
    .filter((s) => chosen.has(s.sourceId))
    .map((s) => s.name);

  return (
    <StepShell
      title="What comes over"
      docs={stepDocs(kind, "changes")}
      lead="Pick what to bring and where it lands. Nothing is deployed yet."
    >
      {/* Said once, at the top, instead of on every database it applies to: it
          is one fact about the person importing, not a property of each row,
          and repeating it N times is how a screen stops being read. */}
      {!canExposePorts && ports.count > 0 && (
        <PortsNotice>
          You can&rsquo;t publish ports, so{" "}
          {ports.count === 1
            ? "1 database comes"
            : `${ports.count} databases come`}{" "}
          over without public access.
        </PortsNotice>
      )}
      {ports.unreachable.length > 0 && (
        <PortsNotice>
          Deplo can&rsquo;t check ports on {ports.unreachable.join(", ")}.
          Update the agent there, or check them after the migration.
        </PortsNotice>
      )}

      {servers.length === 0 ? (
        // Without a host there is nothing to place anything on, so this replaces
        // the tree rather than sitting beside it.
        <EmptyState
          icon={ServerIcon}
          title="No server to deploy to"
          description="Add a server under Settings, Servers before migrating."
        />
      ) : plan.projects.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="Nothing to bring over"
          description={`That ${copyFor(kind).name} has no projects, or the token cannot see them.`}
        />
      ) : (
        <div
          className={cn(
            retargeting && "pointer-events-none opacity-50 transition-opacity",
          )}
        >
          <MigrationTree
            projects={plan.projects}
            chosen={chosen}
            onChange={setChosen}
            servers={servers}
            buildServers={buildServers}
            placements={placements}
            onPlacementsChange={setPlacements}
            portConflicts={ports.conflicts}
            showPorts={canExposePorts}
            allChosen={allChosen}
            onToggleAll={() =>
              setChosen(
                allChosen
                  ? new Set()
                  : new Set(pickable.map((s) => s.sourceId)),
              )
            }
          />
        </div>
      )}

      {/**
       * Where it all ends up, and it sits AFTER the list: the question this step asks is
       * "what comes over", and the answer to "into which team" is the one you check once
       * you have seen the list - not a card to read past on the way to it.
       */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border p-4">
          <TeamTargetGraphic />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              Everything lands in
              <TeamAvatar name={teamName} avatarUrl={teamAvatarUrl} size="sm" />
              {teamName}
            </div>
            {retargeting ? (
              <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Re-checking what is already there
              </p>
            ) : retargetError ? (
              <p className="mt-1 flex items-start gap-1.5 text-sm text-warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 text-muted-foreground">
                  {retargetError} What is marked &ldquo;Already here&rdquo;
                  below is another team&rsquo;s answer - pick this team again to
                  re-check.
                </span>
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                Apps, databases and the variables that go with them.
              </p>
            )}
          </div>
          <Button
            variant="secondary"
            disabled={retargeting}
            onClick={() => setPickTeamOpen(true)}
          >
            Select another
          </Button>
        </div>

        {/**
         * The one consequence worth stopping on, in its own small card right under the
         * destination - and NOT behind a confirm dialog.
         */}
        {chosenNames.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <p className="min-w-0 text-muted-foreground">
              <SimpleTooltip content={chosenNames.join(", ")}>
                <span className="font-medium text-warning underline decoration-dotted underline-offset-4">
                  {chosenNames.length}
                </span>
              </SimpleTooltip>{" "}
              {chosenNames.length === 1 ? "service is" : "services are"} stopped
              on {copyFor(kind).name} when this starts, and not started again.
            </p>
          </div>
        )}
      </div>
      <TargetTeamDialog
        open={pickTeamOpen}
        onOpenChange={setPickTeamOpen}
        teams={targetTeams}
        activeId={teamId}
        canCreate
        onSelect={(id) => onRetarget(id)}
        onCreate={() => setNewTeamOpen(true)}
      />

      {/* `redirect={false}`: creating a team switches you into it, and the
          dialog's usual trip to the overview would throw away the scan, the
          selection and the key that are only in this tab. Not instance-admin
          gated: `createTeam` asks for no Capability, and the team switcher
          offers it to everyone. */}
      <CreateTeamDialog
        open={newTeamOpen}
        onOpenChange={setNewTeamOpen}
        redirect={false}
        // The panel's own team is what it is called over there, so that is the
        // name it lands under here.
        defaultName={plan.orgName ?? undefined}
        onCreated={(id) => onRetarget(id)}
      />

      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button
          onClick={onStart}
          disabled={
            chosen.size === 0 ||
            servers.length === 0 ||
            ports.blocked ||
            retargeting
          }
        >
          Move it over
        </Button>
      </div>
    </StepShell>
  );
}

/** One line about ports, in the warning colour the rest of this screen uses. */
function PortsNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 text-muted-foreground">{children}</span>
    </div>
  );
}
