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
  Users,
  X,
} from "lucide-react";

import { gqlAction } from "@/lib/graphql-client";
import { docsUrl } from "@/lib/docs";
import { formatBuildDuration } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { KindCard } from "@/components/shared/kind-card";
import { FieldLabel } from "@/components/ui/info-tip";
import { ConfettiBurst } from "@/components/shared/confetti-burst";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { WizardStepper } from "@/components/shared/wizard-stepper";
import { UnsavedChangesGuard } from "@/components/apps/unsaved-changes-guard";
import {
  isDriven,
  useActiveMigration,
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
import { ReviewStep } from "./review-step";
import { PeopleStep } from "./people-step";
import { MigrationConsole, RUN_LOG } from "./migration-console";
import { StepShell } from "./step-shell";
import { stepsFor, type StepId } from "./steps";
import {
  addTeam,
  teamsAfter,
  uncoveredTeams,
  type QueuedTeam,
  type SourceTeam,
} from "./queue";
import { CreateTeamDialog } from "@/components/teams/create-team-dialog";
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
 * Migrating a Dokploy over, as one screen. The API key never leaves this
 * component's state.
 */

/** Dokploy's own host has no server row over there; it is the empty id. */
const OWN_HOST = "";

/** Two names for one team, whatever anyone typed around them. */
function sameTeamName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
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
      otherTeams
    }
  }
