"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CircleStop,
  Loader2,
  ScrollText,
  Server as ServerIcon,
  Undo2,
} from "lucide-react";

import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { FieldLabel } from "@/components/ui/info-tip";
import { ConfettiBurst } from "@/components/shared/confetti-burst";
import { ConfirmAction } from "@/components/shared/confirm-action";
import type { ActionResult } from "@/lib/result";
import { WizardStepper, type WizardStep } from "@/components/shared/wizard-stepper";
import { UnsavedChangesGuard } from "@/components/apps/unsaved-changes-guard";
import { InstallStep, type PendingMachine } from "./install-step";
import { MigrationGraphic, type MigrationState } from "./migration-graphic";
import { MigrationReportDialog } from "./migration-report";
import { RemoveMigrationSources } from "./remove-sources";
import { ReviewStep } from "./review-step";
import { PeopleStep } from "./people-step";
import { StepShell } from "./step-shell";
import {
  MigrationLogDialog,
  type MigrationProgress,
} from "./migration-progress";
import {
  importableOf,
  type Invite,
  type Placement,
  type Plan,
  type ReportItem,
  type RevertResult,
  type ServerChoice,
} from "./types";

/**
 * Migrating a Dokploy over, as one screen.
 *
 * Find it, reach its machines, decide what comes, move it, hand out the invites.
 * Everything you act on down the left, one illustration large on the right whose
 * pose is the progress bar - the same shape as the MCP connect wizard, and for
 * the same reason: the drawing is the one element that never changes place while
 * the column beside it swaps between a form, a list, a tree and a report.
 *
 * The API key never leaves this component's state. It is sent with each call and
 * stored nowhere, which is why the migration is driven from here (one project
 * per request) instead of handed to a background job - and why leaving the page
 * mid-run cannot be allowed to be an accident.
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
 * The steps, and there is no longer a separate one for the data.
 *
 * The cutover used to be its own screen at the end, reachable months later. It
 * moved INTO the migration: `install` refuses to continue until Deplo has an
 * agent on every machine behind that Dokploy, which is what makes copying the
 * data possible at all - so by the time the projects move, it can always do it.
 *
 * `people` only for an instance admin, because both of its actions are
 * instance-admin gated and the step would otherwise be a page of nothing.
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

/* ------------------------------------------------------------------ */
/* GraphQL                                                            */
/* ------------------------------------------------------------------ */

const SCAN = /* GraphQL */ `
  mutation ScanDokploy($input: DokployConnectInput!) {
    scanDokploy(input: $input) {
      sourceUrl
      orgName
      servers {
        sourceId
        name
        ipAddress
        deploServerId
        deploServerName
      }
      members {
        email
        name
        sourceRole
        hasAccount
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
            notes
          }
        }
      }
    }
  }
`;

const BEGIN = /* GraphQL */ `
  mutation BeginDokployImport($url: String!, $orgName: String) {
    beginDokployImport(url: $url, orgName: $orgName)
  }
`;

const IMPORT_PROJECT = /* GraphQL */ `
  mutation ImportDokployProject(
    $input: DokployConnectInput!
    $runId: String!
    $projectId: String!
    $servers: [DokployServerChoiceInput!]
    $serviceIds: [String!]
    $placements: [DokployPlacementInput!]
  ) {
    importDokployProject(
      input: $input
      runId: $runId
      projectId: $projectId
      servers: $servers
      serviceIds: $serviceIds
      placements: $placements
    ) {
      projectName
      created
      skipped
      failed
      manual
      items {
        path
        sourceKind
        sourceName
        outcome
        targetKind
        targetId
        message
      }
    }
  }
`;

const PLAN_DATA = /* GraphQL */ `
  mutation PlanDokployData($input: DokployConnectInput!, $runId: String!) {
    planDokployDataMove(input: $input, runId: $runId) {
      path
      sourceKind
      sourceId
      sourceName
      sourceServerId
      targetKind
      targetName
      running
      volumes {
        sourceVolume
      }
      notes
    }
  }
`;

const MOVE_DATA = /* GraphQL */ `
  mutation MoveDokployData(
    $input: DokployConnectInput!
    $runId: String!
    $sourceKind: String!
    $sourceId: String!
  ) {
    moveDokployServiceData(
      input: $input
      runId: $runId
      sourceKind: $sourceKind
      sourceId: $sourceId
    ) {
      moved
      failed
      notes
    }
  }
`;

