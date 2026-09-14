"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { cn } from "@/lib/utils";

import { TEAM_HEADER } from "@/lib/team-path";
import { AnimatedHeight } from "@/components/shared/animated-height";
import { LeftoverDiskGraphic } from "@/components/takeover/leftover-disk-graphic";
import { WizardStepper } from "@/components/shared/wizard-stepper";
import { UnsavedChangesGuard } from "@/components/apps/unsaved-changes-guard";
import { InstallStep } from "../install-step/install-step";
import { MigrationGraphic, type MigrationState } from "../migration-graphic";
import { type SourceKind } from "../sources";
import { ReviewStep } from "../review-step";
import { PeopleStep } from "../people-step";
import { MigrationConsole } from "../migration-console";
import { ChooseStep } from "../choose-step";
import {
  reviewShows,
  stepReachable,
  stepsFor,
  type StepId,
  type TakeoverMode,
} from "../steps";
import {
  TakeoverStep,
  type TakeoverState,
} from "@/components/takeover/takeover-actions";
import { teamsAfter } from "../queue";
import { type ImportRun, type ServerChoice, type TargetTeam } from "../types";
import { ABANDON } from "./operations";
import { lastStep, NO_PROGRESS } from "./session";
import { useSourceQueue } from "./use-source-queue";
import { useMigrationRun } from "./use-migration-run";
import { ConnectStep } from "./connect-step";
import { MovingPanel } from "./moving-panel";
import { ReportCard } from "./report-card";
import { DoneStep } from "./done-step";

// stepForHandover - the step a handover already under way pins the wizard to, or null.
function stepForHandover(
  state: Exclude<TakeoverState, "cancelled"> | undefined,
): StepId | null {
  if (!state || state === "pending") return null;
  // `failed` lands on the step too: it is where Try again lives.
  return state === "removed" ? "done" : "takeover";
}

