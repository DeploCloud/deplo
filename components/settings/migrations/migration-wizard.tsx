"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  CircleStop,
  Loader2,
  Plus,
  Repeat,
  ScrollText,
  Server as ServerIcon,
  TriangleAlert,
  X,
} from "lucide-react";

import { gqlAction } from "@/lib/graphql-client";
import { TEAM_HEADER } from "@/lib/team-path";
import { isValidTeamAvatarValue } from "@/lib/apps/avatar-shared";
import { docsUrl } from "@/lib/docs";
import { formatBuildDuration } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { KindCard } from "@/components/shared/kind-card";
import { TeamAvatar } from "@/components/shared/user-avatar";
import { FieldLabel } from "@/components/ui/info-tip";
import { ConfettiBurst } from "@/components/shared/confetti-burst";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { WizardStepper } from "@/components/shared/wizard-stepper";
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
import { MigrationConsole } from "./migration-console";
import { StepShell } from "./step-shell";
import { ChooseStep } from "./choose-step";
import {
  reviewShows,
  stepReachable,
  stepsFor,
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
  type Invite,
  type MigrationProgress,
  type Placement,
  type Plan,
  type ServerChoice,
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
    $keepSources: Boolean
  ) {
    startMigration(
      input: $input
      orgName: $orgName
      targets: $targets
      servers: $servers
      keepSources: $keepSources
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
      teamAvatarUrl
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
      orgAvatarUrl
      otherTeams
      servers {
        sourceId
        name
        ipAddress
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

const IMPORT_MEMBERS = /* GraphQL */ `
  mutation ImportMigrationMembers(
    $input: MigrationSourceInput!
    $runId: String!
  ) {
    importMigrationMembers(input: $input, runId: $runId) {
      email
      name
      link
      outcome
      message
    }
  }
`;

const MINT_LINK = /* GraphQL */ `
  mutation MintImportInviteLink($input: MintRegistrationLinkInput!) {
    mintRegistrationLink(input: $input)
  }
`;

/** How a run ended, and what it did. The console asks for the lines; this is the
 *  three numbers the report is made of. */
const RUN_REPORT = /* GraphQL */ `
  query MigrationReport($id: String!) {
    migrationRun(id: $id) {
      status
      error
      created
      skipped
      failed
      manual
    }
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
  const [teamRuns, setTeamRuns] = React.useState<
    Record<number, { runId: string; teamId: string; report: RunReport }>
  >({});
  const [teamInvites, setTeamInvites] = React.useState<
    Record<number, Invite[] | null>
  >({});
  const [teamLinks, setTeamLinks] = React.useState<
    Record<number, string | null>
  >({});
  const [mintingFor, setMintingFor] = React.useState<number | null>(null);
  const [inviting, setInviting] = React.useState(false);
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

  /** How many teams of this panel are still behind the one on screen. */
  const teamsLeft = teamsAfter(queue, at);
  /** The panel's teams no token here covers yet. Empty on a panel that will not
   *  name them, where the wizard asks instead. */
  const uncovered = uncoveredTeams(panelTeams, queue);

  /** What is known about the panel so far: what answered, or what was pinned. */
  const kind: SourceKind | null = plan?.platform ?? forcedKind;

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
   * Hand one team's run to the control plane and stop being the driver.
   */
  async function runImport(opts: {
    from: Plan;
    key: string;
    home: string;
    keepSources: boolean;
  }) {
    if (running) return;
    // Placed on the landing team's fleet: a host that team may not use is not a
    // placement, it is a deploy that dies halfway with the services stopped.
    const fleet = fleetsRef.current[opts.home] ?? ownFleet;
    const landing = reconcilePlacements(
      placementsRef.current,
      serverMapRef.current,
      fleet.servers,
      fleet.buildServers,
    );
    const ticked = chosenRef.current;
    const targets = opts.from.projects.flatMap((p) =>
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
        servers: Object.entries(landing.servers)
          .filter(([, to]) => to)
          .map(([from, to]) => ({ from, to })),
        // Another team of this panel is queued behind this run, so it must leave
        // Deplo's agents on the source machines: the next one reads the same
        // disks. It also holds the takeover until the list is done.
        keepSources: opts.keepSources,
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
    // The key is the control plane's now, and this tab has no further use for
    // it. Holding it after handing it over is a copy nobody remembers exists.
    setApiKey("");
  }

  /** The list with one row changed, kept in step for the chain. */
  function updateQueue(next: QueuedTeam[]) {
    queueRef.current = next;
    setQueue(next);
  }

  /**
   * Team `i` of the list, and then the next, with nobody pressing anything in
   * between: the Deplo team it lands in is made when it is to be, the panel is
   * read again under it, and its run starts. `settleFinished` calls this again
   * for the team after, and shows one report when the last one has landed.
   */
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

  async function runTeam(i: number) {
    const team = queueRef.current[i];
    if (!team) return showLastReport();
    if (team.status !== "waiting") return runTeam(i + 1);
    setAt(i);
    atRef.current = i;
    // Nothing ticked under it: nothing to run, and nothing to stop the rest for.
    if (!hasWork(i)) {
      updateQueue(
        queueRef.current.map((e, j) =>
          j === i ? { ...e, status: "skipped" } : e,
        ),
      );
      return runTeam(i + 1);
    }
    setRunId(null);
    setAdoptedId(null);
    setReport(null);
    let home: string;
    if (team.target.kind === "existing") home = team.target.teamId;
    else {
      // Named as it was over there, with its picture when the panel had one.
      const made = await gqlAction<{ createTeam: { id: string } }, string>(
        CREATE_TEAM,
        {
          name: team.name,
          image:
            team.avatarUrl && isValidTeamAvatarValue(team.avatarUrl)
              ? team.avatarUrl
              : null,
        },
        (d) => d.createTeam.id,
      );
      if (!made.ok || !made.data)
        return toast.error(
          made.ok ? "Deplo could not create the team." : made.error,
        );
      home = made.data;
      updateQueue(
        retarget(queueRef.current, i, { kind: "existing", teamId: home }),
      );
      // The page's list of teams has one more in it now.
      router.refresh();
    }
    const failed = await landIn(i, home, team.apiKey);
    if (failed) return toast.error(failed);
    await runImport({
      from: latestPlan.current!,
      key: team.apiKey,
      home,
      // Only a team that will actually run still needs the agents there.
      keepSources: queueRef.current.some((_, j) => j > i && hasWork(j)),
    });
  }
  const runTeamRef = React.useRef(runTeam);
  runTeamRef.current = runTeam;

  /** What the last run of the chain did - the report, once the list is walked. */
  const lastLanded = React.useRef<RunReport | null>(null);
  function showLastReport() {
    if (!lastLanded.current) return;
    setReport(lastLanded.current);
    setStep("review");
  }

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
    setTeamRuns({});
    setTeamInvites({});
    setTeamLinks({});
    setTargetTeamId(null);
    lastLanded.current = null;
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
   * The run ended somewhere else - in the control plane, which is where it runs
   * now - so this tab has to find out how.
   */
  const settleFinished = React.useCallback(
    async (id: string) => {
      const res = await gqlAction<
        {
          migrationRun:
            (RunReport & { status: string; error: string | null }) | null;
        },
        (RunReport & { status: string; error: string | null }) | null
      >(RUN_REPORT, { id }, (d) => d.migrationRun, inTarget());
      if (!res.ok || !res.data) return;
      // Still moving: the live feed owns the screen. Only the arrival path gets
      // here - the edge below fires when the feed has already gone quiet.
      if (res.data.status === "running") return;
      // Whatever the page was rendered with is stale from here on.
      setSnapshot(null);
      // The list says how each team went, so a report closed hours later still
      // reads as "two over, one to go".
      const outcome: QueuedTeam["status"] =
        res.data.status === "done"
          ? "done"
          : res.data.status === "stopped"
            ? "stopped"
            : "failed";
      const i = atRef.current;
      const next = queueRef.current.map((e, j) =>
        j === i ? { ...e, status: outcome } : e,
      );
      queueRef.current = next;
      setQueue(next);
      if (res.data.status === "done") {
        const { created, skipped, failed, manual } = res.data;
        const landed = { created, skipped, failed, manual };
        lastLanded.current = landed;
        setTeamRuns((prev) => ({
          ...prev,
          [i]: { runId: id, teamId: targetTeamRef.current, report: landed },
        }));
        // Another team is still on the list: this one is written down, and the
        // next starts on its own. Only the last one's landing opens the report.
        const after = next.findIndex((q, j) => j > i && q.status === "waiting");
        if (after !== -1) {
          await gqlAction(DISMISS, { runId: id }, undefined, inTarget());
          void runTeamRef.current(after);
          return;
        }
        // The step does NOT move: the report IS this step's finished state, and
        // the way on is the person acknowledging it (see `acknowledgeReport`).
        setReport(landed);
        setStep("review");
        return;
      }
      // Stopped or failed - and either way the server has already taken it back
      // out, so there is nothing here to decide and nothing left to keep. Say
      // what happened and hand back an empty wizard.
      if (res.data.error) toast.error(res.data.error);
      else
        toast.success(
          "The migration was stopped, and everything it created was removed",
        );
      resetToStart();
    },
    [resetToStart],
  );

  /**
   * Leaving the report for good. Until this lands, the page opens on this run
   * every time - which is the whole point on the way IN, and would be a wizard
   * that cannot be started again on the way out.
   */
  async function closeReport() {
    const id = adoptedId ?? runId;
    if (id) await gqlAction(DISMISS, { runId: id }, undefined, inTarget());
  }

  /* ---- step: people ------------------------------------------------ */

  /** One team of the list: its invites are minted in ITS Deplo team, where its
   *  run lives, so the call names that team rather than the page's. */
  async function inviteFor(i: number) {
    const run = teamRuns[i];
    const team = queue[i];
    if (!run || !team) return;
    setInviting(true);
    const res = await gqlAction<{ importMigrationMembers: Invite[] }, Invite[]>(
      IMPORT_MEMBERS,
      {
        input: { url, apiKey: team.apiKey, kind: plan?.platform ?? null },
        runId: run.runId,
      },
      (d) => d.importMigrationMembers,
      { teamId: run.teamId },
    );
    setInviting(false);
    if (!res.ok) {
      toast.error(`${team.name}: ${res.error}`);
      return;
    }
    setTeamInvites((prev) => ({ ...prev, [i]: res.data ?? [] }));
    router.refresh();
  }

  async function mintLinkFor(i: number) {
    const run = teamRuns[i];
    if (!run) return;
    setMintingFor(i);
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
    setTeamLinks((prev) => ({ ...prev, [i]: res.data ?? null }));
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
      : { name: q.name, avatarUrl: q.avatarUrl, isNew: true };
  }

  /** Where each team of the list lands, as the Review names it. */
  const reviewGroups: ReviewGroup[] = queue.flatMap((q, i) => {
    const p = teamPlans[i];
    if (!p) return [];
    const fleet = fleetFor(q.target);
    return [
      {
        key: String(i),
        team: { name: q.name, avatarUrl: q.avatarUrl },
        landsIn: landingOf(q),
        plan: p,
        servers: fleet.servers,
        buildServers: fleet.buildServers,
      },
    ];
  });

  const peopleGroups: PeopleGroup[] = queue.flatMap((q, i) => {
    const p = teamPlans[i];
    if (!p || !teamRuns[i]) return [];
    return [
      {
        key: String(i),
        team: { name: q.name, avatarUrl: q.avatarUrl },
        people: p.members.filter((m) => !m.inTeam),
        invites: teamInvites[i] ?? null,
        canInvite: true,
        onInvite: () => inviteFor(i),
        inviteLink: teamLinks[i] ?? null,
        minting: mintingFor === i,
        onMintLink: () => void mintLinkFor(i),
      },
    ];
  });

  /** Every team's landing, for the one report at the end. */
  const teamReports = queue.flatMap((q, i) =>
    teamRuns[i]
      ? [{ name: q.name, avatarUrl: q.avatarUrl, report: teamRuns[i].report }]
      : [],
  );
  const totals = teamReports.reduce(
    (sum, t) => ({
      created: sum.created + t.report.created,
      skipped: sum.skipped + t.report.skipped,
      failed: sum.failed + t.report.failed,
      manual: sum.manual + t.report.manual,
    }),
    { created: 0, skipped: 0, failed: 0, manual: 0 },
  );

  /**
   * A machine's agent just came up: it is now one of ours.
   */
  const machineResolved = React.useCallback(
    (sourceId: string, serverId: string, serverName: string) => {
      setPlan((prev) =>
        prev
          ? {
              ...prev,
              servers: prev.servers.map((m) =>
                m.sourceId === sourceId
                  ? {
                      ...m,
                      deploServerId: serverId,
                      deploServerName: serverName,
                      deploServerOnline: true,
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
   * Leaving the report, which is the only door out of Review once a run has
   * landed. Errors do not hold it shut - they are named and acknowledged - but
   * nothing skips it, because it is where "what did not come across" is said.
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
  const pose: MigrationState =
    running || takenOver
      ? "moving"
      : step === "done" || step === "takeover"
        ? "done"
        : step === "review"
          ? "review"
          : step === "install"
            ? "install"
            : "connect";

  /** A run somebody started, driven from here or merely watched. */
  const inFlight = running || takenOver || awaitingRun;

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
          onShowLog={(adoptedId ?? runId) ? () => setLogOpen(true) : null}
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
          onFinish={() => {
            if (takeover) return window.location.assign(takeover.finalUrl);
            router.push("/");
          }}
        />
      ) : (
        <div className="mx-auto flex w-full flex-col items-center gap-8">
          <MigrationGraphic
            state={pose}
            kind={kind}
            className="h-auto w-full max-w-md"
          />

          {/**
           * One width for every step, and it is the narrow one: a wizard is read top to
           * bottom, and a 48rem measure under a centred picture reads as a page rather than a
           * sequence.
           */}
          <div className="w-full max-w-xl min-w-0 space-y-6">
            {/* Centred, because the column under it is centred: a rail hugging
                the left edge of a narrow centred column reads as misaligned
                with the heading below it, not as an anchor. */}
            <div className="flex justify-center">
              <WizardStepper
                steps={STEPS}
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

            {/* Nothing is being copied on a clean takeover, so the room for a
                second copy of every volume is not a question. */}
            {mode !== "clean" && preflight}

            <div>
              {!takenOver && step === "choose" && (
                <ChooseStep
                  kind={kind}
                  mode={mode}
                  onSelect={setMode}
                  onContinue={() =>
                    setStep(mode === "clean" ? "takeover" : "connect")
                  }
                />
              )}

              {/* One panel, one run, whoever is looking: the person who started
                  it, the same person after a reload, the teammate who walked in
                  on it. The step they left is the step they get, Stop and all. */}
              {resumed && (
                <MovingPanel
                  isTakeover={isTakeover}
                  kind={kind}
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
                  uncovered={uncovered}
                  adding={adding}
                  onAdd={() => void identifyAndAdd()}
                  onRetarget={(i, target) =>
                    updateQueue(retarget(queueRef.current, i, target))
                  }
                  onRemove={(i) =>
                    updateQueue(queueRef.current.filter((_, j) => j !== i))
                  }
                  onSubmit={submitConnect}
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
                />
              )}

              {/* The report IS Review finished, so it comes first: a run that
                  landed must not be paintable as a plan to start again. */}
              {!takenOver &&
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
                    sourcesTeamId={sourcesTeam.current}
                  />
                )}

              {!takenOver &&
                step === "review" &&
                showing !== "report" &&
                (moving ? (
                  <MovingPanel
                    isTakeover={isTakeover}
                    kind={kind}
                    progress={NO_PROGRESS}
                    startedAt={null}
                    // The start call is in flight in THIS tab: there is no run
                    // yet, so there is no heartbeat to be missing. Once there IS
                    // one the feed has not shown, nothing is moving yet either.
                    heartbeatAt={awaitingRun ? null : new Date().toISOString()}
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
                    onChangeTarget={() => setStep("connect")}
                    onBack={() => setStep("install")}
                    onStart={() => void runTeam(0)}
                  />
                ) : null)}

              {!takenOver && step === "people" && (
                <PeopleStep
                  kind={kind}
                  groups={peopleGroups}
                  inviting={inviting}
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
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/**
       * Line by line, while it happens.
       */}
      <MigrationConsole
        runId={adoptedId ?? runId ?? feed?.id ?? null}
        teamId={targetTeamId ?? teamId}
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
  uncovered,
  adding,
  onAdd,
  onRetarget,
  onRemove,
  onSubmit,
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
  /** The panel's teams no token here covers, when the panel will name them. */
  uncovered: string[];
  adding: boolean;
  onAdd: () => void;
  onRetarget: (i: number, target: TeamTarget) => void;
  onRemove: (i: number) => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const copy = copyFor(kind);
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
            <ul className="mt-1 divide-y divide-border rounded-lg border border-border">
              {queue.map((q, i) => (
                <li
                  key={`${q.sourceTeamId ?? ""}-${i}`}
                  className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
                >
                  {/* The panel's own picture for it, and the team's monogram
                      when it keeps none - the same renderer every other team
                      list in the product uses. */}
                  <TeamAvatar
                    name={q.name || copy.teamLabel}
                    avatarUrl={q.avatarUrl}
                    size="sm"
                  />
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
                        aria-label={`Remove ${q.name}`}
                        onClick={() => onRemove(i)}
                      >
                        <X className="size-4" />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {uncovered.length > 0 && (
              <p className="mt-1 text-sm text-muted-foreground">
                {`Not covered yet: ${uncovered.join(", ")}. Each needs its own ${copy.tokenLabel}.`}
              </p>
            )}
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
          <div className="grid gap-3 rounded-lg border border-destructive/40 bg-destructive/[0.06] p-3">
            <div className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
              <p className="min-w-0 text-sm text-muted-foreground">
                {scanError}
              </p>
            </div>
            {/* The installer already said which panel this is on a takeover. */}
            <div hidden={takeover}>
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
              <p className="mt-1 text-sm text-muted-foreground">
                Deplo migrates these two.
              </p>
            </div>
          </div>
        )}

        <div className="flex justify-end">
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
const NEW_TEAM = "new";

/**
 * Where one source team lands: a team that exists, or one named after it. The
 * namesake is the default (see `defaultTarget`); this is the way to say otherwise.
 */
function TargetSelect({
  value,
  teams,
  sourceName,
  disabled,
  onChange,
}: {
  value: TeamTarget;
  teams: TargetTeam[];
  /** What the new team would be called. */
  sourceName: string;
  disabled: boolean;
  onChange: (target: TeamTarget) => void;
}) {
  return (
    <Select
      value={value.kind === "new" ? NEW_TEAM : value.teamId}
      onValueChange={(v) =>
        onChange(
          v === NEW_TEAM ? { kind: "new" } : { kind: "existing", teamId: v },
        )
      }
      disabled={disabled}
    >
      <SelectTrigger
        className="w-[13rem]"
        aria-label={`Where ${sourceName} lands`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {teams.length > 0 && (
          <SelectGroup>
            <SelectLabel>Existing teams</SelectLabel>
            {teams.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                <span className="flex items-center gap-2">
                  <TeamAvatar name={t.name} avatarUrl={t.avatarUrl} size="xs" />
                  <span className="truncate">{t.name}</span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        <SelectItem value={NEW_TEAM}>
          <span className="flex items-center gap-2">
            <Plus className="size-4 text-muted-foreground" />
            <span className="truncate">
              New team &ldquo;{sourceName}&rdquo;
            </span>
          </span>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

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
}: {
  /** Which panel this run is reading, for the words that name it. */
  kind: SourceKind | null;
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
      <div className="space-y-2">
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

      {/* Both at the end of the row, Stop first: it is the one somebody is
          reaching for while they watch this, and the log is the afterthought. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
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
 * What Review turns into once the run is over: what came across, what did not,
 * and the one way on. Nothing skips it - it is where "a person has to look at
 * this" gets said, and an error is acknowledged rather than a dead end.
 */
function ReportCard({
  report,
  teams = null,
  uncovered,
  onAddTeam,
  onShowLog,
  onContinue,
  isInstanceAdmin,
  sourcesTeamId,
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
  /** The wizard's own console - the same one the panel opened while it ran. */
  onShowLog: () => void;
  onContinue: () => void;
  /** Uninstalling an agent is instance-admin, like every server action. */
  isInstanceAdmin: boolean;
  /** The team the source machines are granted to, where a leftover would be. */
  sourcesTeamId: string;
}) {
  const needsAPerson = report.failed + report.manual;

  return (
    <StepShell
      title="Your projects are on Deplo"
      lead="Nothing is deployed yet. Open an app, check it over, and press Deploy when you want the traffic."
    >
      <div className="flex flex-wrap gap-1.5">
        <Badge variant="success">{report.created} created</Badge>
        {report.skipped > 0 && (
          <Badge variant="secondary">{report.skipped} already here</Badge>
        )}
        {report.manual > 0 && (
          <Badge variant="warning">{report.manual} need you</Badge>
        )}
        {report.failed > 0 && (
          <Badge variant="destructive">{report.failed} failed</Badge>
        )}
      </div>
      {teams && teams.length > 1 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
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
                {t.report.manual > 0 ? `, ${t.report.manual} need you` : ""}
                {t.report.failed > 0 ? `, ${t.report.failed} failed` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* The acknowledgement's other half: the button says "I understand", so
          this has to say what there is to understand. */}
      {needsAPerson > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <p className="min-w-0 flex-1 text-muted-foreground">
            {needsAPerson === 1
              ? "One thing needs you."
              : `${needsAPerson} things need you.`}{" "}
            The log says which, and why.
          </p>
        </div>
      )}

      {/* Only a panel that lists its teams gets here - the operator is one key
          short of a team they have not thought about. */}
      {uncovered.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <p className="min-w-0 flex-1 text-muted-foreground">
            Still on that panel: {uncovered.join(", ")}.
          </p>
          <Button variant="secondary" size="sm" onClick={onAddTeam}>
            Bring it over
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" onClick={onShowLog}>
          <ScrollText className="size-4" />
          Show log
        </Button>
        <Button onClick={onContinue}>
          {needsAPerson > 0 ? "I understand, continue" : "Continue"}
        </Button>
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
 * The end, and the one step that breaks the two-column layout. Everywhere else the
 * illustration sits beside the thing you are doing, because there is a thing you
 * are doing.
 */
function DoneStep({
  kind,
  panelUrl,
  onShowLog,
  onAgain,
  onFinish,
}: {
  /** Which panel this came from, for the drawing's label. */
  kind: SourceKind | null;
  /** Where the dashboard answers now, on a takeover. Null off one. */
  panelUrl: string | null;
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
    <div className="mx-auto flex max-w-xl flex-col items-center gap-6 text-center">
      {/**
       * Over the WINDOW, not over the drawing. A burst thrown from the middle of the
       * screen is still a burst thrown from the middle of the screen - which is where the
       * illustration is, so that is what it looks like it came out of.
       */}
      <ConfettiBurst rain className="z-50" count={60} />

      <MigrationGraphic state="done" kind={kind} className="h-48 w-auto" />

      <div>
        <h2 className="text-xl font-semibold">
          {panelUrl ? "This machine is Deplo's" : "You're on Deplo"}
        </h2>
        <p className="mt-1 text-sm text-balance text-muted-foreground">
          {panelUrl
            ? `Opening ${panelUrl}`
            : "Nothing is deployed yet. Open an app, check it over, and press Deploy when you want the traffic."}
        </p>
      </div>

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
        <Button onClick={onFinish}>{panelUrl ? "Open Deplo" : "Finish"}</Button>
      </div>
    </div>
  );
}
