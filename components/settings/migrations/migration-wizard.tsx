"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  CircleStop,
  Loader2,
  Repeat,
  ScrollText,
  Server as ServerIcon,
  TriangleAlert,
  X,
} from "lucide-react";

import { gqlAction } from "@/lib/graphql-client";
import { TEAM_HEADER } from "@/lib/team-path";
import { docsUrl } from "@/lib/docs";
import { formatBuildDuration } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CodeBlock } from "@/components/shared/code-block";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { KindCard } from "@/components/shared/kind-card";
import { TeamAvatar } from "@/components/shared/user-avatar";
import { FieldLabel } from "@/components/ui/info-tip";
import { ConfettiBurst } from "@/components/shared/confetti-burst";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { AnimatedHeight } from "@/components/shared/animated-height";
import { LeftoverDiskGraphic } from "@/components/takeover/leftover-disk-graphic";
import { WizardStepper } from "@/components/shared/wizard-stepper";
import { TargetSelect } from "./target-select";
import { TeamImagePicker } from "./team-image-picker";
import { UnsavedChangesGuard } from "@/components/apps/unsaved-changes-guard";
import {
  isDriven,
  useMigrationFeed,
  type ActiveMigration,
} from "@/components/layout/migration-activity";
import { InstallStep, type PendingMachine } from "./install-step";
import { MigrationGraphic, type MigrationState } from "./migration-graphic";
import {
  copyFor,
  SOURCE_COPY,
  SOURCE_KINDS,
  SourceMark,
  type SourceKind,
} from "./sources";
import { RemoveMigrationSources } from "./remove-sources";
import { ReviewStep, type ReviewGroup } from "./review-step";
import { PeopleStep, type PeopleGroup } from "./people-step";
import { MigrationConsole, type ConsoleRun } from "./migration-console";
import { StepShell } from "./step-shell";
import { ChooseStep } from "./choose-step";
import {
  reviewShows,
  stepReachable,
  stepsFor,
  warnings,
  type StepId,
  type TakeoverMode,
} from "./steps";
import {
  TakeoverStep,
  type TakeoverState,
} from "@/components/takeover/takeover-actions";
import {
  addTeam,
  retarget,
  teamsAfter,
  uncoveredTeams,
  type QueuedTeam,
  type SourceTeam,
  type TeamTarget,
} from "./queue";
import {
  importableOf,
  type ImportRun,
  type MigrationProgress,
  type Placement,
  type Plan,
  type ServerChoice,
  type SessionRun,
  type TargetTeam,
} from "./types";

/**
 * Migrating a panel over, as one screen: every team of it, each into a Deplo
 * team of the operator's choosing. The API keys never leave this component's
 * state.
 */

/** Dokploy's own host has no server row over there; it is the empty id. */
const OWN_HOST = "";

/** The step a handover already under way pins the wizard to, or null while the
 *  machine has not started changing hands. */
function stepForHandover(
  state: Exclude<TakeoverState, "cancelled"> | undefined,
): StepId | null {
  if (!state || state === "pending") return null;
  // `failed` lands on the step too: it is where Try again lives.
  return state === "removed" ? "done" : "takeover";
}

/**
 * What a fresh plan arrives ticked with: everything Deplo can actually create.
 * Anything already here is not, since re-importing it would only produce a page
 * of "already here" rows.
 */
function defaultChoice(plan: Plan): Set<string> {
  return new Set(
    plan.projects.flatMap((p) =>
      importableOf(p)
        .filter((s) => s.status !== "exists")
        .map((s) => s.sourceId),
    ),
  );
}

/**
 * The whole migration, in one call. It returns when the PLAN is durable, not
 * when the work is done - everything after that happens in the control plane,
 * which is what lets this page be closed.
 */
const START = /* GraphQL */ `
  mutation StartMigration(
    $input: MigrationSourceInput!
    $orgName: String
    $targets: [MigrationRunTargetInput!]!
    $servers: [MigrationServerChoiceInput!]
    $queued: [MigrationQueuedTeamInput!]
  ) {
    startMigration(
      input: $input
      orgName: $orgName
      targets: $targets
      servers: $servers
      queued: $queued
    )
  }
`;

/**
 * The tail of a run item's path - `Backups / production / jellyfin` becomes
 * `jellyfin`. Null when the run has not written a row yet, which is a real state:
 * a run is open for a beat before its first object lands.
 */
function lastStep(path: string | null | undefined): string {
  if (!path) return "";
  const tail = path.split(" / ").pop()?.trim();
  return tail ?? "";
}

/* ------------------------------------------------------------------ */
/* GraphQL                                                            */
/* ------------------------------------------------------------------ */

/** Which team one token reads, without reading it all - what the list on Connect
 *  is built from. */
const IDENTIFY = /* GraphQL */ `
  mutation IdentifyMigrationSource($input: MigrationSourceInput!) {
    identifyMigrationSource(input: $input) {
      platform
      teamId
      teamName
      otherTeams
    }
  }
`;

/** `newTeam`: the plan for a team not made yet - see the mutation's own doc. */
const SCAN = /* GraphQL */ `
  mutation ScanMigrationSource(
    $input: MigrationSourceInput!
    $newTeam: Boolean
  ) {
    scanMigrationSource(input: $input, newTeam: $newTeam) {
      platform
      sourceUrl
      orgName
      otherTeams
      servers {
        sourceId
        name
        ipAddress
        cloudflare
        deploServerId
        deploServerName
        deploServerOnline
      }
      members {
        email
        name
        sourceRole
        hasAccount
        avatarUrl
        avatarColor
        inTeam
      }
      projects {
        sourceId
        name
        exists
        environments {
          sourceId
          name
          exists
          services {
            sourceId
            kind
            name
            targetKind
            status
            sourceServerId
            buildsFromSource
            engine
            exposedPort
            domains
            logo
            notes
          }
        }
      }
    }
  }
`;

/**
 * Stop, which is the same word the server means by it: undo the whole migration.
 * There is no second call - nothing to keep, nothing to choose. See
 * `stopMigration`.
 */
const STOP = /* GraphQL */ `
  mutation StopMigration($runId: String!) {
    stopMigration(runId: $runId)
  }
`;

/** A team of its own for a team of the list, named as it was over there. */
const CREATE_TEAM = /* GraphQL */ `
  mutation CreateMigrationTeam($name: String!, $image: String) {
    createTeam(name: $name, image: $image) {
      id
    }
  }
`;

/**
 * One team's fleet: what a source team's services may be placed on once it lands
 * there. Read per landing team, since servers are per-team.
 */
const FLEET = /* GraphQL */ `
  query MigrationFleet {
    servers {
      id
      name
      role
      isDeploHost
    }
    buildServerChoices {
      id
      name
      buildOnly
      isDeploHost
    }
  }
`;

/** A server as the fleet query lists it; `role` "everything" is one that runs. */
interface FleetServer {
  id: string;
  name: string;
  role: string;
  isDeploHost: boolean;
}

/** What one landing team may place services on. */
interface Fleet {
  servers: ServerChoice[];
  buildServers: ServerChoice[];
}

const HAND_OVER_SOURCES = /* GraphQL */ `
  mutation HandOverMigrationSources($fromTeamId: String!) {
    handOverMigrationSources(fromTeamId: $fromTeamId)
  }
`;

/**
 * Sent on the way out of an unfinished wizard - from a click on the sidebar and
 * from the tab closing alike, which is why it is fired as a bare `fetch` with
 * `keepalive` rather than through the client.
 */
/**
 * "I am done with this run": the wizard stops opening on it and gives back an
 * empty connect form. Everything else on this screen is derived from the run
 * itself - this is the one thing only a person can say.
 */
const DISMISS = /* GraphQL */ `
  mutation DismissMigrationReport($runId: String!) {
    dismissMigrationReport(runId: $runId)
  }
`;

const ABANDON = /* GraphQL */ `
  mutation AbandonMigration {
    abandonMigration
  }
`;

/**
 * Every team of this walk of the wizard, as the control plane has it: the one
 * moving, the ones still queued behind it, and what each one landed. The screen
 * is rebuilt from this, so leaving the page and coming back is the same screen.
 */
const SESSION = /* GraphQL */ `
  query MigrationSession($runId: String!) {
    migrationSession(runId: $runId) {
      id
      teamId
      teamName
      teamAvatarUrl
      orgName
      status
      created
      skipped
      failed
      manual
      error
      members {
        email
        name
        link
        outcome
        message
        sourceRole
        hasAccount
        avatarUrl
      }
    }
  }
`;

const MINT_LINK = /* GraphQL */ `
  mutation MintImportInviteLink($input: MintRegistrationLinkInput!) {
    mintRegistrationLink(input: $input)
  }
`;

/** What the finished run says about itself, kept for the report card. */
interface RunReport {
  created: number;
  skipped: number;
  failed: number;
  manual: number;
}

/** Nothing has moved yet, or this tab does not know what has. */
const NO_PROGRESS: MigrationProgress = { done: 0, total: 0, current: "" };

/** One column of the walk's runs added up - the report is the whole list's. */
function sum(
  runs: SessionRun[],
  key: "created" | "skipped" | "failed" | "manual",
): number {
  return runs.reduce((n, r) => n + r[key], 0);
}

/**
 * The page's snapshot of a run, in the shape the live feed uses, so the panel
 * can read one field either way. Progress is whatever the server last wrote
 * down; the feed overwrites it the moment it connects.
 */
function asActive(run: ImportRun): ActiveMigration {
  return {
    id: run.id,
    status: run.status,
    sourceUrl: run.sourceUrl,
    orgName: run.orgName,
    actor: run.actor,
    startedAt: run.startedAt,
    created: run.created,
    skipped: run.skipped,
    failed: run.failed,
    manual: run.manual,
    lastPath: run.lastPath ?? null,
    phase: run.phase ?? "config",
    doneSteps: run.doneSteps ?? 0,
    totalSteps: run.totalSteps ?? 0,
    stepLabel: run.stepLabel ?? null,
    heartbeatAt: run.heartbeatAt ?? null,
  };
}

/**
 * Where each service lands unless somebody says otherwise: the Deplo server that IS
 * the machine it runs on, matched by address. Staying put is what moving twenty-five
 * services means by "import"; re-picking the host on each is a chore, not a choice.
 */
function landingDefaults(
  scanned: Plan,
  servers: ServerChoice[],
): { placements: Record<string, Placement>; servers: Record<string, string> } {
  const home = (servers.find((s) => s.isDeploHost) ?? servers[0])?.id;
  if (!home) return { placements: {}, servers: {} };
  const runnable = new Set(servers.map((s) => s.id));
  const byMachine = new Map(
    scanned.servers.map((m) => [
      m.sourceId,
      m.deploServerId && runnable.has(m.deploServerId) ? m.deploServerId : home,
    ]),
  );
  const landingFor = (sourceServerId: string) =>
    byMachine.get(sourceServerId) ?? home;
  return {
    placements: Object.fromEntries(
      scanned.projects.flatMap((p) =>
        importableOf(p).map((svc) => [
          svc.sourceId,
          { serverId: landingFor(svc.sourceServerId), buildServerId: null },
        ]),
      ),
    ),
    // Only where its apps LAND: where the data is READ from is derived
    // server-side from the machine's address, never from this map.
    servers: Object.fromEntries([
      [OWN_HOST, landingFor(OWN_HOST)],
      ...scanned.servers.map((s) => [s.sourceId, landingFor(s.sourceId)]),
    ]),
  };
}