// MigrationWizard - migrating a panel over, as one screen: every team of it, into a Deplo team.
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
  teamId: string;
  targetTeams: TargetTeam[];
  servers: ServerChoice[];
  buildServers: ServerChoice[];
  isInstanceAdmin: boolean;
  canExposePorts: boolean;
  resumable: ImportRun | null;
  sameMachineHost: string;
  prefill?: { url: string; kind: SourceKind } | null;
  takeover?: {
    platformLabel: string;
    state: Exclude<TakeoverState, "cancelled">;
    finishedRunId: string | null;
    finalUrl: string;
    error: string | null;
    dataLoss: string[];
  } | null;
  preflight?: React.ReactNode;
  startOnTakeover?: boolean;
}) {
  const router = useRouter();
  const isTakeover = takeover != null;
  const [mode, setMode] = React.useState<TakeoverMode | null>(() => {
    if (!isTakeover) return "migrate";
    if (startOnTakeover || resumable != null || takeover.finishedRunId != null)
      return "migrate";
    return takeover.state === "pending" ? null : "clean";
  });
  const [step, setStep] = React.useState<StepId>(
    () =>
      stepForHandover(takeover?.state) ??
      (mode == null ? "choose" : startOnTakeover ? "takeover" : "connect"),
  );
  // The handover is the server's, so the step follows it once it starts.
  // Adjusted during the render, which is what React prescribes here.
  /* eslint-disable react-hooks/refs -- deliberate render-phase adjustment; the rule
     only bailed before because the pre-split component was too large to analyse. */
  const seenHandover = React.useRef(takeover?.state);
  if (takeover && takeover.state !== seenHandover.current) {
    seenHandover.current = takeover.state;
    const forced = stepForHandover(takeover.state);
    if (forced) setStep(forced);
  }
  /* eslint-enable react-hooks/refs */

  const source = useSourceQueue({
    teamId,
    targetTeams,
    servers,
    buildServers,
    prefill,
    resumable,
    setStep,
  });
  const {
    url,
    setUrl,
    apiKey,
    setApiKey,
    scanning,
    queue,
    queueRef,
    updateQueue,
    at,
    adding,
    plan,
    forcedKind,
    setForcedKind,
    scanError,
    pendingMachines,
    setPendingMachines,
    attemptedMachines,
    chosen,
    setChosen,
    placements,
    setPlacements,
    sourcesTeam,
    uncovered,
    kind,
    machinesReady,
    reviewGroups,
    submitConnect,
    identifyAndAdd,
    retargetAt,
    setTeamImage,
    machineResolved,
  } = source;

  const afterRun = React.useCallback(
    (): StepId => (isTakeover ? "review" : isInstanceAdmin ? "people" : "done"),
    [isTakeover, isInstanceAdmin],
  );

  const run = useMigrationRun({
    teamId,
    resumable,
    source,
    setStep,
    afterRun,
  });
  const {
    sessionRuns,
    runId,
    adoptedId,
    report,
    failure,
    setFailure,
    running,
    starting,
    undoing,
    logOpen,
    setLogOpen,
    feed,
    awaitingRun,
    peopleGroups,
    teamReports,
    totals,
    consoleRuns,
    lastSourcesTeam,
    movingTeam,
    startChain,
    stopRun,
    closeReport,
    resetToStart,
    forgetQueue,
  } = run;

  const teamsLeft =
    sessionRuns.length > 0
      ? sessionRuns.filter((r) => r.status === "queued").length
      : teamsAfter(queue, at);

  const STEPS = React.useMemo(
    () => stepsFor(isInstanceAdmin, isTakeover, mode),
    [isInstanceAdmin, isTakeover, mode],
  );

  const goToReview = React.useCallback(() => setStep("review"), []);

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

  const resumed =
    feed != null && !running && failure === null && step !== "done";
  const takenOver = resumed;

  const showing = reviewShows({
    running,
    runId: adoptedId ?? runId,
    failure,
    report: report != null,
    plan: plan != null,
  });
  const moving = step === "review" && showing === "moving";

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

  const inFlight = starting || running || takenOver || awaitingRun;

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

  const guarded =
    step !== "done" &&
    report == null &&
    !takenOver &&
    !awaitingRun &&
    (plan != null || url.trim() !== "" || apiKey.trim() !== "");

  const abandonRef = React.useRef(false);
  // No dependency array on purpose: this is the "latest value" of a flag the
  // listeners below read long after the render that produced it.
  React.useEffect(() => {
    abandonRef.current = guarded && plan != null && !starting && !running;
  });
  React.useEffect(() => {
    const abandon = () => {
      if (!abandonRef.current) return;
      abandonRef.current = false;
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
      <UnsavedChangesGuard
        when={guarded}
        title={starting ? "The migration is starting" : "Leave the migration?"}
        description={
          starting
            ? "Nothing is written down until it has started. Leaving now can lose what you chose."
            : "Deplo takes its agent back off the machines it installed one on if you do not come back within ten minutes."
        }
        confirmLabel="Leave anyway"
        cancelLabel="Stay on this page"
      />

      {step === "done" ? (
        <DoneStep
          kind={kind}
          panelUrl={takeover?.finalUrl ?? null}
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
          onFinish={() => {
            if (takeover) return window.location.assign(takeover.finalUrl);
            void closeReport().then(() => router.push("/"));
          }}
        />
      ) : (
        <div className="mx-auto flex w-full flex-col items-center gap-8">
          {step === "takeover" &&
          (takeover?.state === "pending" || takeover?.state === "failed") ? (
            <LeftoverDiskGraphic className="w-full max-w-xl" />
          ) : (
            <MigrationGraphic
              state={pose}
              kind={kind}
              className={cn(
                "h-auto w-full",
                isTakeover ? "max-w-xl" : "max-w-md",
              )}
            />
          )}

          <div
            className={cn(
              "w-full min-w-0",
              step === "people" ? "max-w-3xl" : "max-w-xl",
            )}
          >
            <AnimatedHeight scroll={false} className="space-y-6">
              {step !== "choose" && !cuttingOver && (
                <div className="flex justify-center">
                  <WizardStepper
                    steps={STEPS}
                    compact
                    current={takenOver ? "review" : step}
                    reachable={reach}
                    onSelect={(s) => {
                      if (!reach(s)) return;
                      setStep(s);
                    }}
                  />
                </div>
              )}

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
                      heartbeatAt={
                        awaitingRun ? null : new Date().toISOString()
                      }
                      failure={failure}
                      running={running || awaitingRun}
                      undoing={false}
                      onShowLog={() => setLogOpen(true)}
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

                {!takenOver && step === "takeover" && takeover && mode && (
                  <TakeoverStep
                    platformLabel={takeover.platformLabel}
                    mode={mode}
                    state={takeover.state}
                    finishedRunId={adoptedId ?? runId ?? takeover.finishedRunId}
                    finalUrl={takeover.finalUrl}
                    error={takeover.error}
                    dataLoss={takeover.dataLoss}
                  />
                )}
              </div>
            </AnimatedHeight>
          </div>
        </div>
      )}

      <MigrationConsole
        runs={consoleRuns}
        open={logOpen}
        onOpenChange={setLogOpen}
        live={feed != null}
      />
    </>
  );
}