const REVERT = /* GraphQL */ `
  mutation RevertDokployImport($runId: String!) {
    revertDokployImport(runId: $runId) {
      apps
      databases
      environments
      projects
      failed
    }
  }
`;

const FINISH = /* GraphQL */ `
  mutation FinishDokployImport($runId: String!) {
    finishDokployImport(runId: $runId)
  }
`;

const IMPORT_MEMBERS = /* GraphQL */ `
  mutation ImportDokployMembers($input: DokployConnectInput!, $runId: String!) {
    importDokployMembers(input: $input, runId: $runId) {
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

/** What `planDokployDataMove` answers, trimmed to what the copy loop reads. */
interface DataService {
  path: string;
  sourceKind: string;
  sourceId: string;
  sourceName: string;
  volumes: { sourceVolume: string }[];
  /** Why a volume could not be paired, or why this host cannot be read at all.
   *  Shown, never swallowed: it is the line that says what will NOT come over. */
  notes: string[];
}

interface MoveResult {
  moved: number;
  failed: number;
  notes: string[];
}

/**
 * A copy's line in the same report the rest of the import writes to.
 *
 * The server records its own row against the run; this is the LIVE echo of it,
 * so the dialog shows the copy happening instead of going quiet for the minutes
 * a volume takes.
 */
function dataNote(message: string, outcome: string = "manual"): ReportItem {
  return {
    path: "Data",
    sourceKind: "volume",
    sourceName: "data",
    outcome,
    targetKind: null,
    targetId: null,
    message,
  };
}

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

export function MigrationWizard({
  teamId,
  teamName,
  servers,
  buildServers,
  isInstanceAdmin,
  canExposePorts,
  prefill,
}: {
  teamId: string;
  teamName: string;
  servers: ServerChoice[];
  buildServers: ServerChoice[];
  isInstanceAdmin: boolean;
  /** The publish-ports grant. Without it a database's port cannot come over at all. */
  canExposePorts: boolean;
  /**
   * An address handed over from the History tab. The nonce is what makes
   * picking the same run twice still land in the field.
   */
  prefill: { url: string; nonce: number } | null;
}) {
  const router = useRouter();

  const [step, setStep] = React.useState<StepId>("connect");
  const [url, setUrl] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const [sameMachine, setSameMachine] = React.useState(false);
  const [scanning, setScanning] = React.useState(false);
  const [plan, setPlan] = React.useState<Plan | null>(null);

  const [serverMap, setServerMap] = React.useState<Record<string, string>>({});
  /**
   * The machines Deplo has registered and is waiting to hear from, and which it
   * has already tried. They live HERE rather than in the install step because
   * that step unmounts whenever somebody clicks another chip on the rail, and a
   * registration that died with it came back as "already registered at that
   * address" the second time round.
   */
  const [pendingMachines, setPendingMachines] = React.useState<
    Record<string, PendingMachine>
  >({});
  const attemptedMachines = React.useRef(new Set<string>());
  /** Source SERVICE ids. The leaves are the selection; the tree derives the rest. */
  const [chosen, setChosen] = React.useState<Set<string>>(new Set());
  /** Source service id → where it lands. Filled for every importable service. */
  const [placements, setPlacements] = React.useState<Record<string, Placement>>({});

  const [progress, setProgress] = React.useState<MigrationProgress>({
    done: 0,
    total: 0,
    current: "",
  });
  const [items, setItems] = React.useState<ReportItem[]>([]);
  const [runId, setRunId] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);
  /**
   * Somebody pressed Stop. A ref, not state: the loop below reads it between
   * calls in a closure that was made before the click, and a state read there
   * would be the value it had when the run started.
   */
  const cancelled = React.useRef(false);
  const [stopped, setStopped] = React.useState(false);
  const [reverting, setReverting] = React.useState(false);
  const [logOpen, setLogOpen] = React.useState(false);

  const [invites, setInvites] = React.useState<Invite[] | null>(null);
  const [inviting, setInviting] = React.useState(false);
  const [inviteLink, setInviteLink] = React.useState<string | null>(null);
  const [minting, setMinting] = React.useState(false);

  // An address picked in History. Adjusted during RENDER rather than in an
  // effect - React's own answer for "a prop changed, derive some state from it"
  // - so the field is already filled on the first paint of the tab instead of
  // flashing empty. Keyed on the nonce so picking the same run twice still
  // writes, and never on mount: an empty form is what a fresh tab shows.
  const [prefilled, setPrefilled] = React.useState(prefill?.nonce ?? 0);
  if (prefill && prefill.nonce !== prefilled) {
    setPrefilled(prefill.nonce);
    setUrl(prefill.url);
  }

  const connectInput = React.useMemo(
    () => ({ url, apiKey, allowPrivate: sameMachine }),
    [url, apiKey, sameMachine],
  );

  const STEPS = React.useMemo(() => stepsFor(isInstanceAdmin), [isInstanceAdmin]);

  /* ---- step 1: connect --------------------------------------------- */

  async function scan(e: React.FormEvent) {
    e.preventDefault();
    setScanning(true);
    const res = await gqlAction<{ scanDokploy: Plan }, Plan>(
      SCAN,
      { input: connectInput },
      (d) => d.scanDokploy,
    );
    setScanning(false);
    if (!res.ok) {
      toast.error(res.error);
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
    // A service lands on the Deplo server that IS the Dokploy machine it runs on,
    // whenever the scan matched one by address - staying put is what somebody
    // moving twenty-five services means by "import", and re-picking the host on
    // twenty-five dropdowns is not a choice, it is a chore. Anything with no
    // match (a machine with no agent here) falls back to the host Deplo runs on,
    // the one host every install has.
    const home = (servers.find((s) => s.isDeploHost) ?? servers[0])?.id;
    const runnable = new Set(servers.map((s) => s.id));
    const byMachine = new Map(
      scanned.servers.map((m) => [
        m.sourceId,
        m.deploServerId && runnable.has(m.deploServerId) ? m.deploServerId : home,
      ]),
    );
    const landingFor = (sourceServerId: string) =>
      byMachine.get(sourceServerId) ?? home;
    if (home) {
      setPlacements(
        Object.fromEntries(
          scanned.projects.flatMap((p) =>
            importableOf(p).map((svc) => [
              svc.sourceId,
              { serverId: landingFor(svc.sourceServerId), buildServerId: null },
            ]),
          ),
        ),
      );
      // The same default for a service whose placement was never touched: which of
      // our servers its apps LAND on. It is only that - where the data is READ from
      // is derived server-side from the machine's address, never from this map.
      // Answering both questions with one field is what made every copy read the
      // Deplo host, find no volume there, and overwrite real data with nothing.
      setServerMap(
        Object.fromEntries([
          [OWN_HOST, landingFor(OWN_HOST)],
          ...scanned.servers.map((s) => [s.sourceId, landingFor(s.sourceId)]),
        ]),
      );
    }
    // Straight on to Install, which is where "can Deplo reach every machine
    // behind this" gets answered - and which ends itself either way, so nobody
    // whose machines are already ours has a screen to click through.
    setStep("install");
  }

  /* ---- the move itself ---------------------------------------------- */

  async function runImport() {
    // The guard that does not depend on the rendering being right: the review
    // is replaced by the moving panel while this runs, but a stray second call
    // would start a second run over the same projects.
    if (!plan || running) return;
    const targets = plan.projects
      .map((p) => ({
        project: p,
        serviceIds: importableOf(p)
          .filter((s) => chosen.has(s.sourceId))
          .map((s) => s.sourceId),
      }))
      .filter((t) => t.serviceIds.length > 0);
    if (targets.length === 0) return;

    setItems([]);
    setFailure(null);
    cancelled.current = false;
    setStopped(false);
    setProgress({ done: 0, total: targets.length, current: targets[0].project.name });
    setRunning(true);

    try {
      const begun = await gqlAction<{ beginDokployImport: string }, string>(
        BEGIN,
        { url, orgName: plan.orgName },
        (d) => d.beginDokployImport,
      );
      if (!begun.ok) {
        setFailure(begun.error);
        return;
      }
      if (!begun.data) {
        setFailure("Deplo could not open an import run.");
        return;
      }
      const openRunId = begun.data;
      setRunId(openRunId);

      const serverChoices = Object.entries(serverMap)
        .filter(([, to]) => to)
        .map(([from, to]) => ({ from, to }));

      for (const [i, target] of targets.entries()) {
        // Between projects, never mid-request: a call already sent is finishing
        // on the server whatever this tab does, and abandoning its answer would
        // leave a project created here with no line in the report - the one
        // thing a revert reads to know what to take back out.
        if (cancelled.current) return;
        setProgress({ done: i, total: targets.length, current: target.project.name });
        const res = await gqlAction<
          { importDokployProject: { items: ReportItem[] } },
          { items: ReportItem[] }
        >(
          IMPORT_PROJECT,
          {
            input: connectInput,
            runId: openRunId,
            projectId: target.project.sourceId,
            servers: serverChoices,
            serviceIds: target.serviceIds,
            placements: target.serviceIds
              .filter((id) => placements[id])
              .map((id) => ({ serviceId: id, ...placements[id] })),
          },
          (d) => d.importDokployProject,
        );
        // One project failing does not abandon the others, and above all does not
        // skip the DATA phase: the projects that did land are already created here
        // and stopped over there, and leaving them without their data is the worse
        // half-finished state.
        if (!res.ok) {
          setItems((prev) => [
            ...prev,
            {
              path: target.project.name,
              sourceKind: "project",
              sourceName: target.project.name,
              outcome: "failed",
              targetKind: null,
              targetId: null,
              message: res.error,
            },
          ]);
          continue;
        }
        setItems((prev) => [...prev, ...(res.data?.items ?? [])]);
      }

      // ---- the data ------------------------------------------------
      // The configuration is here; now the bytes. Read both sides once, then
      // copy every service that actually has a volume - the ones with none (a
      // git-built app, usually) have nothing to do here.
      if (cancelled.current) return;
      setProgress({ done: targets.length, total: targets.length, current: "Reading the volumes" });
      const dataPlan = await gqlAction<{ planDokployDataMove: DataService[] }, DataService[]>(
        PLAN_DATA,
        { input: connectInput, runId: openRunId },
        (d) => d.planDokployDataMove,
      );
      if (!dataPlan.ok)
        setItems((prev) => [
          ...prev,
          dataNote("Could not read what data is on Dokploy: " + dataPlan.error, "failed"),
        ]);
      const planned = dataPlan.ok ? (dataPlan.data ?? []) : [];
      // Every reason a service will not have its data copied is SAID. These notes
      // are the whole value of the report - "no volume of this app mounts that
      // path", "Deplo has no agent on that machine" - and they used to be fetched
      // and dropped on the floor, which is how a migration reads as complete while
      // leaving data behind.
      for (const d of planned)
        for (const note of d.notes)
          setItems((prev) => [...prev, dataNote(`${d.sourceName}: ${note}`)]);
      const movable = planned.filter((d) => d.volumes.length > 0);

      for (const [i, d] of movable.entries()) {
        if (cancelled.current) return;
        setProgress({ done: i, total: movable.length, current: `Copying ${d.sourceName}` });
        const res = await gqlAction<{ moveDokployServiceData: MoveResult }, MoveResult>(
          MOVE_DATA,
          {
            input: connectInput,
            runId: openRunId,
            sourceKind: d.sourceKind,
            sourceId: d.sourceId,
          },
          (d2) => d2.moveDokployServiceData,
        );
        // One failed copy never stops the rest: the others are already stopped on
        // Dokploy, and leaving them half-moved is worse than finishing the list.
        setItems((prev) => [
          ...prev,
          res.ok
            ? dataNote(
                `${d.sourceName}: ${res.data?.moved ?? 0} volume(s) copied` +
                  ((res.data?.failed ?? 0) > 0 ? `, ${res.data!.failed} failed` : ""),
                (res.data?.failed ?? 0) > 0 ? "failed" : "created",
              )
            : dataNote(`${d.sourceName}: ${res.error}`, "failed"),
        ]);
      }

      setProgress({ done: movable.length, total: movable.length, current: "" });
      await gqlAction(FINISH, { runId: openRunId });
      router.refresh();
    } finally {
      setRunning(false);
      // Every early return above lands here: a failure, or a Stop. Either way
      // the wizard stays on this panel, which is where the way out of a
      // half-finished migration is.
      if (cancelled.current) {
        setStopped(true);
        router.refresh();
      }
    }

    // Only the happy path gets here.
    setLogOpen(false);
    setStep(isInstanceAdmin ? "people" : "done");
  }

  /**
   * Take the half-finished migration back out.
   *
   * The whole point is that it is not the person's job to work out what landed:
   * the run wrote a line for every object it created, and the server walks that
   * ledger backwards. What it cannot remove - a database whose host will not
   * confirm the volume is gone, a kind this actor may not delete - comes back
   * named, rather than as a silent partial success.
   */
  async function revertRun() {
    if (!runId) return { ok: false as const, error: "There is no run to undo." };
    setReverting(true);
    const res = await gqlAction<{ revertDokployImport: RevertResult }, RevertResult>(
      REVERT,
      { runId },
      (d) => d.revertDokployImport,
    );
    setReverting(false);
    if (!res.ok) {
      toast.error(res.error);
      return res;
    }
    const r = res.data;
    const removed =
      (r?.apps ?? 0) + (r?.databases ?? 0) + (r?.projects ?? 0) + (r?.environments ?? 0);
    if (r && r.failed.length > 0)
      // Not a toast: a list of what is STILL here is the thing to read, and a
      // toast expires in four seconds. It lands in the log instead.
      setItems((prev) => [
        ...prev,
        ...r.failed.map((f) => dataNote(f, "failed")),
      ]);
    toast.success(
      removed === 0 ? "Nothing was left to remove" : `Removed ${removed} object(s)`,
    );
    setStopped(false);
    setFailure(null);
    setPlan(null);
    setRunId(null);
    setItems([]);
    setProgress({ done: 0, total: 0, current: "" });
    setChosen(new Set());
    setPlacements({});
    setServerMap({});
    setPendingMachines({});
    attemptedMachines.current = new Set();
    setApiKey("");
    setStep("connect");
    router.refresh();
    return res;
  }

  /** Keep what landed and read the report on it. */
  function keepPartial() {
    setStopped(false);
    setLogOpen(false);
    setStep(isInstanceAdmin ? "people" : "done");
  }

  /* ---- step: people ------------------------------------------------ */

  async function inviteMembers() {
    if (!runId) return;
    setInviting(true);
    const res = await gqlAction<{ importDokployMembers: Invite[] }, Invite[]>(
      IMPORT_MEMBERS,
      { input: connectInput, runId },
      (d) => d.importDokployMembers,
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
      { input: { mode: "existing_teams", teamAssignments: [{ teamId, role: "member" }] } },
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
   *
   * `useCallback`, like `goToReview` below, because the install step hangs an
   * interval and a timeout off these: a new identity every render would reset
   * the poll and, worse, restart the two-second settle that ends the step.
   */
  const machineResolved = React.useCallback(
    (sourceId: string, serverId: string, serverName: string) => {
      setPlan((prev) =>
        prev
          ? {
              ...prev,
              servers: prev.servers.map((m) =>
                m.sourceId === sourceId
                  ? { ...m, deploServerId: serverId, deploServerName: serverName }
                  : m,
              ),
            }
          : prev,
      );
      // A machine that just became one of ours is also the obvious place for
      // its own services to land, so it becomes their default placement.
      setServerMap((prev) => ({ ...prev, [sourceId]: serverId }));
    },
    [],
  );

  const goToReview = React.useCallback(() => setStep("review"), []);

  /* ---- render ------------------------------------------------------ */

  // One derived value drives the picture. `running` wins over the step, because
  // the cable full of packets is the truest thing on the screen at that moment.
  const pose: MigrationState = running
    ? "moving"
    : step === "done"
      ? "done"
      : step === "review"
        ? "review"
        : step === "install"
          ? "install"
          : "connect";

  // Armed from the moment there is something to lose. Not from mount: a page
  // somebody opened to look at should not argue with them on the way out. Not
  // after Finish either - by then the migration is over and every link on the
  // report is somewhere you are meant to go.
  const guarded =
    step !== "done" && (plan != null || url.trim() !== "" || apiKey.trim() !== "");

  /** The one step that stacks instead of splitting into two columns. */
  const firstRun = step === "connect";

  return (
    <>
      {/* Both vectors, and `running` is the one that matters: half a migration
          is projects already stopped on Dokploy and not yet created here. */}
      <UnsavedChangesGuard
        when={guarded}
        title={running ? "The migration is still running" : "Leave the migration?"}
        description={
          running
            ? "Deplo is moving your projects right now. Leaving this page stops it part-way, with some services already stopped on Dokploy."
            : "Nothing here is saved yet. If you leave now you have to connect and choose all over again."
        }
        confirmLabel="Leave anyway"
        cancelLabel="Stay on this page"
      />

      {/* Every step stacks: the drawing large and centred on top, the rail and
          the content under it. It used to split into two columns from 1440px,
          and that was a worse deal than it looked - the sidebar takes ~240px off
          every viewport before this container sees it, so the content column
          came out at 592px whatever the screen, which is narrower than the
          review tree needs and narrower than the first screen wanted. One
          column, centred, and the width is the step's own: a form you read in
          one line, a tree you read across.

          The Done step opts out entirely - see `DoneStep`. */}
      {step === "done" ? (
        <DoneStep
          items={items}
          onFinish={() => router.push("/")}
          isInstanceAdmin={isInstanceAdmin}
        />
      ) : (
        <div className="mx-auto flex w-full flex-col items-center gap-8">
          <MigrationGraphic state={pose} className="h-auto w-full max-w-md" />

          <div
            className={cn(
              "w-full min-w-0 space-y-6",
              // Two fields and a switch want a narrow measure; a tree of apps
              // with a server picker on every row needs 40rem before it starts
              // hiding a column.
              firstRun ? "max-w-xl" : "max-w-3xl",
            )}
          >
            {/* Centred, because the column under it is centred: a rail hugging
                the left edge of a narrow centred column reads as misaligned
                with the heading below it, not as an anchor. */}
            <div className="flex justify-center">
              <WizardStepper
                steps={STEPS}
                current={step}
                reachable={(s) => {
                  if (s === "connect") return true;
                  if (s === "install" || s === "review") return plan != null;
                  // People and the report are what the migration produces: an
                  // empty one is worse than a chip that does not respond.
                  return items.length > 0;
                }}
                onSelect={(s) => {
                  // Nothing moves while the loop is mid-flight.
                  if (running) return;
                  setStep(s);
                }}
              />
            </div>

            <div>
              {step === "connect" && (
                <ConnectStep
                  url={url}
                  setUrl={setUrl}
                  apiKey={apiKey}
                  setApiKey={setApiKey}
                  sameMachine={sameMachine}
                  setSameMachine={setSameMachine}
                  canUsePrivate={isInstanceAdmin}
                  scanning={scanning}
                  onSubmit={scan}
                />
              )}

              {step === "install" && plan && (
                <InstallStep
                  machines={plan.servers}
                  canAddServers={isInstanceAdmin}
                  pending={pendingMachines}
                  setPending={setPendingMachines}
                  attempted={attemptedMachines}
                  onResolved={machineResolved}
                  onDone={goToReview}
                />
              )}

              {step === "review" &&
                plan &&
                (running || stopped || failure ? (
                  <MovingPanel
                    progress={progress}
                    failure={failure}
                    running={running}
                    reverting={reverting}
                    onShowLog={() => setLogOpen(true)}
                    onStop={() => {
                      cancelled.current = true;
                    }}
                    onRevert={revertRun}
                    onKeep={keepPartial}
                  />
                ) : (
                  <ReviewStep
                    plan={plan}
                    teamName={teamName}
                    chosen={chosen}
                    setChosen={setChosen}
                    servers={servers}
                    buildServers={buildServers}
                    placements={placements}
                    setPlacements={setPlacements}
                    canExposePorts={canExposePorts}
                    isInstanceAdmin={isInstanceAdmin}
                    onBack={() => setStep("install")}
                    onStart={() => void runImport()}
                  />
                ))}

              {step === "people" && (
                <PeopleStep
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

      {/* The detail, for whoever wants it. Never in the way. */}
      <MigrationLogDialog
        open={logOpen}
        onOpenChange={setLogOpen}
        progress={progress}
        items={items}
        failure={failure}
        running={running}
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
  sameMachine,
  setSameMachine,
  canUsePrivate,
  scanning,
  onSubmit,
}: {
  url: string;
  setUrl: (v: string) => void;
  apiKey: string;
  setApiKey: (v: string) => void;
  sameMachine: boolean;
  setSameMachine: (v: boolean) => void;
  /** Instance admin. Only they may point Deplo at a private address. */
  canUsePrivate: boolean;
  scanning: boolean;
  onSubmit: (e: React.FormEvent) => void;
}) {
  return (
    <StepShell
      title="Connect to Dokploy"
      lead="Nothing is written on either side until you have seen what would come over."
    >
      <form className="grid gap-4" onSubmit={onSubmit}>
        <div className="grid gap-2">
          <FieldLabel
            htmlFor="dokploy-url"
            info="The address you open Dokploy on. Deplo adds /api itself."
          >
            Address
          </FieldLabel>
          <Input
            id="dokploy-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={
              sameMachine ? "http://172.17.0.1:3000" : "https://dokploy.acme.com"
            }
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="grid gap-2">
          <FieldLabel
            htmlFor="dokploy-key"
            info="In Dokploy: Settings, Profile, API/CLI. Use an owner's or admin's key - a plain member's key is refused on the per-service calls."
          >
            API key
          </FieldLabel>
          <Input
            id="dokploy-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Paste the key"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* Shown to everybody, off and explained for whoever cannot use it. It
            used to be hidden without the grant, which left the most common
            single-box install - Dokploy and Deplo on the same machine - staring
            at an address that will not resolve, with nothing on screen saying
            why or who could fix it.

            The explanation is a tooltip, not a paragraph: three lines of prose
            under a switch is three lines every reader of this screen scrolls
            past, and the only person who needs them is the one who already
            wondered what the switch does. */}
        <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <FieldLabel
            htmlFor="same-machine"
            className="gap-2"
            info={
              <>
                Lets Deplo dial a private address. From in here, Dokploy is
                usually at <code>http://172.17.0.1:3000</code> or on the
                host&apos;s own IP.
              </>
            }
          >
            <ServerIcon className="size-4 text-muted-foreground" />
            Same machine
          </FieldLabel>
          {canUsePrivate ? (
            <Switch
              id="same-machine"
              checked={sameMachine}
              onCheckedChange={setSameMachine}
            />
          ) : (
            <SimpleTooltip content="Only an instance admin can point Deplo at a private address">
              <span className="inline-flex">
                <Switch id="same-machine" checked={false} disabled />
              </span>
            </SimpleTooltip>
          )}
        </div>

        <div className="flex justify-end">
          <Button type="submit" disabled={scanning || !url.trim() || !apiKey.trim()}>
            {scanning && <Loader2 className="size-4 animate-spin" />}
            {scanning ? "Reading Dokploy" : "Check this Dokploy"}
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
 * What the review turns into once the move starts, and what it becomes if that
 * move does not finish.
 *
 * Not a dialog and not a step of its own: there is no decision here while it
 * runs, so it gets no chip on the rail, and nothing to close - leaving the page
 * is refused, so a dismissible dialog would only offer a way out that does not
 * exist. Two lines and a bar say everything; the line-by-line log is one
 * secondary button away.
 *
 * The half-finished case is the one this panel really exists for. A run that
 * failed on project four of seven, or one somebody stopped, leaves apps and
 * databases here that are not a migration - they are debris - and Dokploy has
 * already been stopped for them. So the panel asks the only question left, in
 * two words each: take it back out, or keep it and read the report.
 */
function MovingPanel({
  progress,
  failure,
  running,
  reverting,
  onShowLog,
  onStop,
  onRevert,
  onKeep,
}: {
  progress: MigrationProgress;
  failure: string | null;
  running: boolean;
  reverting: boolean;
  onShowLog: () => void;
  /** Stop after the call in flight. Never mid-request - see the loop. */
  onStop: () => void;
  onRevert: () => Promise<ActionResult<unknown>>;
  onKeep: () => void;
}) {
  const pct = progress.total === 0 ? 0 : (progress.done / progress.total) * 100;
  const [stopping, setStopping] = React.useState(false);

  if (!running)
    return (
      <StepShell
        title={failure ? "The migration stopped" : "You stopped the migration"}
        lead={
          failure ??
          "Whatever had already come over is here, and Dokploy is not serving it any more."
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <ConfirmAction
            trigger={
              <Button variant="destructive">
                <Undo2 className="size-4" />
                Remove what came over
              </Button>
            }
            title="Remove everything this migration created?"
            confirmLabel="Remove it"
            successMessage=""
            description={
              <>
                Deplo deletes the apps, databases and projects this run created
                here, with their data. Anything that was already in this team is
                left alone.
                <br />
                <br />
                It does not start Dokploy back up - the services this migration
                stopped over there stay stopped.
              </>
            }
            onConfirm={onRevert}
          />
          <Button variant="outline" onClick={onKeep} disabled={reverting}>
            Keep it and see the report
          </Button>
          <Button variant="ghost" onClick={onShowLog} disabled={reverting}>
            <ScrollText className="size-4" />
            Show log
          </Button>
        </div>
      </StepShell>
    );

  return (
    <StepShell
      title="Moving everything over"
      lead="Deplo is creating your projects here and copying their data across. Stay on this page."
    >
      <div className="space-y-2">
        <Progress value={pct} />
        <p className="text-sm text-muted-foreground">
          {progress.total > 0 &&
            `Project ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`}
          {progress.current && progress.total > 0 && " · "}
          {progress.current}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={onShowLog}>
          <ScrollText className="size-4" />
          Show log
        </Button>
        {/* Stop, not Cancel: the call in flight finishes either way, so this
            asks for no confirmation - it is the safe half of the decision, and
            the destructive one (take it back out) comes after, with its own. */}
        <Button
          variant="ghost"
          onClick={() => {
            setStopping(true);
            onStop();
          }}
          disabled={stopping}
        >
          {stopping ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <CircleStop className="size-4" />
          )}
          {stopping ? "Stopping" : "Stop"}
        </Button>
      </div>
    </StepShell>
  );
}

/* ------------------------------------------------------------------ */
/* Step - done                                                        */
/* ------------------------------------------------------------------ */

/**
 * The end, and the one step that breaks the two-column layout.
 *
 * Everywhere else the illustration sits beside the thing you are doing, because
 * there is a thing you are doing. Here there is not: the work is over, so the
 * drawing IS the screen - Deplo lit, Dokploy dark - and it goes to the middle at
 * twice the size with the confetti over it.
 *
 * The report is a dialog rather than the body of this step for the same reason.
 * "It worked" is the message; the hundred lines behind it are for whoever wants
 * them, and they are still there in History tomorrow morning.
 */
function DoneStep({
  items,
  onFinish,
  isInstanceAdmin,
}: {
  items: ReportItem[];
  onFinish: () => void;
  /** Uninstalling an agent is instance-admin, like every server action. */
  isInstanceAdmin: boolean;
}) {
  const [reportOpen, setReportOpen] = React.useState(false);
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-6 text-center">
      {/* Over the WINDOW, not over the drawing: a burst of twelve pieces
          throwing 46px inside a 300px picture is a shimmer somebody misses
          while they are reading the heading. Fixed, from the middle of the
          screen, forty pieces going most of the way to the edges. */}
      <ConfettiBurst className="fixed left-1/2 top-1/2 z-50" count={40} spread={320} />

      <MigrationGraphic state="done" className="h-48 w-auto" />

      <div>
        <h2 className="text-xl font-semibold">You&apos;re on Deplo</h2>
        <p className="mt-1 text-sm text-balance text-muted-foreground">
          Nothing is deployed yet. Open an app, check it over, and press Deploy
          when you want the traffic.
        </p>
      </div>

      {/* The two ends of the row, the way every footer in the app reads: what
          you might want to look at first on the left, the way out on the right.
          There is no "migrate another one" - Finish leaves the page, and coming
          back here gives a blank wizard, which is the same thing without a
          button nobody presses twice. */}
      <div className="flex w-full flex-wrap items-center justify-between gap-2">
        <Button variant="outline" onClick={() => setReportOpen(true)}>
          <ScrollText className="size-4" />
          View report
        </Button>
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

      <MigrationReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        items={items}
        description="What this migration did, line by line. Nothing here was deployed."
      />
    </div>
  );
}