/**
 * Drop a placement the fleet no longer offers. Servers are per-team, so landing in
 * another team can leave a host this one may not use - and that is not a placement,
 * it is a deploy that dies halfway through with the services already stopped.
 */
export function reconcilePlacements(
  placements: Record<string, Placement>,
  machines: Record<string, string>,
  servers: ServerChoice[],
  buildServers: ServerChoice[],
): { placements: Record<string, Placement>; servers: Record<string, string> } {
  const home = (servers.find((s) => s.isDeploHost) ?? servers[0])?.id;
  if (!home) return { placements, servers: machines };
  const runnable = new Set(servers.map((s) => s.id));
  const buildable = new Set(buildServers.map((s) => s.id));
  return {
    placements: Object.fromEntries(
      Object.entries(placements).map(([id, p]) => [
        id,
        {
          ...p,
          serverId: runnable.has(p.serverId) ? p.serverId : home,
          // Null is Automatic, which is the right answer for a host that is gone.
          buildServerId:
            p.buildServerId && !buildable.has(p.buildServerId)
              ? null
              : p.buildServerId,
        },
      ]),
    ),
    servers: Object.fromEntries(
      Object.entries(machines).map(([from, to]) => [
        from,
        runnable.has(to) ? to : home,
      ]),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

export function MigrationWizard({
  teamId,
  targetTeams,
  servers,
  buildServers,
  isInstanceAdmin,
  canExposePorts,
  resumable,
  sameMachineHost,
  prefill = null,
  takeover = null,
  preflight = null,
  startOnTakeover = false,
}: {
  /** The page's team: where the source machines are registered, and where every
   *  call that is about no team in particular goes. */
  teamId: string;
  /** Every team a source team may land in. A new one is always on offer too. */
  targetTeams: TargetTeam[];
  /** The page's team's fleet - the first answer, until a landing team's is read. */
  servers: ServerChoice[];
  buildServers: ServerChoice[];
  isInstanceAdmin: boolean;
  /** The publish-ports grant. Without it a database's port cannot come over at all. */
  canExposePorts: boolean;
  /**
   * The run this person is in the middle of, read at page load: one still moving,
   * or one whose report they have not closed yet - in whichever team it landed.
   */
  resumable: ImportRun | null;
  /** The address a container on this instance reaches its own host on. */
  sameMachineHost: string;
  /**
   * The panel this machine is being taken over from, when the installer already
   * found it. The operator then only has to paste a key.
   */
  prefill?: { url: string; kind: SourceKind } | null;
  /**
   * The machine being taken over, which is what puts `Choose` and `Take over` in
   * the rail. Null on the ordinary Migrations screen.
   */
  takeover?: {
    platformLabel: string;
    /** How far the handover has got. `cancelled` never reaches this component. */
    state: Exclude<TakeoverState, "cancelled">;
    /** The run that finished, if the data was brought across. */
    finishedRunId: string | null;
    /** Where the dashboard answers once the ports have moved. */
    finalUrl: string;
    /** Why the last cutover rolled back, when `state` is `failed`. */
    error: string | null;
    /** Services of the finished run that arrived without their data. */
    dataLoss: string[];
  } | null;
  /** What a takeover of this machine is walking into - a server component's
   *  output, so it arrives rendered. Not shown when nothing is being copied. */
  preflight?: React.ReactNode;
  /** A takeover whose migration already finished and whose report was closed:
   *  the only thing left is the last step, so open on it. */
  startOnTakeover?: boolean;
}) {
  const router = useRouter();

  const isTakeover = takeover != null;
  /**
   * Whether the takeover brings the data across or deletes the old panel. Derived
   * rather than stored: a run that exists already answers it, and before one does
   * there is nothing yet to remember.
   */
  const [mode, setMode] = React.useState<TakeoverMode | null>(() => {
    if (!isTakeover) return "migrate";
    if (startOnTakeover || resumable != null || takeover.finishedRunId != null)
      return "migrate";
    // The handover is already under way and nothing came across, so this is the
    // clean one - a reload mid-cutover must not ask the question again.
    return takeover.state === "pending" ? null : "clean";
  });
  const [step, setStep] = React.useState<StepId>(
    () =>
      stepForHandover(takeover?.state) ??
      (mode == null ? "choose" : startOnTakeover ? "takeover" : "connect"),
  );
  /**
   * The handover is the server's, so the step follows it once it starts: a person
   * who reloads mid-cutover lands on the step that is happening. Adjusted during
   * the render, which is what React prescribes for state a prop invalidates.
   */
  const seenHandover = React.useRef(takeover?.state);
  if (takeover && takeover.state !== seenHandover.current) {
    seenHandover.current = takeover.state;
    const forced = stepForHandover(takeover.state);
    if (forced) setStep(forced);
  }
  const [url, setUrl] = React.useState(prefill?.url ?? "");
  const [apiKey, setApiKey] = React.useState("");
  const [scanning, setScanning] = React.useState(false);
  /**
   * The panel's teams, the token that reads each and the Deplo team each lands
   * in, in the order they are brought over - a token reads exactly one team on
   * both products. `at` is whose turn it is; both outlive one team's run, which
   * is what makes this a queue.
   */
  const [queue, setQueue] = React.useState<QueuedTeam[]>([]);
  const [at, setAt] = React.useState(0);
  /** An `Add` in flight. */
  const [adding, setAdding] = React.useState(false);
  /** Every team the panel would name, so the ones no token covers can be listed.
   *  Null from a panel that cannot say, which is Coolify always. */
  const [panelTeams, setPanelTeams] = React.useState<string[] | null>(null);
  /**
   * Each team's plan by its place on the list, and what its run left behind -
   * the run, the Deplo team it landed in, its report - so one Review shows every
   * list and one People step hands out every link.
   */
  const [teamPlans, setTeamPlans] = React.useState<Record<number, Plan>>({});
  /**
   * The runs of this walk, as the server has them: one per team of the panel,
   * with the people each brought over. THE state of a migration in progress -
   * everything below reads it, and a reload reads it back unchanged.
   */
  const [sessionRuns, setSessionRuns] = React.useState<SessionRun[]>([]);
  /** The extra link for whoever was not on the panel at all, per team. */
  const [teamLinks, setTeamLinks] = React.useState<Record<string, string>>({});
  const [mintingFor, setMintingFor] = React.useState<string | null>(null);
  /** Each landing team's fleet, read when a source team is pointed at it. */
  const [fleets, setFleets] = React.useState<Record<string, Fleet>>({});
  /** The plan the last scan read: a run started right after a re-read must not
   *  start from the plan the state still holds. */
  const latestPlan = React.useRef<Plan | null>(null);
  const [plan, setPlan] = React.useState<Plan | null>(null);
  /** Pinned by the person after a scan that could not identify the panel. */
  const [forcedKind, setForcedKind] = React.useState<SourceKind | null>(
    prefill?.kind ?? null,
  );
  /** The last refusal, kept on screen: its fix is in another browser tab. */
  const [scanError, setScanError] = React.useState<string | null>(null);
  /** Teams this walk created, by their place on the list, so a start that was
   *  refused after one was made does not make a second on the next press. */
  const madeTeams = React.useRef<Record<number, string>>({});
  /** Rows whose plan is being read again after a change of landing team. */
  const [rescanning, setRescanning] = React.useState<Record<number, boolean>>(
    {},
  );

  const [serverMap, setServerMap] = React.useState<Record<string, string>>({});
  /**
   * The machines Deplo has registered and is waiting to hear from, and which it
   * has already tried.
   */
  const [pendingMachines, setPendingMachines] = React.useState<
    Record<string, PendingMachine>
  >({});
  const attemptedMachines = React.useRef(new Set<string>());
  /** Source SERVICE ids. The leaves are the selection; the tree derives the rest. */
  const [chosen, setChosen] = React.useState<Set<string>>(new Set());
  /** Source service id → where it lands. Filled for every importable service. */
  const [placements, setPlacements] = React.useState<Record<string, Placement>>(
    {},
  );

  /**
   * Where the run stood when this page was rendered, kept until the live feed
   * connects - a fraction of a second in which the wizard would otherwise paint
   * the connect form over a migration that is moving.
   */
  const [snapshot, setSnapshot] = React.useState<ActiveMigration | null>(() =>
    resumable && resumable.status === "running" ? asActive(resumable) : null,
  );
  const [runId, setRunId] = React.useState<string | null>(null);
  /** The run finished and this is what it did. What Review turns into, and the
   *  one thing that opens every step after it. */
  const [report, setReport] = React.useState<RunReport | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  /** The `startMigration` call is in flight. It is over in about a second,
   *  and from then on the run is the server's and the live feed is the truth. */
  const [running, setRunning] = React.useState(false);
  /**
   * A start pressed in THIS tab. The chain is several round trips long before
   * `startMigration` is even sent, so a second press in that window starts a
   * second migration and the server answers "already has a migration running".
   * The ref is the guard - two clicks in one tick both read the state as false.
   */
  const startingRef = React.useRef(false);
  const [starting, setStarting] = React.useState(false);
  /** A Stop is in flight: the server is taking the migration back out. It ends
   *  when the run leaves the live feed, which drops the wizard back to step one. */
  const [undoing, setUndoing] = React.useState(false);
  /** The run this tab took over rather than started - what `closeReport` needs. */
  const [adoptedId, setAdoptedId] = React.useState<string | null>(null);
  const [logOpen, setLogOpen] = React.useState(false);
  /** Whether this tab has already decided which run to open on. */
  const restored = React.useRef(false);

  /**
   * The team the run on screen lands in, or landed in. Null before a turn has
   * begun; then every call about the run goes to the page's own team.
   */
  const [targetTeamId, setTargetTeamId] = React.useState<string | null>(
    resumable?.teamId ?? null,
  );
  const targetTeamRef = React.useRef(targetTeamId ?? teamId);
  targetTeamRef.current = targetTeamId ?? teamId;
  /** Every call about the run goes to the team it lands in, not the page's. */
  const inTarget = () => ({ teamId: targetTeamRef.current });
  /**
   * Where the machines Deplo installed to READ the panel are granted right now:
   * the page's team, where Install registers them, until a run hands them to
   * the team it lands in.
   */
  const sourcesTeam = React.useRef(teamId);

  // The chain of runs reads these between renders, so the latest value of each
  // rides on a ref beside its state.
  const queueRef = React.useRef(queue);
  queueRef.current = queue;
  const atRef = React.useRef(at);
  atRef.current = at;
  const chosenRef = React.useRef(chosen);
  chosenRef.current = chosen;
  const placementsRef = React.useRef(placements);
  placementsRef.current = placements;
  const serverMapRef = React.useRef(serverMap);
  serverMapRef.current = serverMap;
  const fleetsRef = React.useRef(fleets);
  fleetsRef.current = fleets;
  const teamPlansRef = React.useRef(teamPlans);
  teamPlansRef.current = teamPlans;

  /** How many teams of this panel are still behind the one on screen. Once a walk
   *  has started the control plane owns the list, so its rows are the answer. */
  const teamsLeft =
    sessionRuns.length > 0
      ? sessionRuns.filter((r) => r.status === "queued").length
      : teamsAfter(queue, at);
  /** The panel's teams no token here covers yet. Empty on a panel that will not
   *  name them, where the wizard asks instead. */
  const uncovered = uncoveredTeams(panelTeams, queue);

  /** What is known about the panel so far: what answered, or what was pinned. */
  const kind: SourceKind | null = plan?.platform ?? forcedKind;

  /** What a team of the panel is called when the panel would not name it. */
  const sourceLabel = `An unnamed ${copyFor(kind).teamLabel}`;
  /** A source team the panel would not name is still shown, just not as a name. */
  const sourceTeamName = (q: QueuedTeam) => q.name || sourceLabel;

  const STEPS = React.useMemo(
    () => stepsFor(isInstanceAdmin, isTakeover, mode),
    [isInstanceAdmin, isTakeover, mode],
  );

  /** The page's team's fleet, which stands in until a landing team's is read. */
  const ownFleet = React.useMemo<Fleet>(
    () => ({ servers, buildServers }),
    [servers, buildServers],
  );
  /** What a source team's services may be placed on: its landing team's hosts. */
  const fleetFor = React.useCallback(
    (target: TeamTarget): Fleet =>
      (target.kind === "existing" && fleets[target.teamId]) || ownFleet,
    [fleets, ownFleet],
  );

  /**
   * One team's fleet. Servers are per-team, so where a source team lands decides
   * what its services can be placed on - and a host the page's team may use is
   * not thereby one the landing team may.
   */
  async function loadFleet(id: string): Promise<Fleet> {
    const res = await gqlAction<
      { servers: FleetServer[]; buildServerChoices: ServerChoice[] },
      Fleet
    >(
      FLEET,
      {},
      (d) => ({
        servers: d.servers
          .filter((s) => s.role === "everything")
          .map((s) => ({ id: s.id, name: s.name, isDeploHost: s.isDeploHost })),
        buildServers: d.buildServerChoices,
      }),
      { teamId: id },
    );
    const fleet = res.ok && res.data ? res.data : ownFleet;
    fleetsRef.current = { ...fleetsRef.current, [id]: fleet };
    setFleets(fleetsRef.current);
    return fleet;
  }

  /* ---- step 1: connect --------------------------------------------- */

  /**
   * The one button at the bottom of Connect, which does the one thing left to do:
   * add the token that is typed, or set off down the list.
   */
  async function submitConnect(e: React.FormEvent) {
    e.preventDefault();
    if (apiKey.trim()) return identifyAndAdd();
    if (queue.length > 0) return scanAll();
  }

  /** Put the typed token on the list, once the panel has said which team it reads. */
  async function identifyAndAdd() {
    setAdding(true);
    setScanError(null);
    const res = await gqlAction<
      { identifyMigrationSource: SourceTeam },
      SourceTeam
    >(
      IDENTIFY,
      { input: { url, apiKey, kind: forcedKind } },
      (d) => d.identifyMigrationSource,
    );
    setAdding(false);
    if (!res.ok) {
      setScanError(res.error);
      return;
    }
    if (!res.data) return;
    const next = addTeam(queue, res.data, apiKey, targetTeams);
    if (next.error !== null) {
      setScanError(next.error);
      return;
    }
    setQueue(next.queue);
    if (res.data.otherTeams) setPanelTeams(res.data.otherTeams);
    if (!forcedKind) setForcedKind(res.data.platform);
    // Out of the field the moment it is on the list: what holds it now is the
    // team it belongs to.
    setApiKey("");
  }

  /**
   * Every team of the list in one go: each token read in the team it lands in -
   * or, for a team not made yet, as into one - so every list on one Review
   * answers about its own landing. The re-read a landing needs happens right
   * before its run (see `runTeam`).
   */
  async function scanAll() {
    setScanning(true);
    setScanError(null);
    const plans: Record<number, Plan> = {};
    const fleetOf: Record<number, Fleet> = {};
    for (const [i, team] of queue.entries()) {
      if (team.status !== "waiting") continue;
      const into = team.target.kind === "existing" ? team.target.teamId : null;
      const res = await gqlAction<{ scanMigrationSource: Plan }, Plan>(
        SCAN,
        {
          input: { url, apiKey: team.apiKey, kind: forcedKind },
          newTeam: into == null,
        },
        (d) => d.scanMigrationSource,
        into ? { teamId: into } : undefined,
      );
      if (!res.ok || !res.data) {
        setScanning(false);
        setScanError(
          `${team.name}: ${res.ok ? "Deplo could not read the panel." : res.error}`,
        );
        return;
      }
      plans[i] = res.data;
      fleetOf[i] = into ? await loadFleet(into) : ownFleet;
    }
    setScanning(false);
    const indexes = Object.keys(plans).map(Number);
    if (indexes.length === 0) return;
    const first = plans[indexes[0]];
    setTeamPlans(plans);
    setPlan(first);
    latestPlan.current = first;
    if (first.otherTeams) setPanelTeams(first.otherTeams);
    setChosen(
      new Set(Object.values(plans).flatMap((p) => [...defaultChoice(p)])),
    );
    const defaults = indexes.map((i) =>
      landingDefaults(plans[i], fleetOf[i].servers),
    );
    setPlacements(Object.assign({}, ...defaults.map((d) => d.placements)));
    setServerMap(Object.assign({}, ...defaults.map((d) => d.servers)));
    setAt(indexes[0]);
    // Straight on to Install, which is where "can Deplo reach every machine
    // behind this" gets answered - and which ends itself either way, so nobody
    // whose machines are already ours has a screen to click through.
    setStep("install");
  }

  /* ---- the move itself ---------------------------------------------- */

  /**
   * Point Deplo at the team this turn lands in: the machines it installed to read
   * the panel go there, and the panel is read again under it - "already here" and
   * the domain notes are answers about a team, the ticks are not.
   */
  async function landIn(
    i: number,
    home: string,
    key: string,
  ): Promise<string | null> {
    if (sourcesTeam.current !== home) {
      // Every lookup that reads a source is team-scoped: left behind, the run
      // refuses to start and their agents are stranded.
      const moved = await gqlAction(
        HAND_OVER_SOURCES,
        { fromTeamId: sourcesTeam.current },
        undefined,
        { teamId: home },
      );
      if (!moved.ok) return moved.error;
      sourcesTeam.current = home;
    }
    setTargetTeamId(home);
    targetTeamRef.current = home;
    const fleet = await loadFleet(home);
    const again = await gqlAction<{ scanMigrationSource: Plan }, Plan>(
      SCAN,
      { input: { url, apiKey: key, kind: forcedKind } },
      (d) => d.scanMigrationSource,
      { teamId: home },
    );
    if (!again.ok) return again.error;
    if (!again.data) return "Deplo could not read the panel again.";
    const fresh = again.data;
    setPlan(fresh);
    latestPlan.current = fresh;
    setTeamPlans((prev) => ({ ...prev, [i]: fresh }));
    // What was already chosen wins: a service the source has grown since the
    // first scan gets a default, nobody's review gets thrown away.
    const defaults = landingDefaults(fresh, fleet.servers);
    placementsRef.current = {
      ...defaults.placements,
      ...placementsRef.current,
    };
    setPlacements(placementsRef.current);
    serverMapRef.current = { ...defaults.servers, ...serverMapRef.current };
    setServerMap(serverMapRef.current);
    return null;
  }

  /**
   * Hand the whole list to the control plane and stop being the driver: the first
   * team's run starts now, the rest are written down with it.
   */
  async function runImport(opts: {
    from: Plan;
    key: string;
    home: string;
    queued: ReturnType<typeof queuedAfter>;
  }) {
    if (running) return;
    // Placed on the landing team's fleet: a host that team may not use is not a
    // placement, it is a deploy that dies halfway with the services stopped.
    const fleet = fleetsRef.current[opts.home] ?? ownFleet;
    const { targets, servers } = targetsOf(opts.from, fleet);
    if (targets.length === 0) {
      setFailure("Nothing is selected, so there is nothing to migrate.");
      return;
    }

    setFailure(null);
    setUndoing(false);
    setRunning(true);
    const res = await gqlAction<{ startMigration: string }, string>(
      START,
      {
        input: { url, apiKey: opts.key, kind: opts.from.platform },
        orgName: opts.from.orgName,
        targets,
        servers,
        // The teams behind this one, each with its own token: the control plane
        // starts each as the turn before it ends, and holds Deplo's agents on the
        // source machines until the last of them is done.
        queued: opts.queued,
      },
      (d) => d.startMigration,
      { teamId: opts.home },
    );
    setRunning(false);
    if (!res.ok) {
      setFailure(res.error);
      return;
    }
    if (!res.data) {
      setFailure("Deplo could not start the migration.");
      return;
    }
    // From here the live feed is the truth, for this tab and every other one.
    setRunId(res.data);
    setAdoptedId(res.data);
    // The keys are the control plane's now, and this tab has no further use for
    // them. Holding one after handing it over is a copy nobody remembers exists.
    setApiKey("");
    updateQueue(queueRef.current.map((e) => ({ ...e, apiKey: "" })));
    void refreshSession(res.data);
  }

  /**
   * Where one row lands, from either screen. The fleet is per-team, so the new
   * team's is fetched here - without it the row pickers keep offering the old
   * team's hosts until the run itself reloads them.
   */
  function retargetAt(i: number, target: TeamTarget) {
    updateQueue(retarget(queueRef.current, i, target));
    if (target.kind === "existing" && !fleetsRef.current[target.teamId])
      void loadFleet(target.teamId);
    void rescanTeam(i, target);
  }

  /**
   * "Already here" is an answer about ONE team, and so are the ticks that follow
   * from it: a row pointed somewhere else is reading the wrong answer until the
   * panel is read again under the new landing. Skipped before the first scan -
   * there is nothing to re-read yet.
   */
  async function rescanTeam(i: number, target: TeamTarget) {
    const q = queueRef.current[i];
    if (!q?.apiKey || teamPlansRef.current[i] == null) return;
    const into = target.kind === "existing" ? target.teamId : null;
    setRescanning((prev) => ({ ...prev, [i]: true }));
    const res = await gqlAction<{ scanMigrationSource: Plan }, Plan>(
      SCAN,
      {
        input: { url, apiKey: q.apiKey, kind: forcedKind },
        newTeam: into == null,
      },
      (d) => d.scanMigrationSource,
      into ? { teamId: into } : undefined,
    );
    setRescanning((prev) => {
      const next = { ...prev };
      delete next[i];
      return next;
    });
    if (!res.ok || !res.data) {
      toast.error(res.ok ? "Deplo could not read the panel again." : res.error);
      return;
    }
    const fresh = res.data;
    setTeamPlans((prev) => ({ ...prev, [i]: fresh }));
    // This team's ticks are replaced by what the new landing makes importable;
    // every other team's are left exactly as they were.
    const mine = new Set(
      fresh.projects.flatMap(importableOf).map((s) => s.sourceId),
    );
    setChosen((prev) => {
      const next = new Set([...prev].filter((id) => !mine.has(id)));
      for (const id of defaultChoice(fresh)) next.add(id);
      return next;
    });
    const fleet = into ? (fleetsRef.current[into] ?? ownFleet) : ownFleet;
    const defaults = landingDefaults(fresh, fleet.servers);
    placementsRef.current = {
      ...defaults.placements,
      ...placementsRef.current,
    };
    setPlacements(placementsRef.current);
  }

  /** The picture the team this row makes will be created with. */
  function setTeamImage(i: number, image: string | null) {
    updateQueue(
      queueRef.current.map((e, j) => (j === i ? { ...e, image } : e)),
    );
  }

  /** The list with one row changed, kept in step for the chain. */
  function updateQueue(next: QueuedTeam[]) {
    queueRef.current = next;
    setQueue(next);
  }

  /** Team `j` still has a turn coming, with something ticked to run it for. */
  function hasWork(j: number): boolean {
    const own = teamPlansRef.current[j];
    return (
      queueRef.current[j]?.status === "waiting" &&
      own != null &&
      own.projects
        .flatMap(importableOf)
        .some((s) => chosenRef.current.has(s.sourceId))
    );
  }

  /** What one team of the list asks the run for: its ticked services, placed. */
  function targetsOf(from: Plan, fleet: Fleet) {
    const landing = reconcilePlacements(
      placementsRef.current,
      serverMapRef.current,
      fleet.servers,
      fleet.buildServers,
    );
    const ticked = chosenRef.current;
    const targets = from.projects.flatMap((p) =>
      importableOf(p)
        .filter((svc) => ticked.has(svc.sourceId))
        .map((svc) => ({
          projectId: p.sourceId,
          projectName: p.name,
          serviceId: svc.sourceId,
          serverId: landing.placements[svc.sourceId]?.serverId ?? null,
          buildServerId:
            landing.placements[svc.sourceId]?.buildServerId ?? null,
          // Absent, null and a number are three different instructions - see the
          // input's own description. Spread so an untouched service stays absent.
          ...(landing.placements[svc.sourceId] &&
          "exposedPort" in landing.placements[svc.sourceId]!
            ? { exposedPort: landing.placements[svc.sourceId]!.exposedPort }
            : {}),
        })),
    );
    const servers = Object.entries(landing.servers)
      .filter(([, to]) => to)
      .map(([from2, to]) => ({ from: from2, to }));
    return { targets, servers };
  }

  /** The teams after `i`, written down for the control plane to walk. */
  function queuedAfter(i: number) {
    return queueRef.current.flatMap((q, j) => {
      if (j <= i || !hasWork(j)) return [];
      const own = teamPlansRef.current[j]!;
      const { targets, servers } = targetsOf(own, fleetFor(q.target));
      return [
        {
          apiKey: q.apiKey,
          orgName: q.name || own.orgName || null,
          teamId: q.target.kind === "existing" ? q.target.teamId : null,
          newTeamName:
            q.target.kind === "existing"
              ? null
              : q.name || url.replace(/^https?:\/\//, "").split("/")[0],
          newTeamImage: q.target.kind === "existing" ? null : q.image,
          targets,
          servers,
        },
      ];
    });
  }

  /** The one door into the migration, and it only opens once. */
  async function startChain() {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    try {
      await startFirstTeam();
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }

  /**
   * The whole list, handed over in one call: the first team's run starts now, and
   * every team behind it is written down with its own token, so the control plane
   * walks them whether or not this page is still open.
   */
  async function startFirstTeam() {
    const i = queueRef.current.findIndex((_, j) => hasWork(j));
    if (i === -1) {
      setFailure("Nothing is selected, so there is nothing to migrate.");
      return;
    }
    // Nothing ticked under them: they are not a turn, they are a choice already
    // made - and the control plane is never told about them.
    const walking = queuedAfter(i);
    updateQueue(
      queueRef.current.map((e, j) =>
        j !== i && e.status === "waiting" && !hasWork(j)
          ? { ...e, status: "skipped" }
          : e,
      ),
    );
    setAt(i);
    atRef.current = i;
    const team = queueRef.current[i]!;
    let home: string;
    if (team.target.kind === "existing") home = team.target.teamId;
    else if (madeTeams.current[i]) home = madeTeams.current[i]!;
    else {
      // Named as it was over there, with its picture when the panel had one. A
      // panel that would not name its team still needs one HERE, so the address
      // it came from stands in - the row itself reads "An unnamed organization".
      const made = await gqlAction<{ createTeam: { id: string } }, string>(
        CREATE_TEAM,
        {
          name: team.name || url.replace(/^https?:\/\//, "").split("/")[0],
          // Null is the initials, which is what a team starts with unless
          // somebody chose otherwise on Connect or Review.
          image: team.image,
        },
        (d) => d.createTeam.id,
      );
      if (!made.ok || !made.data)
        return toast.error(
          made.ok ? "Deplo could not create the team." : made.error,
        );
      home = made.data;
      // Remembered rather than written back onto the row: a second press must
      // not make a second team, and the row still says what the person CHOSE -
      // flipping it to "an existing team" read as if it had been there all along.
      madeTeams.current[i] = home;
      // The page's list of teams has one more in it now.
      router.refresh();
    }
    const failed = await landIn(i, home, team.apiKey);
    if (failed) return toast.error(failed);
    await runImport({
      from: latestPlan.current!,
      key: team.apiKey,
      home,
      queued: walking,
    });
  }

  /**
   * Where a landed run is read. The report IS the last step off a takeover -
   * "You're on Deplo" says what came over - with People in front of it when
   * there is a list to hand links out of. A takeover reads the report in Review,
   * because its own last step is the machine changing hands.
   */
  const afterRun = React.useCallback(
    (): StepId => (isTakeover ? "review" : isInstanceAdmin ? "people" : "done"),
    [isTakeover, isInstanceAdmin],
  );

  /**
   * Everything ONE team chose. Which teams are still to come is not one team's,
   * and neither is the panel they all belong to, so both stay.
   */
  const resetTeamState = React.useCallback(() => {
    setUndoing(false);
    setFailure(null);
    setPlan(null);
    setRunId(null);
    setReport(null);
    setAdoptedId(null);
    setChosen(new Set());
    setPlacements({});
    setServerMap({});
    setPendingMachines({});
    attemptedMachines.current = new Set();
    setApiKey("");
    setScanError(null);
    setLogOpen(false);
  }, []);

  /**
   * Back to an empty wizard. The run is over and undone; nothing it made is
   * here, and nothing it chose should be either - a plan half-applied is the one
   * thing that must never be re-submitted by accident.
   *
   * The LIST survives on purpose: this is also where a stopped or failed team
   * lands, and the teams behind it are still to come.
   */
  const resetToStart = React.useCallback(() => {
    resetTeamState();
    setForcedKind(null);
    setStep("connect");
    router.refresh();
  }, [resetTeamState, router]);

  /** Nothing of this panel is wanted any more - another panel, or the way out. */
  const forgetQueue = React.useCallback(() => {
    updateQueue([]);
    setAt(0);
    setPanelTeams(null);
    setTeamPlans({});
    setSessionRuns([]);
    setTeamLinks({});
    setTargetTeamId(null);
    // The last run took the agents off the source machines; the next panel's
    // are registered afresh, by the page's team.
    sourcesTeam.current = teamId;
  }, [teamId]);

  /**
   * Stop, which means undo.
   */
  async function stopRun(id: string) {
    if (!id) return;
    setUndoing(true);
    setAdoptedId(id);
    setRunId(id);
    const res = await gqlAction(STOP, { runId: id }, undefined, inTarget());
    if (!res.ok) {
      setUndoing(false);
      toast.error(res.error);
      return;
    }
    router.refresh();
  }

  /**
   * What the control plane says about this whole walk: which team is moving, which
   * are still queued, what each one landed and who it brought over. One read
   * answers every screen after Start, which is what makes leaving the page and
   * coming back the same screen rather than a report with no context.
   */
  const refreshSession = React.useCallback(
    async (id: string) => {
      const res = await gqlAction<
        { migrationSession: SessionRun[] },
        SessionRun[]
      >(SESSION, { runId: id }, (d) => d.migrationSession);
      if (!res.ok || !res.data || res.data.length === 0) return;
      const runs = res.data;
      setSessionRuns(runs);
      // Whatever the page was rendered with is stale from here on.
      setSnapshot(null);

      // The turn that is happening: the run moving, else the next one waiting for
      // the control plane to start it. Either way the screen is Review, watching.
      const live =
        runs.find((r) => r.status === "running") ??
        runs.find((r) => r.status === "queued");
      if (live) {
        setRunId(live.id);
        setAdoptedId(live.id);
        setTargetTeamId(live.teamId);
        targetTeamRef.current = live.teamId;
        setReport(null);
        setStep((at2) => (at2 === "done" || at2 === "people" ? "review" : at2));
        return;
      }

      // Everything has landed. One report for the walk, and the step after it.
      const landed = runs.filter((r) => r.status === "done");
      const badly = runs.filter(
        (r) => r.status === "failed" || r.status === "stopped",
      );
      if (landed.length === 0) {
        // Stopped or failed before anything came over - and the server has taken
        // it back out, so there is nothing here to decide. Say what happened and
        // hand back an empty wizard.
        const why = badly.find((r) => r.error)?.error;
        if (why) toast.error(why);
        else
          toast.success(
            "The migration was stopped. Its report is under History",
          );
        setSessionRuns([]);
        // The list is the control plane's now and it has cancelled what was left,
        // so the rows here are a queue nothing can run: start again from Connect.
        forgetQueue();
        resetToStart();
        return;
      }
      for (const r of badly)
        if (r.error)
          toast.error(`${r.teamName || r.orgName || ""}: ${r.error}`);
      setReport({
        created: sum(runs, "created"),
        skipped: sum(runs, "skipped"),
        failed: sum(runs, "failed"),
        manual: sum(runs, "manual"),
      });
      // Only off the step that WAS the run: somebody reading the report on the
      // last step must not be thrown back to People by a poll.
      setStep((at2) => (at2 === "review" ? afterRun() : at2));
    },
    [afterRun, forgetQueue, resetToStart],
  );

  /**
   * The run ended somewhere else - in the control plane, which is where it runs
   * now - so this tab has to find out how. Every answer comes off the session:
   * the team that just landed is one of several.
   */
  const settleFinished = React.useCallback(
    async (id: string) => {
      await refreshSession(id);
    },
    [refreshSession],
  );

  /**
   * Leaving the report for good. Until this lands, the page opens on this run
   * every time - which is the whole point on the way IN, and would be a wizard
   * that cannot be started again on the way out.
   */
  async function closeReport() {
    // EVERY team of the walk, not only the one on screen: each is its own run,
    // and one left unseen reopens the wizard on it the next time this page loads.
    const ids = sessionRuns.map((r) => ({ id: r.id, teamId: r.teamId }));
    if (ids.length === 0) {
      const id = adoptedId ?? runId;
      if (id) await gqlAction(DISMISS, { runId: id }, undefined, inTarget());
      return;
    }
    for (const r of ids)
      await gqlAction(DISMISS, { runId: r.id }, undefined, {
        teamId: r.teamId,
      });
  }

  /* ---- step: people ------------------------------------------------ */

  /** The extra link for whoever was not on that panel at all, minted in the team
   *  this row landed in - never the page's. */
  async function mintLinkFor(run: SessionRun) {
    setMintingFor(run.id);
    const res = await gqlAction<{ mintRegistrationLink: string }, string>(
      MINT_LINK,
      {
        input: {
          mode: "existing_teams",
          teamAssignments: [{ teamId: run.teamId, role: "member" }],
        },
      },
      (d) => d.mintRegistrationLink,
    );
    setMintingFor(null);
    if (!res.ok) return toast.error(res.error);
    if (res.data) setTeamLinks((prev) => ({ ...prev, [run.id]: res.data! }));
    router.refresh();
  }

  /**
   * The Deplo team a row lands in, as the Review and the report name it. A team
   * made at Start is on the page's list a refresh later; until then the row's
   * own name stands in.
   */
  function landingOf(q: QueuedTeam) {
    const target = q.target;
    const home =
      target.kind === "existing"
        ? targetTeams.find((t) => t.id === target.teamId)
        : undefined;
    return home
      ? { name: home.name, avatarUrl: home.avatarUrl, isNew: false }
      : { name: sourceTeamName(q), avatarUrl: q.image, isNew: true };
  }

  /** Where each team of the list lands, as the Review names it. */
  const reviewGroups: ReviewGroup[] = queue.flatMap((q, i) => {
    const p = teamPlans[i];
    if (!p) return [];
    const fleet = fleetFor(q.target);
    return [
      {
        key: String(i),
        team: { name: sourceTeamName(q), avatarUrl: null },
        landsIn: landingOf(q),
        target: q.target,
        image: q.image,
        plan: p,
        servers: fleet.servers,
        buildServers: fleet.buildServers,
        rescanning: rescanning[i] === true,
      },
    ];
  });

  /** One group per team of the walk, off the runs themselves - so the step is
   *  the same whether the tab that started them is this one or a reload. The
   *  step itself merges them into one card per person. */
  const landed = sessionRuns.filter((r) => r.status === "done");
  const teamOf = (r: SessionRun) => r.orgName || r.teamName || sourceLabel;
  const peopleGroups: PeopleGroup[] = landed.map((r) => ({
    key: r.id,
    team: { name: teamOf(r), avatarUrl: r.teamAvatarUrl },
    people: r.members,
    inviteLink: teamLinks[r.id] ?? null,
    minting: mintingFor === r.id,
    onMintLink: () => void mintLinkFor(r),
  }));

  /** Every team's landing, for the one report at the end. */
  const teamReports = sessionRuns
    .filter((r) => r.status === "done")
    .map((r) => ({
      name: r.orgName || r.teamName || sourceLabel,
      avatarUrl: r.teamAvatarUrl,
      report: {
        created: r.created,
        skipped: r.skipped,
        failed: r.failed,
        manual: r.manual,
      },
    }));
  const totals = {
    created: sum(sessionRuns, "created"),
    skipped: sum(sessionRuns, "skipped"),
    failed: sum(sessionRuns, "failed"),
    manual: sum(sessionRuns, "manual"),
  };

  /**
   * A machine's agent just came up: it is now one of ours.
   */
  const machineResolved = React.useCallback(
    (
      sourceId: string,
      serverId: string,
      serverName: string,
      address?: string,
    ) => {
      setPlan((prev) =>
        prev
          ? {
              ...prev,
              servers: prev.servers.map((m) =>
                m.sourceId === sourceId
                  ? {
                      ...m,
                      ipAddress: address || m.ipAddress,
                      deploServerId: serverId,
                      deploServerName: serverName,
                      deploServerOnline: true,
                      cloudflare: false,
                    }
                  : m,
              ),
            }
          : prev,
      );
      // Its LANDING is left alone on purpose: this row is the source machine,
      // enrolled `import_only`, and nothing deploys onto one of those.
    },
    [],
  );

  const goToReview = React.useCallback(() => setStep("review"), []);

  /**
   * Leaving the report, which is the only door out of Review on a takeover.
   * Errors do not hold it shut - they are named and acknowledged - but nothing
   * skips it, because it is where "what did not come across" is said.
   */
  function acknowledgeReport() {
    void closeReport();
    setStep(
      isInstanceAdmin && peopleGroups.length > 0
        ? "people"
        : isTakeover
          ? "takeover"
          : "done",
    );
  }

  /* ---- render ------------------------------------------------------ */

  /**
   * Every machine behind that Dokploy answers Deplo - the same condition the
   * install step ends on, hoisted here because the step rail needs it too.
   */
  const machinesReady = React.useMemo(
    () => (plan?.servers ?? []).every((m) => m.deploServerOnline),
    [plan],
  );

  /**
   * The run in flight in the team this turn lands in, whoever started it. The
   * wizard's own feed, not the shell's: the page's team need not be that team.
   */
  const watched = useMigrationFeed(targetTeamId ?? teamId);

  /** The run on screen: the live feed when there is one, the page's own snapshot
   *  until it arrives. */
  const feed = watched ?? snapshot;

  /**
   * Arriving on a run already in progress - or on one whose report nobody has
   * closed yet - is the SAME screen the person left, not a new kind of screen.
   */
  React.useEffect(() => {
    if (restored.current || !resumable) return;
    restored.current = true;
    setRunId(resumable.id);
    setAdoptedId(resumable.id);
    setStep("review");
    void settleFinished(resumable.id);
  }, [resumable, settleFinished]);

  // Fires on the edge, not on the state: `watched` is null for most of this
  // component's life, and settling on every render of a page with no migration
  // would query the server forever.
  const wasWatching = React.useRef<string | null>(null);
  React.useEffect(() => {
    const now = watched?.id ?? null;
    const before = wasWatching.current;
    wasWatching.current = now;
    // Whatever run this tab was showing, not only one it had adopted: the panel is the
    // same for everybody, so the screen it turns into when the run lands has to be too.
    if (before && !now) void settleFinished(before);
  }, [watched, settleFinished]);
  /**
   * A run in flight, on the screen of whoever has this page open. There is ONE
   * panel, and everybody with the page gets it: the person who started the run,
   * the same person after a reload, and the teammate who walked in on it.
   */
  const resumed =
    feed != null && !running && failure === null && step !== "done";
  /** A migration owns the screen, whoever is looking and however they got here.
   *  Undoing one is still one: the panel stays, saying what it is doing, until
   *  the run leaves the feed and the wizard resets. */
  const takenOver = resumed;

  /**
   * This tab holds a run the live feed has not shown it yet - the `startMigration`
   * call has landed and the subscription has not caught up. Without it the wizard
   * fell back to the plan with a live Start button, and pressing it again was
   * refused as somebody else's run.
   */
  const awaitingRun =
    runId != null && feed == null && report == null && failure == null;

  /** What Review is showing: the report, the run, or the tree. */
  const showing = reviewShows({
    running,
    runId: adoptedId ?? runId,
    failure,
    report: report != null,
    plan: plan != null,
  });
  /** The panel, not the tree: Review is showing a run rather than a plan. */
  const moving = step === "review" && showing === "moving";

  // The feed is a decoration, never the only way forward: while this tab holds a
  // run it cannot see, it asks. One small query every 3s, and only then.
  React.useEffect(() => {
    if (!awaitingRun || !runId) return;
    const id = setInterval(() => void settleFinished(runId), 3000);
    return () => clearInterval(id);
  }, [awaitingRun, runId, settleFinished]);

  // One derived value drives the picture. A run in flight wins over the step -
  // driven here or watched from here - because the cable full of packets is the
  // truest thing on the screen at that moment.
  const cuttingOver =
    step === "takeover" &&
    takeover != null &&
    takeover.state !== "pending" &&
    takeover.state !== "failed";
  const pose: MigrationState =
    running || takenOver || cuttingOver
      ? "moving"
      : step === "done" || step === "takeover"
        ? "done"
        : step === "review"
          ? "review"
          : step === "install"
            ? "install"
            : "connect";

  /**
   * Every run this session has produced, in the order they ran. The badges count
   * the whole queue, so the log has to be the whole queue too - it used to open
   * on the last team's run alone and disagree with the numbers above it.
   */
  const currentRunId = adoptedId ?? runId ?? feed?.id ?? null;
  const consoleRuns: ConsoleRun[] = React.useMemo(() => {
    const started = sessionRuns
      .filter((r) => r.status !== "queued")
      .map((r) => ({ id: r.id, teamId: r.teamId }));
    if (started.length > 0) return started;
    return currentRunId
      ? [{ id: currentRunId, teamId: targetTeamId ?? teamId }]
      : [];
  }, [sessionRuns, currentRunId, targetTeamId, teamId]);

  /** A run somebody started, driven from here or merely watched - `starting`
   *  included, because the teams are being created and read before it exists. */
  const inFlight = starting || running || takenOver || awaitingRun;

  /**
   * Where the source machines are granted now: the team of the last run of the
   * walk, since each turn takes them with it. The page's own team until one has.
   */
  const lastSourcesTeam =
    sessionRuns.filter((r) => r.status !== "queued").at(-1)?.teamId ??
    sourcesTeam.current;

  /** Which team of the panel is crossing, for the panel that watches it. */
  const movingTeam = React.useMemo(() => {
    if (sessionRuns.length < 2) return null;
    const at = sessionRuns.findIndex(
      (r) => r.id === (adoptedId ?? runId ?? feed?.id),
    );
    if (at === -1) return null;
    const r = sessionRuns[at];
    return {
      name: r.orgName || r.teamName || sourceLabel,
      at: at + 1,
      of: sessionRuns.length,
    };
  }, [sessionRuns, adoptedId, runId, feed?.id, sourceLabel]);

  /** What the rail is allowed to open, and the only answer to that question. */
  const reach = React.useCallback(
    (s: StepId) =>
      stepReachable(s, {
        mode,
        isTakeover,
        plan: plan != null,
        machinesReady,
        runId: adoptedId ?? runId,
        reportDone: report != null || startOnTakeover,
        teamsLeft,
        inFlight,
        takeoverDone: takeover?.state === "removed",
      }),
    [
      mode,
      isTakeover,
      plan,
      machinesReady,
      adoptedId,
      runId,
      report,
      startOnTakeover,
      teamsLeft,
      inFlight,
      takeover?.state,
    ],
  );

  // Armed from the moment there is something to lose. Not after Finish either - by
  // then the migration is over and every link on the report is somewhere you are
  // meant to go.
  const guarded =
    step !== "done" &&
    report == null &&
    !inFlight &&
    (plan != null || url.trim() !== "" || apiKey.trim() !== "");

  /**
   * Leaving with a plan and no run gives the source machines their machine back.
   */
  const abandonRef = React.useRef(false);
  // No dependency array on purpose: this is the "latest value" of a flag the
  // listeners below read long after the render that produced it.
  React.useEffect(() => {
    abandonRef.current = guarded && plan != null;
  });
  React.useEffect(() => {
    const abandon = () => {
      if (!abandonRef.current) return;
      abandonRef.current = false;
      // Sent to the team the sources are granted to, the way the client would.
      void fetch("/api/graphql", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TEAM_HEADER]: sourcesTeam.current,
        },
        body: JSON.stringify({ query: ABANDON }),
        credentials: "same-origin",
        keepalive: true,
      }).catch(() => {});
    };
    const onPageHide = (e: PageTransitionEvent) => {
      if (!e.persisted) abandon();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      abandon();
    };
  }, []);

  return (
    <>
      {/**
       * The soft half, for a plan somebody spent ten minutes choosing: a confirm on the
       * way out, saying what leaving actually costs.
       */}
      <UnsavedChangesGuard
        when={guarded}
        title="Leave the migration?"
        description="Deplo takes its agent back off the machines it installed one on. Coming back means setting those machines up again."
        confirmLabel="Leave anyway"
        cancelLabel="Stay on this page"
      />

      {/**
       * Every step stacks: the drawing large and centred on top, the rail and the content
       * under it.
       */}
      {step === "done" ? (
        <DoneStep
          kind={kind}
          panelUrl={takeover?.finalUrl ?? null}
          // The takeover read its report in Review, one step before the ports
          // moved; every other migration reads it here.
          report={isTakeover ? null : teamReports.length > 0 ? totals : report}
          teams={teamReports.length > 1 ? teamReports : null}
          uncovered={uncovered}
          onAddTeam={() => setStep("connect")}
          isInstanceAdmin={isInstanceAdmin}
          sourcesTeamId={lastSourcesTeam}
          onShowLog={consoleRuns.length > 0 ? () => setLogOpen(true) : null}
          onAgain={
            isTakeover
              ? null
              : () => {
                  void closeReport().then(() => {
                    forgetQueue();
                    resetToStart();
                  });
                }
          }
          // Leaving is what closes the report: until the dismiss lands the page
          // opens on this run every time.
          onFinish={() => {
            if (takeover) return window.location.assign(takeover.finalUrl);
            void closeReport().then(() => router.push("/"));
          }}
        />
      ) : (
        <div className="mx-auto flex w-full flex-col items-center gap-8">
          {/* The step that ASKS for the machine is about what is left on the
              disk, not about the cable: it takes the disk's own picture. */}
          {step === "takeover" &&
          (takeover?.state === "pending" || takeover?.state === "failed") ? (
            <LeftoverDiskGraphic className="w-full max-w-xl" />
          ) : (
            <MigrationGraphic
              state={pose}
              kind={kind}
              // The takeover screen IS the page, so the drawing carries it. In
              // Settings it sits inside a section that is not about it.
              className={cn(
                "h-auto w-full",
                isTakeover ? "max-w-xl" : "max-w-md",
              )}
            />
          )}

          {/**
           * The narrow measure for every step: a wizard is read top to bottom, and a wide
           * column under a centred picture reads as a page rather than a sequence. People is
           * the exception - it holds a grid of cards, not a sentence.
           */}
          <div
            className={cn(
              "w-full min-w-0",
              step === "people" ? "max-w-3xl" : "max-w-xl",
            )}
          >
            {/* One step is taller than the next, and a page that jumps between
                them reads as a new screen rather than the same one moving on. */}
            <AnimatedHeight scroll={false} className="space-y-6">
              {/* Centred, because the column under it is centred: a rail hugging
                the left edge of a narrow centred column reads as misaligned
                with the heading below it, not as an anchor. Choose is the
                question before the sequence, so it carries no rail at all - and
                neither does the cutover, which IS the end of the road. */}
              {step !== "choose" && !cuttingOver && (
                <div className="flex justify-center">
                  <WizardStepper
                    steps={STEPS}
                    compact
                    current={takenOver ? "review" : step}
                    // `stepReachable` is the only answer, and both the rail and the
                    // bodies below ask it: a gate one of them does not honour is a
                    // suggestion.
                    reachable={reach}
                    onSelect={(s) => {
                      if (!reach(s)) return;
                      setStep(s);
                    }}
                  />
                </div>
              )}

              {/* Nothing is being copied on a clean takeover, so the room for a
                second copy of every volume is not a question. */}
              {mode !== "clean" && preflight}

              <div>
                {!takenOver && step === "choose" && (
                  <ChooseStep
                    kind={kind}
                    onPick={(m) => {
                      setMode(m);
                      setStep(m === "clean" ? "takeover" : "connect");
                    }}
                  />
                )}

                {/* One panel, one run, whoever is looking: the person who started
                  it, the same person after a reload, the teammate who walked in
                  on it. The step they left is the step they get, Stop and all. */}
                {resumed && (
                  <MovingPanel
                    isTakeover={isTakeover}
                    kind={kind}
                    team={movingTeam}
                    progress={
                      feed
                        ? {
                            done: feed.doneSteps,
                            total: feed.totalSteps,
                            current: feed.stepLabel ?? lastStep(feed.lastPath),
                          }
                        : NO_PROGRESS
                    }
                    startedAt={feed ? Date.parse(feed.startedAt) : null}
                    heartbeatAt={feed?.heartbeatAt ?? null}
                    failure={failure}
                    running={resumed}
                    undoing={undoing}
                    onShowLog={() => setLogOpen(true)}
                    onStop={() => void stopRun(feed?.id ?? "")}
                    onBack={resetToStart}
                  />
                )}

                {!takenOver && step === "connect" && (
                  <ConnectStep
                    url={url}
                    setUrl={setUrl}
                    apiKey={apiKey}
                    setApiKey={setApiKey}
                    sameMachineHost={sameMachineHost}
                    takeover={prefill != null}
                    scanning={scanning}
                    kind={kind}
                    forcedKind={forcedKind}
                    setForcedKind={setForcedKind}
                    scanError={scanError}
                    queue={queue}
                    targetTeams={targetTeams}
                    adding={adding}
                    onAdd={() => void identifyAndAdd()}
                    onRetarget={(i, target) => retargetAt(i, target)}
                    onSetImage={(i, image) => setTeamImage(i, image)}
                    onRemove={(i) =>
                      updateQueue(queueRef.current.filter((_, j) => j !== i))
                    }
                    onSubmit={submitConnect}
                    onBack={
                      reach("choose") ? () => setStep("choose") : undefined
                    }
                  />
                )}

                {!takenOver && step === "install" && plan && (
                  <InstallStep
                    kind={kind}
                    sourceUrl={plan.sourceUrl}
                    machines={plan.servers}
                    canAddServers={isInstanceAdmin}
                    pending={pendingMachines}
                    setPending={setPendingMachines}
                    attempted={attemptedMachines}
                    onResolved={machineResolved}
                    onDone={goToReview}
                    onBack={() => setStep("connect")}
                  />
                )}

                {/* The report IS Review finished, so it comes first: a run that
                  landed must not be paintable as a plan to start again. Only a
                  takeover reads it here - see `afterRun`. */}
                {!takenOver &&
                  isTakeover &&
                  step === "review" &&
                  showing === "report" &&
                  report && (
                    <ReportCard
                      report={teamReports.length > 0 ? totals : report}
                      teams={teamReports.length > 1 ? teamReports : null}
                      uncovered={uncovered}
                      onAddTeam={() => setStep("connect")}
                      onShowLog={() => setLogOpen(true)}
                      onContinue={acknowledgeReport}
                      isInstanceAdmin={isInstanceAdmin}
                      sourcesTeamId={lastSourcesTeam}
                    />
                  )}

                {!takenOver &&
                  step === "review" &&
                  showing !== "report" &&
                  (moving ? (
                    <MovingPanel
                      isTakeover={isTakeover}
                      kind={kind}
                      team={movingTeam}
                      progress={NO_PROGRESS}
                      startedAt={null}
                      // The start call is in flight in THIS tab: there is no run
                      // yet, so there is no heartbeat to be missing. Once there IS
                      // one the feed has not shown, nothing is moving yet either.
                      heartbeatAt={
                        awaitingRun ? null : new Date().toISOString()
                      }
                      failure={failure}
                      // A run this tab holds but cannot see yet is still a run: the
                      // plan must not come back under it.
                      running={running || awaitingRun}
                      undoing={false}
                      onShowLog={() => setLogOpen(true)}
                      // Stop is there the moment a run id exists; before that the
                      // `startMigration` call is in flight and there is nothing to stop.
                      onStop={runId ? () => void stopRun(runId) : undefined}
                      onBack={() => setFailure(null)}
                    />
                  ) : showing === "plan" && reviewGroups.length > 0 ? (
                    <ReviewStep
                      kind={kind}
                      groups={reviewGroups}
                      chosen={chosen}
                      setChosen={setChosen}
                      placements={placements}
                      setPlacements={setPlacements}
                      canExposePorts={canExposePorts}
                      targetTeams={targetTeams}
                      onRetarget={(key, target) =>
                        retargetAt(Number(key), target)
                      }
                      onSetImage={(key, image) =>
                        setTeamImage(Number(key), image)
                      }
                      onBack={() => setStep("install")}
                      starting={starting}
                      onStart={() => void startChain()}
                    />
                  ) : null)}

                {!takenOver && step === "people" && (
                  <PeopleStep
                    kind={kind}
                    groups={peopleGroups}
                    onContinue={() => setStep(isTakeover ? "takeover" : "done")}
                  />
                )}

                {/* The rail is what keeps a person out of here until there is
                  something to take over for; the step itself only ever asks. */}
                {!takenOver && step === "takeover" && takeover && mode && (
                  <TakeoverStep
                    platformLabel={takeover.platformLabel}
                    mode={mode}
                    state={takeover.state}
                    // The run this tab drove wins: the page's own read of it is a
                    // refresh away, and the ports must not be asked for with a
                    // null the server can only answer "no such migration" to.
                    finishedRunId={adoptedId ?? runId ?? takeover.finishedRunId}
                    finalUrl={takeover.finalUrl}
                    error={takeover.error}
                    dataLoss={takeover.dataLoss}
                    onBack={
                      reach("choose") ? () => setStep("choose") : undefined
                    }
                  />
                )}
              </div>
            </AnimatedHeight>
          </div>
        </div>
      )}

      {/**
       * Line by line, while it happens.
       */}
      <MigrationConsole
        runs={consoleRuns}
        open={logOpen}
        onOpenChange={setLogOpen}
        live={feed != null}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Step 1 - connect                                                   */
/* ------------------------------------------------------------------ */

/** What each probe answered, out of the warning and behind one link. */
function ScanErrorLog({ log }: { log: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        className="justify-self-start text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        View logs
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>What each panel answered</DialogTitle>
            <DialogDescription>
              Deplo asks both products in turn. Neither one recognised this
              address.
            </DialogDescription>
          </DialogHeader>
          <CodeBlock code={log} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function ConnectStep({
  url,
  setUrl,
  apiKey,
  setApiKey,
  sameMachineHost,
  takeover,
  scanning,
  kind,
  forcedKind,
  setForcedKind,
  scanError,
  queue,
  targetTeams,
  adding,
  onAdd,
  onRetarget,
  onSetImage,
  onRemove,
  onSubmit,
  onBack,
}: {
  url: string;
  setUrl: (v: string) => void;
  apiKey: string;
  setApiKey: (v: string) => void;
  /** The address a container on this instance reaches its own host on. */
  sameMachineHost: string;
  /** The takeover screen: no hint to take one over, and the address is fixed. */
  takeover: boolean;
  scanning: boolean;
  /** What is known so far: what answered, or what was pinned. */
  kind: SourceKind | null;
  forcedKind: SourceKind | null;
  setForcedKind: (v: SourceKind | null) => void;
  scanError: string | null;
  /** The teams added so far - see `./queue`. */
  queue: QueuedTeam[];
  /** The teams a row may land in, besides a new one. */
  targetTeams: TargetTeam[];
  adding: boolean;
  onAdd: () => void;
  onRetarget: (i: number, target: TeamTarget) => void;
  /** The picture the new team is created with. */
  onSetImage: (i: number, image: string | null) => void;
  onRemove: (i: number) => void;
  onSubmit: (e: React.FormEvent) => void;
  /** Back to the choice, while it is still only a choice. */
  onBack?: () => void;
}) {
  const copy = copyFor(kind);
  // One sentence in the warning; what each probe actually got is a log.
  const [scanHeadline, ...scanLines] = (scanError ?? "").split("\n");
  const scanLog = scanLines.join("\n\n");
  const busy = scanning || adding;
  /**
   * One button, and it does the one thing left to do: put the typed token on the
   * list, or set off down the list. Adding is what shows where a team lands,
   * so even one token goes onto the list before the panel is read in full.
   */
  const label = scanning
    ? copy.scanBusy
    : queue.length === 0
      ? copy.scanIdle
      : apiKey.trim()
        ? `Add this ${copy.teamLabel}`
        : `Continue with ${queue.length} ${copy.teamLabel}${queue.length === 1 ? "" : "s"}`;
  return (
    <StepShell
      hero
      title={copy.connectTitle}
      lead="Nothing is written on either side until you have seen what would come over."
      // The takeover screen is the first thing a new instance shows, so its
      // first step arrives the way the setup wizard's does.
      stagger={takeover}
    >
      {/* Its own stagger, so the rows cascade rather than the whole form
          arriving as one block behind the heading. */}
      <form
        className={cn("grid gap-4", takeover && "deplo-stagger")}
        onSubmit={onSubmit}
      >
        <div className="grid gap-2">
          {/**
           * "Panel address", not "Address".
           */}
          <FieldLabel
            htmlFor="source-url"
            info={
              takeover ? (
                `Where ${copy.name} answers on this machine. There is no other panel to point at from here.`
              ) : (
                <>
                  {copy.urlInfo} On the same machine as Deplo, that is{" "}
                  <code>{`http://${sameMachineHost}:${copy.privatePort}`}</code>
                  .
                </>
              )
            }
            docs={copy.docs}
          >
            Panel address
          </FieldLabel>
          {/* On a takeover the address is this machine's own panel: shown so it
              can be read, dimmed and read-only so it is not argued with. */}
          <Input
            id="source-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={copy.urlPlaceholder}
            autoComplete="off"
            spellCheck={false}
            readOnly={takeover}
            className={takeover ? "opacity-60" : undefined}
          />
        </div>

        <div className="grid gap-2">
          <FieldLabel
            htmlFor="source-token"
            info={copy.tokenInfo}
            docs={copy.docs}
          >
            {copy.tokenLabel}
          </FieldLabel>
          {/* The field and its Add sit on one row, so the list below reads as
              what the field feeds. Both h-9: a `sm` button here lands 4px short. */}
          <div className="flex gap-2">
            <Input
              id="source-token"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Paste the key"
              autoComplete="off"
              spellCheck={false}
              className="flex-1"
            />
            <Button
              type="button"
              variant="secondary"
              className="shrink-0"
              disabled={busy || !url.trim() || !apiKey.trim()}
              onClick={onAdd}
            >
              {adding && <Loader2 className="size-4 animate-spin" />}
              Add
            </Button>
          </div>
        </div>

        {queue.length > 0 && (
          <div>
            <p className="text-sm font-medium">Teams to bring over</p>
            <ul className="mt-1 divide-y divide-border rounded-lg border border-border bg-background">
              {queue.map((q, i) => (
                <li
                  key={`${q.sourceTeamId ?? ""}-${i}`}
                  className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
                >
                  {/* A team being MADE gets its picture chosen here; one that
                      already exists keeps its own, so there is nothing to pick. */}
                  {q.target.kind === "new" && q.status === "waiting" ? (
                    <TeamImagePicker
                      name={q.name || copy.teamLabel}
                      image={q.image}
                      disabled={busy}
                      onChange={(image) => onSetImage(i, image)}
                    />
                  ) : (
                    <TeamAvatar
                      name={q.name || copy.teamLabel}
                      avatarUrl={null}
                      size="sm"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {q.name || `An unnamed ${copy.teamLabel}`}
                  </span>
                  {q.status === "done" && <Badge variant="success">Done</Badge>}
                  {q.status === "skipped" && (
                    <Badge variant="secondary">Skipped</Badge>
                  )}
                  {q.status === "stopped" && (
                    <Badge variant="secondary">Stopped</Badge>
                  )}
                  {q.status === "failed" && (
                    <Badge variant="destructive">Failed</Badge>
                  )}
                  {q.status === "waiting" && (
                    <>
                      <span className="text-muted-foreground">lands in</span>
                      <TargetSelect
                        value={q.target}
                        teams={targetTeams}
                        sourceName={q.name || `an unnamed ${copy.teamLabel}`}
                        disabled={busy}
                        onChange={(target) => onRetarget(i, target)}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${q.name || `this ${copy.teamLabel}`}`}
                        onClick={() => onRemove(i)}
                      >
                        <X className="size-4" />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {!takeover && (
          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ServerIcon className="size-4 text-muted-foreground" />
                Take over your VPS
                <Badge variant="info">Beta</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Putting Deplo on the machine {copy.name} already runs on? The
                installer brings everything across and takes the ports for you.
              </p>
            </div>
            <Button variant="secondary" size="sm" className="shrink-0" asChild>
              <a
                href={docsUrl("migration.takeover")}
                target="_blank"
                rel="noreferrer"
              >
                Read the docs
              </a>
            </Button>
          </div>
        )}

        {/**
         * The picker appears on ANY failed first read, not on a special "could not
         * identify" error: if the token is wrong both probes fail on auth, and
         * Deplo genuinely does not know what that panel is. Picking one re-reads it
         * as that platform alone, so the second refusal is that platform's own words.
         */}
        {scanError && (
          <div className="grid gap-3 rounded-lg border border-destructive/40 bg-destructive-wash p-3 leading-relaxed">
            <div className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div className="grid min-w-0 gap-1">
                <p className="text-sm text-muted-foreground">{scanHeadline}</p>
                {scanLog && <ScanErrorLog log={scanLog} />}
              </div>
            </div>
            {/* Hidden once a token has been read: the panel is known, and the
                installer already said which it is on a takeover. */}
            <div hidden={takeover || queue.length > 0}>
              <p className="text-sm font-medium">Which one is this?</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {SOURCE_KINDS.map((k) => (
                  <KindCard
                    key={k}
                    selected={forcedKind === k}
                    onSelect={() => setForcedKind(k)}
                    icon={<SourceMark kind={k} />}
                    title={SOURCE_COPY[k].name}
                    caption={
                      k === "dokploy"
                        ? "Its key comes from Settings, Profile, API/CLI."
                        : "Its token comes from Keys & Tokens."
                    }
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        <div className={cn("flex", onBack ? "justify-between" : "justify-end")}>
          {onBack && (
            <Button type="button" variant="outline" onClick={onBack}>
              Back
            </Button>
          )}
          <Button
            type="submit"
            disabled={
              busy || !url.trim() || (queue.length === 0 && !apiKey.trim())
            }
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {label}
          </Button>
        </div>
      </form>
    </StepShell>
  );
}

/** The value a Select carries for "a team made for it at Start". */

/* ------------------------------------------------------------------ */
/* The move, while it happens                                         */
/* ------------------------------------------------------------------ */

/**
 * What the review turns into once the move starts.
 */
function MovingPanel({
  kind,
  progress,
  startedAt,
  heartbeatAt,
  failure,
  running,
  undoing,
  onShowLog,
  onStop,
  onBack,
  isTakeover = false,
  team = null,
}: {
  /** Which panel this run is reading, for the words that name it. */
  kind: SourceKind | null;
  /** Which team of the walk this is, when the panel has more than one. */
  team?: { name: string; at: number; of: number } | null;
  progress: MigrationProgress;
  /** Epoch ms the run started, or null when there is no run to time yet. */
  startedAt: number | null;
  /** The run's last heartbeat, or null while nothing has picked it up. */
  heartbeatAt: string | null;
  failure: string | null;
  running: boolean;
  /** A Stop is in flight: the server is taking the migration back out. */
  undoing: boolean;
  onShowLog: () => void;
  /** Absent for the second while the run is being opened, when there is no run
   *  id to stop yet. */
  onStop?: () => void;
  onBack: () => void;
  /** The takeover screen has no header chip to come back through. */
  isTakeover?: boolean;
}) {
  const pct = progress.total === 0 ? 0 : (progress.done / progress.total) * 100;
  // Ticks here rather than inside the elapsed line, because a heartbeat goes cold
  // with the clock and nothing else: no frame arrives to say so - that IS the
  // situation - so the whole panel has to be able to change its mind on its own,
  // title included.
  const now = useNow(startedAt != null || heartbeatAt != null);
  const driven = isDriven({ heartbeatAt }, now);
  const panelName = copyFor(kind).name;

  // The start call itself failed, so there is no run: nothing was created, and
  // there is nothing to undo or report on. Back to the plan.
  if (!running && !undoing)
    return (
      <StepShell
        hero
        title="The migration could not start"
        lead={failure ?? "Deplo could not start the migration."}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={onBack}>
            Back to the review
          </Button>
        </div>
      </StepShell>
    );

  return (
    <StepShell
      hero
      title={
        undoing
          ? "Undoing the migration"
          : driven
            ? "Migration in progress"
            : "Waiting to start"
      }
      lead={
        undoing
          ? "Deplo is removing everything this migration created and taking its agent back off the machines it was reading. Nothing is left half moved."
          : driven
            ? isTakeover
              ? "Deplo is doing this on the server. Reload this page any time to come back to it."
              : "Deplo is doing this on the server. Close the page if you like - the chip in the header brings you back."
            : "Deplo has not started this migration yet. It starts on its own within a minute or two. Stop it if you would rather start again."
      }
    >
      {/* Centred under a centred heading: the two lines under the bar say where
          the run is, and a left edge of their own would read as a new column. */}
      <div className="space-y-2 text-center">
        {/* Which team of the panel is crossing right now. One team migrations
            never see it; a queue that a person left and came back to is
            otherwise a bar with no subject. */}
        {team && (
          <p className="text-sm">
            <span className="font-medium">{team.name}</span>
            <span className="text-muted-foreground">
              {` · team ${team.at} of ${team.of}`}
            </span>
          </p>
        )}
        {/* The bar alone stalls for minutes on a big volume - same fill, no
            movement, and it reads as hung. The sweep and the spinner are the
            two things on screen still saying the work is going. */}
        <div className="flex items-center gap-3">
          {/* The sweep and the spinner are the two things on screen still saying
              the work is going - so a run nobody has picked up gets neither.
              An animation over a stalled run is the whole lie in one graphic. */}
          <Progress
            value={pct}
            className={cn(driven && "deplo-progress-working")}
          />
          {driven && (
            <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {undoing
            ? "Removing what came over"
            : !driven
              ? "Not started yet"
              : [
                  progress.total > 0 &&
                    `Project ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`,
                  progress.current,
                ]
                  .filter(Boolean)
                  .join(" \u00b7 ")}
        </p>
        <ElapsedLine startedAt={startedAt} progress={progress} now={now} />
      </div>

      {/* The two ends of the row: Stop is what somebody reaches for while they
          watch this, the log is the afterthought and sits away from it. */}
      <div
        className={cn(
          "flex flex-wrap items-center gap-2",
          onStop && !undoing ? "justify-between" : "justify-end",
        )}
      >
        {onStop && !undoing && (
          // A confirm, because Stop is destructive now and says so: it is the
          // only button on this screen, and pressing it throws away everything
          // the migration has done so far.
          <ConfirmAction
            trigger={
              <Button variant="outline">
                <CircleStop className="size-4" />
                Stop
              </Button>
            }
            title="Stop the migration and undo it?"
            confirmLabel="Stop and undo"
            description={
              <>
                Deplo undoes this migration and takes its agent back off the
                machines it was reading.{" "}
                <strong>There is no half-migrated state to keep.</strong>
              </>
            }
            consequence={`Every app, database and project it created here is removed with its data, and ${panelName} is not started back up.`}
            onConfirm={async () => {
              onStop();
              return { ok: true as const, data: null };
            }}
          />
        )}
        <Button variant="ghost" onClick={onShowLog}>
          <ScrollText className="size-4" />
          Show log
        </Button>
      </div>
    </StepShell>
  );
}

/**
 * The clock the panel reads, ticking once a second while there is a run. This
 * never runs on the server: it exists only while a run is on screen.
 */
function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/**
 * How long it has been going, and roughly how much is left.
 */
function ElapsedLine({
  startedAt,
  progress,
  now,
}: {
  startedAt: number | null;
  progress: MigrationProgress;
  /** The panel's clock - see {@link useNow}. */
  now: number;
}) {
  if (startedAt == null) return null;
  const elapsed = Math.max(0, now - startedAt);
  const left =
    progress.done > 0 && progress.total > progress.done
      ? Math.round((elapsed / progress.done) * (progress.total - progress.done))
      : null;

  return (
    <p className="text-xs text-muted-foreground">
      Running for {formatBuildDuration(elapsed)}
      {left != null && ` \u00b7 about ${formatBuildDuration(left)} left`}
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Step - review, once the run has landed                             */
/* ------------------------------------------------------------------ */

/**
 * What came across and what did not - read on the last step, and on a takeover
 * in Review, which has to say it before the machine changes hands.
 */
function ReportBody({
  report,
  teams = null,
  uncovered,
  onAddTeam,
}: {
  report: RunReport;
  /** Several teams landed in one go: each one's numbers, under its name. Then
   *  `report` is their sum. */
  teams?:
    { name: string; avatarUrl: string | null; report: RunReport }[] | null;
  /** Teams of the panel no token covers - only ever named on a panel that lists
   *  them, which is Dokploy alone. */
  uncovered: string[];
  onAddTeam: () => void;
}) {
  return (
    <>
      <div className="flex flex-wrap justify-center gap-1.5">
        <Badge variant="success">{report.created} created</Badge>
        {report.skipped > 0 && (
          <Badge variant="secondary">{report.skipped} already here</Badge>
        )}
        {report.manual > 0 && (
          <Badge variant="warning">{warnings(report.manual)}</Badge>
        )}
        {report.failed > 0 && (
          <Badge variant="destructive">{report.failed} failed</Badge>
        )}
      </div>
      {teams && teams.length > 1 && (
        <ul className="divide-y divide-border rounded-lg border border-border bg-background">
          {teams.map((t) => (
            <li
              key={t.name}
              className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
            >
              <TeamAvatar name={t.name} avatarUrl={t.avatarUrl} size="sm" />
              <span className="min-w-0 flex-1 truncate font-medium">
                {t.name}
              </span>
              <span className="text-muted-foreground">
                {t.report.created} created
                {t.report.manual > 0 ? `, ${warnings(t.report.manual)}` : ""}
                {t.report.failed > 0 ? `, ${t.report.failed} failed` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Only a panel that lists its teams gets here - the operator is one key
          short of a team they have not thought about. */}
      {uncovered.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-wash-strong px-3 py-2 text-sm leading-relaxed">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <p className="min-w-0 flex-1 text-muted-foreground">
            Still on that panel: {uncovered.join(", ")}.
          </p>
          <Button variant="secondary" size="sm" onClick={onAddTeam}>
            Bring it over
          </Button>
        </div>
      )}
    </>
  );
}

/**
 * Review's finished state on a takeover: what landed, before the step that
 * takes the ports. Nothing skips it - an error is acknowledged here rather than
 * being a dead end. Off a takeover the report is the last step itself.
 */
function ReportCard({
  report,
  teams,
  uncovered,
  onAddTeam,
  onShowLog,
  onContinue,
  isInstanceAdmin,
  sourcesTeamId,
}: React.ComponentProps<typeof ReportBody> & {
  /** The wizard's own console - the same one the panel opened while it ran. */
  onShowLog: () => void;
  onContinue: () => void;
  /** Uninstalling an agent is instance-admin, like every server action. */
  isInstanceAdmin: boolean;
  /** The team the source machines are granted to, where a leftover would be. */
  sourcesTeamId: string;
}) {
  return (
    <StepShell
      hero
      title="Your projects are on Deplo"
      lead="Nothing is deployed yet. Open an app, check it over, and press Deploy when you want the traffic."
    >
      <ReportBody
        report={report}
        teams={teams}
        uncovered={uncovered}
        onAddTeam={onAddTeam}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" onClick={onShowLog}>
          <ScrollText className="size-4" />
          Show log
        </Button>
        <Button onClick={onContinue}>Continue</Button>
      </div>

      {/* Only ever shown when an agent really is still out there: finishing the
          run uninstalls them, so this is the line for the one that would not go
          quietly. */}
      {isInstanceAdmin && <RemoveMigrationSources teamId={sourcesTeamId} />}
    </StepShell>
  );
}

/* ------------------------------------------------------------------ */
/* Step - done                                                        */
/* ------------------------------------------------------------------ */

/** How long the celebration is left up before the panel opens itself. */
const REDIRECT_MS = 3000;

/**
 * The end, in the same stacked shape as every other step - and the only one with
 * no question under the drawing, just what happened and the way out. Off a
 * takeover it is also where the run's report is read: one screen saying you are
 * on Deplo and what came over, never two.
 */
function DoneStep({
  kind,
  panelUrl,
  report,
  teams,
  uncovered,
  onAddTeam,
  isInstanceAdmin,
  sourcesTeamId,
  onShowLog,
  onAgain,
  onFinish,
}: Omit<React.ComponentProps<typeof ReportBody>, "report"> & {
  /** Which panel this came from, for the drawing's label. */
  kind: SourceKind | null;
  /** Where the dashboard answers now, on a takeover. Null off one. */
  panelUrl: string | null;
  /** What the run did. Null on a takeover, which read it back in Review. */
  report: RunReport | null;
  /** Uninstalling an agent is instance-admin, like every server action. */
  isInstanceAdmin: boolean;
  /** The team the source machines are granted to, where a leftover would be. */
  sourcesTeamId: string;
  /** The wizard's own console. Null when nothing ran - a clean takeover. */
  onShowLog: (() => void) | null;
  /** Close the report and hand back an empty wizard. Null on a takeover: the
   *  machine has changed hands, so there is no other panel to bring over. */
  onAgain: (() => void) | null;
  onFinish: () => void;
}) {
  // The machine has changed hands and this origin may already be gone, so the
  // way on opens itself rather than waiting on a click nobody is here to make.
  React.useEffect(() => {
    if (!panelUrl) return;
    const t = setTimeout(onFinish, REDIRECT_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelUrl]);

  return (
    <div className="mx-auto flex w-full flex-col items-center gap-8">
      {/**
       * Over the WINDOW, not over the drawing. A burst thrown from the middle of the
       * screen is still a burst thrown from the middle of the screen - which is where the
       * illustration is, so that is what it looks like it came out of.
       */}
      <ConfettiBurst rain className="z-50" count={60} />

      <MigrationGraphic
        state="done"
        kind={kind}
        className="h-auto w-full max-w-md"
      />

      <div className="w-full max-w-xl min-w-0">
        <StepShell
          hero
          title={panelUrl ? "This machine is Deplo's" : "You're on Deplo"}
          lead={
            panelUrl
              ? `Opening ${panelUrl}`
              : "Nothing is deployed yet. Open an app, check it over, and press Deploy when you want the traffic."
          }
        >
          {report && (
            <ReportBody
              report={report}
              teams={teams}
              uncovered={uncovered}
              onAddTeam={onAddTeam}
            />
          )}
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {onShowLog && (
                <Button variant="outline" onClick={onShowLog}>
                  <ScrollText className="size-4" />
                  Show log
                </Button>
              )}
              {onAgain && (
                <Button variant="outline" onClick={onAgain}>
                  <Repeat className="size-4" />
                  Migrate another
                </Button>
              )}
            </div>
            <Button onClick={onFinish}>
              {panelUrl ? "Open Deplo" : "Finish"}
            </Button>
          </div>

          {/* Only ever shown when an agent really is still out there: finishing
              the run uninstalls them, so this is the line for the one that would
              not go quietly. */}
          {report && isInstanceAdmin && (
            <RemoveMigrationSources teamId={sourcesTeamId} />
          )}
        </StepShell>
      </div>
    </div>
  );
}