`;

const SCAN = /* GraphQL */ `
  mutation ScanMigrationSource($input: MigrationSourceInput!) {
    scanMigrationSource(input: $input) {
      platform
      sourceUrl
      orgName
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

const SWITCH_TEAM = /* GraphQL */ `
  mutation SwitchTeam($teamId: String!) {
    switchTeam(teamId: $teamId)
  }
`;

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
  teamName,
  teamAvatarUrl,
  targetTeams,
  servers,
  buildServers,
  isInstanceAdmin,
  canExposePorts,
  resumable,
  sameMachineHost,
  prefill = null,
  takeoverStep = null,
  startOnTakeover = false,
}: {
  teamId: string;
  teamName: string;
  teamAvatarUrl: string | null;
  /** Every team this migration could land in, this one included. */
  targetTeams: TargetTeam[];
  servers: ServerChoice[];
  buildServers: ServerChoice[];
  isInstanceAdmin: boolean;
  /** The publish-ports grant. Without it a database's port cannot come over at all. */
  canExposePorts: boolean;
  /**
   * The run this person is in the middle of, read at page load: one still moving,
   * or one whose report they have not closed yet.
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
   * Taking the ports, as the wizard's last step. Present only on the takeover
   * screen, which is also what puts `Take over` in the rail.
   */
  takeoverStep?: React.ReactNode;
  /** A takeover whose migration already finished and whose report was closed:
   *  the only thing left is the last step, so open on it. */
  startOnTakeover?: boolean;
  /**
   * An address handed over from the History tab. The nonce is what makes
   * picking the same run twice still land in the field.
   */
}) {
  const router = useRouter();

  const [step, setStep] = React.useState<StepId>(
    startOnTakeover ? "takeover" : "connect",
  );
  const [url, setUrl] = React.useState(prefill?.url ?? "");
  const [apiKey, setApiKey] = React.useState("");
  const [scanning, setScanning] = React.useState(false);
  /**
   * The panel's teams and the token that reads each, in the order they are
   * brought over - a token reads exactly one team on both products. `at` is whose
   * turn it is; both outlive one team's run, which is what makes this a queue.
   */
  const [queue, setQueue] = React.useState<QueuedTeam[]>([]);
  const [at, setAt] = React.useState(0);
  /** An `Add` in flight. */
  const [adding, setAdding] = React.useState(false);
  /** Every team the panel would name, so the ones no token covers can be listed.
   *  Null from a panel that cannot say, which is Coolify always. */
  const [panelTeams, setPanelTeams] = React.useState<string[] | null>(null);
  /** The queued team waiting for a Deplo team of its own to be created. */
  const [pendingTeam, setPendingTeam] = React.useState<number | null>(null);
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

  /** A team change is in flight, plan and all - see `retargetTeam`. */
  const [retargeting, setRetargeting] = React.useState(false);
  /** The last team change whose re-read failed: the plan is another team's. */
  const [retargetError, setRetargetError] = React.useState<string | null>(null);
  /** Whether this tab has already decided which run to open on. */
  const restored = React.useRef(false);
  /**
   * The team this tab switched to, which LEADS the prop: the page's own read of it
   * lands a refresh later, and what a migration is for cannot briefly be the team
   * it just left. Dropped the moment the prop moves - by that refresh, or by
   * somebody switching team in the topbar, which this must never outlive.
   */
  const [landed, setLanded] = React.useState<{
    from: string;
    to: string;
  } | null>(null);
  // Adjusting state during the render, which is what React prescribes for state
  // that a prop invalidates - no effect, no second paint.
  if (landed && landed.from !== teamId) setLanded(null);
  const targetTeamId = landed?.to ?? teamId;

  const [invites, setInvites] = React.useState<Invite[] | null>(null);
  const [inviting, setInviting] = React.useState(false);
  const [inviteLink, setInviteLink] = React.useState<string | null>(null);
  const [minting, setMinting] = React.useState(false);

  /**
   * What the RUN and the invites are sent with. It carries what the SCAN found,
   * never what somebody pinned: walking back to Connect after scanning one panel
   * and typing another address would otherwise fix the wrong platform.
   */
  const connectInput = React.useMemo(
    () => ({
      url,
      // Whose turn it is, not what is in the field: the field is emptied the
      // moment a token joins the list, and the People step still needs the key
      // its team was read with.
      apiKey: queue[at]?.apiKey || apiKey,
      kind: plan?.platform ?? null,
    }),
    [url, apiKey, plan, queue, at],
  );

  /** How many teams of this panel are still behind the one on screen. */
  const teamsLeft = teamsAfter(queue, at);
  /** The panel's teams no token here covers yet. Empty on a panel that will not
   *  name them, where the wizard asks instead. */
  const uncovered = uncoveredTeams(panelTeams, queue);

  /** What is known about the panel so far: what answered, or what was pinned. */
  const kind: SourceKind | null = plan?.platform ?? forcedKind;

  /**
   * The fleet moves under the plan whenever the team does, so what was picked is
   * READ through the servers this team has rather than stored back - a host that
   * comes home then gives its services their own machine again.
   */
  const landing = React.useMemo(
    () => reconcilePlacements(placements, serverMap, servers, buildServers),
    [placements, serverMap, servers, buildServers],
  );

  const STEPS = React.useMemo(
    () => stepsFor(isInstanceAdmin, takeoverStep != null),
    [isInstanceAdmin, takeoverStep],
  );

  /* ---- step 1: connect --------------------------------------------- */

  /** Read the panel with ONE team's key. Every scan goes through here: the form's,
   *  the queue's next team, and the re-read a change of target team needs. */
  async function scanWith(key: string): Promise<Plan | null> {
    setScanning(true);
    setScanError(null);
    const res = await gqlAction<{ scanMigrationSource: Plan }, Plan>(
      SCAN,
      {
        input: { url, apiKey: key, kind: forcedKind },
      },
      (d) => d.scanMigrationSource,
    );
    setScanning(false);
    if (!res.ok) {
      // Kept on screen rather than toasted: for an API that is switched off, an
      // IP allowlist or a token short of a permission, the fix is minutes away in
      // another tab, and a toast is gone before anyone gets back.
      setScanError(res.error);
      return null;
    }
    if (!res.data) return null;
    const scanned = res.data;
    setPlan(scanned);
    if (scanned.otherTeams) setPanelTeams(scanned.otherTeams);
    setChosen(defaultChoice(scanned));
    const defaults = landingDefaults(scanned, servers);
    setPlacements(defaults.placements);
    setServerMap(defaults.servers);
    // Straight on to Install, which is where "can Deplo reach every machine
    // behind this" gets answered - and which ends itself either way, so nobody
    // whose machines are already ours has a screen to click through.
    setStep("install");
    return scanned;
  }

  /**
   * The one button at the bottom of Connect, which does the one thing left to do:
   * add the token that is typed, or start on the list once there is one.
   */
  async function submitConnect(e: React.FormEvent) {
    e.preventDefault();
    if (apiKey.trim() && queue.length > 0) return identifyAndAdd();
    if (queue.length > 0) return goToTeam(0);
    // One team and one token is the common case, and it stays one click: the key
    // in the field IS the list then, named by what the scan read.
    const key = apiKey;
    const scanned = await scanWith(key);
    if (scanned)
      setQueue([
        {
          apiKey: key,
          sourceTeamId: null,
          name: scanned.orgName ?? "",
          status: "waiting",
        },
      ]);
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
    const next = addTeam(queue, res.data, apiKey);
    if (next.error !== null) {
      setScanError(next.error);
      return;
    }
    setQueue(next.queue);
    if (res.data.otherTeams) setPanelTeams(res.data.otherTeams);
    // Out of the field the moment it is on the list: what holds it now is the
    // team it belongs to.
    setApiKey("");
  }

  /**
   * Land somewhere else. The import runs as this person in whatever team is active,
   * so the target IS the active team - and the plan is read again under it: "already
   * here" and the domain notes are answers about a team, the ticks are not.
   */
  const retargetTeam = React.useCallback(
    async (nextTeamId: string, withKey?: string): Promise<string | null> => {
      const from = targetTeamId;
      setRetargeting(true);
      setRetargetError(null);
      // This tab has already chosen its screen. Without this, landing in a team
      // that has a report nobody closed would swap the plan for that old run.
      restored.current = true;
      // Idempotent when the team is already active: creating one switches into
      // it, and picking the current team is how a failed re-read is retried.
      const switched = await gqlAction(SWITCH_TEAM, { teamId: nextTeamId });
      if (!switched.ok) {
        setRetargeting(false);
        setRetargetError(switched.error);
        return switched.error;
      }
      setLanded({ from, to: nextTeamId });
      if (from !== nextTeamId) {
        // The machines Deplo installed to read the panel are granted to ONE team,
        // and every lookup that reads one is team-scoped: left behind, the run
        // refuses to start and their agents are stranded.
        const moved = await gqlAction(HAND_OVER_SOURCES, { fromTeamId: from });
        if (!moved.ok) {
          setRetargeting(false);
          setRetargetError(moved.error);
          return moved.error;
        }
      }
      router.refresh();
      const again = await gqlAction<{ scanMigrationSource: Plan }, Plan>(
        SCAN,
        // A team of the queue arrives with its own key: the state that would hold
        // it is set in the same tick as this call, so it is passed, not read.
        { input: { ...connectInput, apiKey: withKey || connectInput.apiKey } },
        (d) => d.scanMigrationSource,
      );
      setRetargeting(false);
      if (!again.ok) {
        // Kept on the card, not toasted: the plan on screen now answers about the
        // team it was read in, and a toast is gone before that matters.
        setRetargetError(again.error);
        return again.error;
      }
      if (!again.data) return "Deplo could not read the panel again.";
      setPlan(again.data);
      // Nothing ticked means this plan is NEW to the wizard - the next team of the
      // queue arriving, not a re-read of the one on screen - so it gets the same
      // default a first scan gives.
      const fresh = again.data;
      setChosen((prev) => (prev.size > 0 ? prev : defaultChoice(fresh)));
      const defaults = landingDefaults(again.data, servers);
      // What was already chosen wins: a service the source has grown since the
      // first scan gets a default, nobody's review gets thrown away.
      setPlacements((prev) => ({ ...defaults.placements, ...prev }));
      setServerMap((prev) => ({ ...defaults.servers, ...prev }));
      return null;
    },
    [connectInput, router, servers, targetTeamId],
  );

  /* ---- the move itself ---------------------------------------------- */

  /**
   * Hand the whole thing to the control plane and stop being the driver.
   */
  async function runImport() {
    if (!plan || running) return;
    const targets = plan.projects.flatMap((p) =>
      importableOf(p)
        .filter((svc) => chosen.has(svc.sourceId))
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
        input: connectInput,
        orgName: plan.orgName,
        targets,
        servers: Object.entries(landing.servers)
          .filter(([, to]) => to)
          .map(([from, to]) => ({ from, to })),
        // Another team of this panel is queued behind this run, so it must leave
        // Deplo's agents on the source machines: the next one reads the same
        // disks. It also holds the takeover until the list is done.
        keepSources: teamsLeft > 0,
      },
      (d) => d.startMigration,
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

  /**
   * Everything ONE team chose. Which teams are still to come is not one team's,
   * and neither is the panel they all belong to, so both stay.
   */
  const resetTeamState = React.useCallback(() => {
    setUndoing(false);
    setFailure(null);
    setPlan(null);
    setRunId(null);
    setAdoptedId(null);
    setChosen(new Set());
    setPlacements({});
    setServerMap({});
    setPendingMachines({});
    attemptedMachines.current = new Set();
    setApiKey("");
    setScanError(null);
    setRetargetError(null);
    setLogOpen(false);
    setInvites(null);
    setInviteLink(null);
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
    setQueue([]);
    setAt(0);
    setPanelTeams(null);
    setPendingTeam(null);
  }, []);

  /**
   * Begin one team of the list: point Deplo at the team of its own it lands in,
   * then read the panel with its key.
   */
  async function startTeam(i: number, teamHere?: string) {
    const team = queue[i];
    if (!team) return;
    setAt(i);
    resetTeamState();
    if (!teamHere || teamHere === targetTeamId) {
      await scanWith(team.apiKey);
      return;
    }
    // Said out loud here: the card that carries this error is a step away from
    // where the list left the operator standing.
    const failed = await retargetTeam(teamHere, team.apiKey);
    if (failed) return toast.error(failed);
    setStep("install");
  }

  /**
   * Where one team of the list lands: the Deplo team already named after it, or
   * one created for it, because that is the separation they had over there. With
   * a single team nothing moves - a lone migration lands where it always did.
   */
  function homeFor(team: QueuedTeam): string | undefined {
    if (queue.length < 2 || !team.name) return undefined;
    return targetTeams.find((t) => sameTeamName(t.name, team.name))?.id;
  }

  /** Team `i`, wherever it belongs - creating that team first when there is none. */
  async function goToTeam(i: number) {
    const team = queue[i];
    if (!team) return;
    const home = homeFor(team);
    // No team of that name here yet: the dialog carries it, and creating it is
    // the click that says yes. `at` only moves once there is somewhere to land.
    if (!home && queue.length > 1 && team.name) {
      setPendingTeam(i);
      return;
    }
    await startTeam(i, home);
  }

  /** On to the next team of the panel. */
  async function nextTeam() {
    const i = at + 1;
    if (!queue[i]) return;
    await closeReport();
    // The key dies with its turn.
    setQueue((q) => q.map((e, j) => (j === at ? { ...e, apiKey: "" } : e)));
    await goToTeam(i);
  }

  /**
   * Stop, which means undo.
   */
  async function stopRun(id: string) {
    if (!id) return;
    setUndoing(true);
    setAdoptedId(id);
    setRunId(id);
    const res = await gqlAction(STOP, { runId: id });
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
  /** Read by `settleFinished`, which must not change identity every time the
   *  plan does - it is the dependency of an effect that watches the live feed. */
  const hasPlan = plan != null;
  const settleFinished = React.useCallback(
    async (id: string) => {
      const res = await gqlAction<
        {
          migrationRun: { status: string; error: string | null } | null;
        },
        { status: string; error: string | null } | null
      >(RUN_LOG, { id }, (d) => d.migrationRun);
      if (!res.ok || !res.data) return;
      // Still moving: the live feed owns the screen. Only the arrival path gets
      // here - the edge below fires when the feed has already gone quiet.
      if (res.data.status === "running") return;
      // Whatever the page was rendered with is stale from here on.
      setSnapshot(null);
      // The list says how each team went, so a report closed hours later still
      // reads as "two over, one to go".
      const outcome = res.data.status === "done" ? "done" : "failed";
      setQueue((q) =>
        q.map((e, i) => (i === at ? { ...e, status: outcome } : e)),
      );
      if (res.data.status === "done") {
        // Inviting the source's members needs the member list, which came with
        // the plan and cannot be read back once the run has handed the API key
        // over. Arriving after the fact therefore goes straight to the report.
        setStep(isInstanceAdmin && hasPlan ? "people" : "done");
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
    [isInstanceAdmin, hasPlan, resetToStart, at],
  );

  /**
   * Leaving the report for good. Until this lands, the page opens on this run
   * every time - which is the whole point on the way IN, and would be a wizard
   * that cannot be started again on the way out.
   */
  async function closeReport() {
    const id = adoptedId ?? runId;
    if (id) await gqlAction(DISMISS, { runId: id });
  }

  /* ---- step: people ------------------------------------------------ */

  async function inviteMembers() {
    if (!runId) return;
    setInviting(true);
    const res = await gqlAction<{ importMigrationMembers: Invite[] }, Invite[]>(
      IMPORT_MEMBERS,
      { input: connectInput, runId },
      (d) => d.importMigrationMembers,
    );
    setInviting(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setInvites(res.data ?? []);
    router.refresh();
  }

  async function mintInviteLink() {
    setMinting(true);
    const res = await gqlAction<{ mintRegistrationLink: string }, string>(
      MINT_LINK,
      {
        input: {
          mode: "existing_teams",
          teamAssignments: [{ teamId: targetTeamId, role: "member" }],
        },
      },
      (d) => d.mintRegistrationLink,
    );
    setMinting(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setInviteLink(res.data ?? null);
    router.refresh();
  }

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

  /* ---- render ------------------------------------------------------ */

  /**
   * The panel, not the tree: the review step is showing a run rather than a plan.
   */
  const moving = step === "review" && (running || failure !== null);

  /**
   * Every machine behind that Dokploy answers Deplo - the same condition the
   * install step ends on, hoisted here because the step rail needs it too.
   */
  const machinesReady = React.useMemo(
    () => (plan?.servers ?? []).every((m) => m.deploServerOnline),
    [plan],
  );

  /**
   * Nothing here holds the page any more, and that is the point: the run is the
   * control plane's, and every screen this wizard shows is restored from it (see
   * `resumable`).
   */
  /**
   * The team's run in flight, whoever started it.
   */
  const watched = useActiveMigration();

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
  const inFlight = running || takenOver;

  // Armed from the moment there is something to lose. Not after Finish either - by
  // then the migration is over and every link on the report is somewhere you are
  // meant to go.
  const guarded =
    step !== "done" &&
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
      void fetch("/api/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
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
        description="Deplo takes its agent back off the machines it installed one on, and forgets them. Coming back means connecting and setting those machines up again."
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
          teamNo={at + 1}
          teamCount={queue.length}
          nextName={teamsLeft > 0 ? (queue[at + 1]?.name ?? "") : null}
          onNext={() => void nextTeam()}
          uncovered={uncovered}
          onAddTeam={() => setStep("connect")}
          onShowLog={() => setLogOpen(true)}
          onAgain={() => {
            void closeReport().then(() => {
              forgetQueue();
              resetToStart();
            });
          }}
          finishLabel={takeoverStep ? "Take over the machine" : "Finish"}
          onFinish={() => {
            void closeReport();
            if (takeoverStep) return setStep("takeover");
            router.push("/");
          }}
          isInstanceAdmin={isInstanceAdmin}
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
                reachable={(s) => {
                  // The rail is inside the panel, so the lock cannot switch it off - it says so
                  // itself instead: while a migration owns the screen, driven here or watched from
                  // here, the only step there is is the one it is on.
                  if (moving || takenOver) return s === "review";
                  if (s === "connect") return true;
                  if (s === "install") return plan != null;
                  // Review is where the copy is started, and a copy needs an agent that ANSWERS on
                  // every machine. A gate the chrome around it does not honour is a suggestion.
                  if (s === "review") return plan != null && machinesReady;
                  // Always open, and it is the card that says what is still
                  // missing ("bring at least one project over first"): a rail
                  // entry nobody can reach is how the old fixed panel earned
                  // its place on the screen.
                  if (s === "takeover") return true;
                  // People and the report are what the migration produces:
                  // neither is anywhere until there is a run.
                  return (adoptedId ?? runId) != null;
                }}
                onSelect={(s) => {
                  // Nothing moves while the loop is mid-flight, or while a
                  // stopped run is still waiting to be undone or kept.
                  if (moving || takenOver) return;
                  setStep(s);
                }}
              />
            </div>

            <div>
              {/* One panel, one run, whoever is looking: the person who started
                  it, the same person after a reload, the teammate who walked in
                  on it. The step they left is the step they get, Stop and all. */}
              {resumed && (
                <MovingPanel
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
                  uncovered={uncovered}
                  adding={adding}
                  onAdd={() => void identifyAndAdd()}
                  onRemove={(i) => setQueue((q) => q.filter((_, j) => j !== i))}
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

              {!takenOver &&
                step === "review" &&
                plan &&
                (moving ? (
                  <MovingPanel
                    kind={kind}
                    progress={NO_PROGRESS}
                    startedAt={null}
                    // The start call is in flight in THIS tab: there is no run
                    // yet, so there is no heartbeat to be missing.
                    heartbeatAt={new Date().toISOString()}
                    failure={failure}
                    running={running}
                    undoing={false}
                    onShowLog={() => setLogOpen(true)}
                    // No Stop: this is the second the `startMigration` call
                    // is in flight, and there is no run id to stop yet.
                    onBack={() => setFailure(null)}
                  />
                ) : (
                  <ReviewStep
                    kind={kind}
                    plan={plan}
                    teamId={targetTeamId}
                    teamName={teamName}
                    teamAvatarUrl={teamAvatarUrl}
                    targetTeams={targetTeams}
                    retargeting={retargeting}
                    retargetError={retargetError}
                    onRetarget={(id) => void retargetTeam(id)}
                    chosen={chosen}
                    setChosen={setChosen}
                    servers={servers}
                    buildServers={buildServers}
                    placements={landing.placements}
                    setPlacements={setPlacements}
                    canExposePorts={canExposePorts}
                    isInstanceAdmin={isInstanceAdmin}
                    onBack={() => setStep("install")}
                    onStart={() => void runImport()}
                  />
                ))}

              {!takenOver && step === "people" && (
                <PeopleStep
                  kind={kind}
                  people={(plan?.members ?? []).filter((m) => !m.inTeam)}
                  invites={invites}
                  inviting={inviting}
                  onInvite={inviteMembers}
                  canInvitePeople={runId != null}
                  inviteLink={inviteLink}
                  minting={minting}
                  onMintLink={() => void mintInviteLink()}
                  onContinue={() => setStep("done")}
                />
              )}

              {!takenOver &&
                step === "takeover" &&
                // Taking the ports stops that panel for good, so a team still on
                // the list comes first. The server refuses it too - this is the
                // half that says WHICH team is missing.
                (teamsLeft > 0 ? (
                  <TeamsLeftCard
                    kind={kind}
                    teams={queue.slice(at + 1).map((q) => q.name)}
                    onNext={() => void nextTeam()}
                  />
                ) : (
                  takeoverStep
                ))}
            </div>
          </div>
        </div>
      )}

      {/**
       * The team the next one of the list lands in, when this Deplo has none by
       * that name. Mounted here rather than in the Review, which is a step past
       * where the queue needs the answer.
       */}
      {pendingTeam != null && (
        <CreateTeamDialog
          open
          redirect={false}
          defaultName={queue[pendingTeam]?.name}
          onOpenChange={(o) => {
            if (!o) setPendingTeam(null);
          }}
          onCreated={(id) => {
            const i = pendingTeam;
            setPendingTeam(null);
            void startTeam(i, id);
          }}
        />
      )}

      {/**
       * Line by line, while it happens.
       */}
      <MigrationConsole
        runId={adoptedId ?? runId ?? feed?.id ?? null}
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
  uncovered,
  adding,
  onAdd,
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
  /** The panel's teams no token here covers, when the panel will name them. */
  uncovered: string[];
  adding: boolean;
  onAdd: () => void;
  onRemove: (i: number) => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const copy = copyFor(kind);
  const busy = scanning || adding;
  /**
   * One button, and it does the one thing left to do: add what is typed, or set
   * off down the list. A first token is both at once, which is what keeps the
   * single-team migration at the one click it has always been.
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
                  className="flex items-center gap-2 px-3 py-2 text-sm"
                >
                  <Users className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">
                    {q.name || `An unnamed ${copy.teamLabel}`}
                  </span>
                  {q.status === "done" && <Badge variant="success">Over</Badge>}
                  {q.status === "failed" && (
                    <Badge variant="destructive">Failed</Badge>
                  )}
                  {q.status === "waiting" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${q.name}`}
                      onClick={() => onRemove(i)}
                    >
                      <X className="size-4" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-sm text-muted-foreground">
              {uncovered.length > 0
                ? `Not covered yet: ${uncovered.join(", ")}. Each needs its own ${copy.tokenLabel.toLowerCase()}.`
                : `A ${copy.tokenLabel.toLowerCase()} reads one ${copy.teamLabel}. Add one per ${copy.teamLabel}.`}
            </p>
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
            <div>
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
            ? "Deplo is doing this on the server. Close the page if you like - the chip in the header brings you back."
            : "No control plane has picked this migration up yet, so nothing is moving. One takes it over on its next pass, within a minute or two. Stop it if you would rather start again."
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
              ? "Nothing is driving it yet"
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
                Deplo removes every app, database and project this migration
                created here, with their data, and takes its agent back off the
                machines it was reading. There is no half-migrated state to
                keep: a copy interrupted part-way through leaves data nobody can
                trust.
                <br />
                <br />
                It does not start {panelName} back up - the services this
                migration stopped over there stay stopped.
              </>
            }
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
/* Step - done                                                        */
/* ------------------------------------------------------------------ */

/**
 * The end, and the one step that breaks the two-column layout. Everywhere else the
 * illustration sits beside the thing you are doing, because there is a thing you
 * are doing.
 */
function DoneStep({
  kind,
  teamNo,
  teamCount,
  nextName,
  onNext,
  uncovered,
  onAddTeam,
  onShowLog,
  onAgain,
  finishLabel,
  onFinish,
  isInstanceAdmin,
}: {
  /** Which panel this came from, for the drawing's label. */
  kind: SourceKind | null;
  /** Which team of the list this was, and how many there are. */
  teamNo: number;
  teamCount: number;
  /** The next team of the list, or null when this was the last one. */
  nextName: string | null;
  onNext: () => void;
  /** Teams of the panel no token covers - only ever named on a panel that lists
   *  them, which is Dokploy alone. */
  uncovered: string[];
  onAddTeam: () => void;
  /** The wizard's own console - the same one the panel opened while it ran. */
  onShowLog: () => void;
  /** Close the report and hand back an empty wizard, without leaving the page. */
  onAgain: () => void;
  /** On a takeover the way on is the last step, not the dashboard. */
  finishLabel: string;
  onFinish: () => void;
  /** Uninstalling an agent is instance-admin, like every server action. */
  isInstanceAdmin: boolean;
}) {
  // Not the end of anything while a team is still waiting: no confetti, and no
  // offer to take the agents off machines the next team is about to read.
  const more = nextName != null;
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-6 text-center">
      {/**
       * Over the WINDOW, not over the drawing. A burst thrown from the middle of the
       * screen is still a burst thrown from the middle of the screen - which is where the
       * illustration is, so that is what it looks like it came out of.
       */}
      {!more && <ConfettiBurst rain className="z-50" count={60} />}

      <MigrationGraphic state="done" kind={kind} className="h-48 w-auto" />

      <div>
        <h2 className="text-xl font-semibold">
          {more
            ? `Team ${teamNo} of ${teamCount} is on Deplo`
            : "You're on Deplo"}
        </h2>
        <p className="mt-1 text-sm text-balance text-muted-foreground">
          {more
            ? `${nextName} is next, and it lands in a team of its own. Nothing is deployed yet.`
            : "Nothing is deployed yet. Open an app, check it over, and press Deploy when you want the traffic."}
        </p>
      </div>

      {/* Only a panel that lists its teams gets here - the operator is one key
          short of a team they have not thought about. */}
      {!more && uncovered.length > 0 && (
        <div className="flex w-full items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-left text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <p className="min-w-0 flex-1 text-muted-foreground">
            Still on that panel: {uncovered.join(", ")}.
          </p>
          <Button variant="secondary" size="sm" onClick={onAddTeam}>
            Bring it over
          </Button>
        </div>
      )}

      {/**
       * The two ends of the row, the way every footer in the app reads: what you might
       * want to look at first on the left, the way out on the right.
       */}
      <div className="flex w-full flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={onShowLog}>
            <ScrollText className="size-4" />
            Show log
          </Button>
          {/* Another PANEL, which throws the list away - so not while it still
              has teams on it. */}
          {!more && (
            <Button variant="outline" onClick={onAgain}>
              <Repeat className="size-4" />
              Migrate another
            </Button>
          )}
        </div>
        <Button onClick={more ? onNext : onFinish}>
          {more ? `Bring ${nextName} over` : finishLabel}
        </Button>
      </div>

      {/* Only ever shown when an agent really is still out there: finishing the
          run uninstalls them, so this is the line for the one that would not go
          quietly. It brings its own card, so it sits outside the centred column.
          Never while a team is still queued - those agents are its way in. */}
      {isInstanceAdmin && !more && (
        <div className="w-full text-left">
          <RemoveMigrationSources />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step - take over, while the list is not done                       */
/* ------------------------------------------------------------------ */

/**
 * What the last step is until every team is over. The cutover stops that panel
 * and its API for good, and a token reads one team - so a team still on the list
 * would have nothing left to come from. The server refuses it too.
 */
function TeamsLeftCard({
  kind,
  teams,
  onNext,
}: {
  kind: SourceKind | null;
  /** The ones still to come, in order. */
  teams: string[];
  onNext: () => void;
}) {
  const copy = copyFor(kind);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TriangleAlert className="size-4 text-warning" />
          {teams.length === 1
            ? "One team is still to come"
            : `${teams.length} teams are still to come`}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Taking the ports stops {copy.name} for good, and its API with it.
          Bring {teams.join(", ")} over first.
        </p>
      </CardHeader>
      <CardFooter className="justify-end border-t border-border pt-6">
        <Button onClick={onNext}>Bring {teams[0]} over</Button>
      </CardFooter>
    </Card>
  );
}
