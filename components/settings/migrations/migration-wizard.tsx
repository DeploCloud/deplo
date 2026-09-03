"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  CircleStop,
  Loader2,
  Repeat,
  ScrollText,
  Server as ServerIcon,
  TriangleAlert,
} from "lucide-react";

import { gqlAction } from "@/lib/graphql-client";
import { docsUrl } from "@/lib/docs";
import { formatBuildDuration } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { KindCard } from "@/components/shared/kind-card";
import { FieldLabel } from "@/components/ui/info-tip";
import { ConfettiBurst } from "@/components/shared/confetti-burst";
import { ConfirmAction } from "@/components/shared/confirm-action";
import {
  WizardStepper,
  type WizardStep,
} from "@/components/shared/wizard-stepper";
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

type StepId = "connect" | "install" | "review" | "people" | "done";

const STEP_LABEL: Record<StepId, string> = {
  connect: "Connect",
  install: "Install",
  review: "Review",
  people: "People",
  done: "Done",
};

/**
 * The steps, and there is no longer a separate one for the data. `people` only for
 * an instance admin, because both of its actions are instance-admin gated and the
 * step would otherwise be a page of nothing.
 */
function stepsFor(canInvite: boolean): WizardStep<StepId>[] {
  const ids: StepId[] = [
    "connect",
    "install",
    "review",
    ...(canInvite ? (["people"] as StepId[]) : []),
    "done",
  ];
  return ids.map((id) => ({ id, label: STEP_LABEL[id] }));
}

/** Dokploy's own host has no server row over there; it is the empty id. */
const OWN_HOST = "";

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
  ) {
    startMigration(
      input: $input
      orgName: $orgName
      targets: $targets
      servers: $servers
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

const SCAN = /* GraphQL */ `
  mutation ScanMigrationSource($input: MigrationSourceInput!) {
    scanMigrationSource(input: $input) {
      platform
      sourceUrl
      orgName
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
   * An address handed over from the History tab. The nonce is what makes
   * picking the same run twice still land in the field.
   */
}) {
  const router = useRouter();

  const [step, setStep] = React.useState<StepId>("connect");
  const [url, setUrl] = React.useState(prefill?.url ?? "");
  const [apiKey, setApiKey] = React.useState("");
  const [scanning, setScanning] = React.useState(false);
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
      apiKey,
      kind: plan?.platform ?? null,
    }),
    [url, apiKey, plan],
  );

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
    () => stepsFor(isInstanceAdmin),
    [isInstanceAdmin],
  );

  /* ---- step 1: connect --------------------------------------------- */

  async function scan(e: React.FormEvent) {
    e.preventDefault();
    setScanning(true);
    setScanError(null);
    const res = await gqlAction<{ scanMigrationSource: Plan }, Plan>(
      SCAN,
      {
        input: { url, apiKey, kind: forcedKind },
      },
      (d) => d.scanMigrationSource,
    );
    setScanning(false);
    if (!res.ok) {
      // Kept on screen rather than toasted: for an API that is switched off, an
      // IP allowlist or a token short of a permission, the fix is minutes away in
      // another tab, and a toast is gone before anyone gets back.
      setScanError(res.error);
      return;
    }
    if (!res.data) return;
    const scanned = res.data;
    setPlan(scanned);
    // Everything Deplo can actually create is picked; anything already here is
    // not, since re-importing it would only produce a page of "already here" rows.
    setChosen(
      new Set(
        scanned.projects.flatMap((p) =>
          importableOf(p)
            .filter((s) => s.status !== "exists")
            .map((s) => s.sourceId),
        ),
      ),
    );
    const defaults = landingDefaults(scanned, servers);
    setPlacements(defaults.placements);
    setServerMap(defaults.servers);
    // Straight on to Install, which is where "can Deplo reach every machine
    // behind this" gets answered - and which ends itself either way, so nobody
    // whose machines are already ours has a screen to click through.
    setStep("install");
  }

  /**
   * Land somewhere else. The import runs as this person in whatever team is active,
   * so the target IS the active team - and the plan is read again under it: "already
   * here" and the domain notes are answers about a team, the ticks are not.
   */
  const retargetTeam = React.useCallback(
    async (nextTeamId: string) => {
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
        return;
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
          return;
        }
      }
      router.refresh();
      const again = await gqlAction<{ scanMigrationSource: Plan }, Plan>(
        SCAN,
        { input: connectInput },
        (d) => d.scanMigrationSource,
      );
      setRetargeting(false);
      if (!again.ok) {
        // Kept on the card, not toasted: the plan on screen now answers about the
        // team it was read in, and a toast is gone before that matters.
        setRetargetError(again.error);
        return;
      }
      if (!again.data) return;
      setPlan(again.data);
      const defaults = landingDefaults(again.data, servers);
      // What was already chosen wins: a service the source has grown since the
      // first scan gets a default, nobody's review gets thrown away.
      setPlacements((prev) => ({ ...defaults.placements, ...prev }));
      setServerMap((prev) => ({ ...defaults.servers, ...prev }));
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
   * Back to an empty wizard. The run is over and undone; nothing it made is
   * here, and nothing it chose should be either - a plan half-applied is the one
   * thing that must never be re-submitted by accident.
   */
  const resetToStart = React.useCallback(() => {
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
    setForcedKind(null);
    setScanError(null);
    setRetargetError(null);
    setLogOpen(false);
    setStep("connect");
    router.refresh();
  }, [router]);

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
    [isInstanceAdmin, hasPlan, resetToStart],
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
      : step === "done"
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
          onShowLog={() => setLogOpen(true)}
          onAgain={() => {
            void closeReport().then(resetToStart);
          }}
          onFinish={() => {
            void closeReport();
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
                  onSubmit={scan}
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
            </div>
          </div>
        </div>
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
  onSubmit: (e: React.FormEvent) => void;
}) {
  const copy = copyFor(kind);
  return (
    <StepShell
      title={copy.connectTitle}
      lead="Nothing is written on either side until you have seen what would come over."
    >
      <form className="grid gap-4" onSubmit={onSubmit}>
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
          <Input
            id="source-token"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Paste the key"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

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
            disabled={scanning || !url.trim() || !apiKey.trim()}
          >
            {scanning && <Loader2 className="size-4 animate-spin" />}
            {scanning ? copy.scanBusy : copy.scanIdle}
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
  onShowLog,
  onAgain,
  onFinish,
  isInstanceAdmin,
}: {
  /** Which panel this came from, for the drawing's label. */
  kind: SourceKind | null;
  /** The wizard's own console - the same one the panel opened while it ran. */
  onShowLog: () => void;
  /** Close the report and hand back an empty wizard, without leaving the page. */
  onAgain: () => void;
  onFinish: () => void;
  /** Uninstalling an agent is instance-admin, like every server action. */
  isInstanceAdmin: boolean;
}) {
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
        <h2 className="text-xl font-semibold">You&apos;re on Deplo</h2>
        <p className="mt-1 text-sm text-balance text-muted-foreground">
          Nothing is deployed yet. Open an app, check it over, and press Deploy
          when you want the traffic.
        </p>
      </div>

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
          <Button variant="outline" onClick={onAgain}>
            <Repeat className="size-4" />
            Migrate another
          </Button>
        </div>
        <Button onClick={onFinish}>Finish</Button>
      </div>

      {/* Only ever shown when an agent really is still out there: finishing the
          run uninstalls them, so this is the line for the one that would not go
          quietly. It brings its own card, so it sits outside the centred column. */}
      {isInstanceAdmin && (
        <div className="w-full text-left">
          <RemoveMigrationSources />
        </div>
      )}
    </div>
  );
}
