"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";

import { gqlAction } from "@/lib/graphql-client";
import {
  useMigrationFeed,
  type ActiveMigration,
} from "@/components/layout/migration-activity";
import { type ConsoleRun } from "../migration-console";
import { type PeopleGroup } from "../people-step";
import { type StepId } from "../steps";
import { type ImportRun, type Plan, type SessionRun } from "../types";
import {
  CREATE_TEAM,
  DISMISS,
  MINT_LINK,
  SESSION,
  START,
  STOP,
} from "./operations";
import { asActive, sum, type RunReport } from "./session";
import { type SourceQueue } from "./use-source-queue";

export function useMigrationRun({
  teamId,
  resumable,
  source,
  setStep,
  afterRun,
}: {
  teamId: string;
  resumable: ImportRun | null;
  source: SourceQueue;
  setStep: React.Dispatch<React.SetStateAction<StepId>>;
  afterRun: () => StepId;
}) {
  const router = useRouter();
  const {
    url,
    setApiKey,
    latestPlan,
    queueRef,
    atRef,
    setAt,
    updateQueue,
    hasWork,
    queuedAfter,
    targetsOf,
    landIn,
    fleetsRef,
    ownFleet,
    sourceLabel,
    resetPlan,
    forgetPanel,
    setForcedKind,
    inTarget,
    targetTeamId,
    setTargetTeamId,
    targetTeamRef,
    sourcesTeam,
  } = source;

  const [sessionRuns, setSessionRuns] = React.useState<SessionRun[]>([]);
  const [teamLinks, setTeamLinks] = React.useState<Record<string, string>>({});
  const [mintingFor, setMintingFor] = React.useState<string | null>(null);
  const madeTeams = React.useRef<Record<number, string>>({});
  const [snapshot, setSnapshot] = React.useState<ActiveMigration | null>(() =>
    resumable && resumable.status === "running" ? asActive(resumable) : null,
  );
  const [runId, setRunId] = React.useState<string | null>(null);
  const [report, setReport] = React.useState<RunReport | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);
  const startingRef = React.useRef(false);
  const [starting, setStarting] = React.useState(false);
  const [undoing, setUndoing] = React.useState(false);
  const [adoptedId, setAdoptedId] = React.useState<string | null>(null);
  const [logOpen, setLogOpen] = React.useState(false);
  const restored = React.useRef(false);
  async function runImport(opts: {
    from: Plan;
    key: string;
    home: string;
    queued: ReturnType<typeof queuedAfter>;
  }) {
    if (running) return;
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
    setRunId(res.data);
    setAdoptedId(res.data);
    setApiKey("");
    updateQueue(queueRef.current.map((e) => ({ ...e, apiKey: "" })));
    void refreshSession(res.data);
  }
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

  async function startFirstTeam() {
    const i = queueRef.current.findIndex((_, j) => hasWork(j));
    if (i === -1) {
      setFailure("Nothing is selected, so there is nothing to migrate.");
      return;
    }
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
      const made = await gqlAction<{ createTeam: { id: string } }, string>(
        CREATE_TEAM,
        {
          name: team.name || url.replace(/^https?:\/\//, "").split("/")[0],
          image: team.image,
        },
        (d) => d.createTeam.id,
      );
      if (!made.ok || !made.data)
        return toast.error(
          made.ok ? "Deplo could not create the team." : made.error,
        );
      home = made.data;
      madeTeams.current[i] = home;
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

  const resetTeamState = React.useCallback(() => {
    setUndoing(false);
    setFailure(null);
    setRunId(null);
    setReport(null);
    setAdoptedId(null);
    resetPlan();
    setLogOpen(false);
  }, [resetPlan]);

  const resetToStart = React.useCallback(() => {
    resetTeamState();
    setForcedKind(null);
    setStep("connect");
    router.refresh();
  }, [resetTeamState, router, setForcedKind, setStep]);

  const forgetQueue = React.useCallback(() => {
    forgetPanel();
    setSessionRuns([]);
    setTeamLinks({});
  }, [forgetPanel]);

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
  const refreshSession = React.useCallback(
    async (id: string) => {
      const res = await gqlAction<
        { migrationSession: SessionRun[] },
        SessionRun[]
      >(SESSION, { runId: id }, (d) => d.migrationSession);
      if (!res.ok || !res.data || res.data.length === 0) return;
      const runs = res.data;
      setSessionRuns(runs);
      setSnapshot(null);

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

      const landed = runs.filter((r) => r.status === "done");
      const badly = runs.filter(
        (r) => r.status === "failed" || r.status === "stopped",
      );
      if (landed.length === 0) {
        const why = badly.find((r) => r.error)?.error;
        if (why) toast.error(why);
        else
          toast.success(
            "The migration was stopped. Its report is under History",
          );
        setSessionRuns([]);
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
      setStep((at2) => (at2 === "review" ? afterRun() : at2));
    },
    [afterRun, forgetQueue, resetToStart],
  );
  const settleFinished = React.useCallback(
    async (id: string) => {
      await refreshSession(id);
    },
    [refreshSession],
  );
  async function closeReport() {
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
  const watched = useMigrationFeed(targetTeamId ?? teamId);

  const feed = watched ?? snapshot;
  React.useEffect(() => {
    if (restored.current || !resumable) return;
    restored.current = true;
    setRunId(resumable.id);
    setAdoptedId(resumable.id);
    setStep("review");
    void settleFinished(resumable.id);
  }, [resumable, settleFinished]);
  const wasWatching = React.useRef<string | null>(null);
  React.useEffect(() => {
    const now = watched?.id ?? null;
    const before = wasWatching.current;
    wasWatching.current = now;
    if (before && !now) void settleFinished(before);
  }, [watched, settleFinished]);
  const awaitingRun =
    runId != null && feed == null && report == null && failure == null;

  React.useEffect(() => {
    if (!awaitingRun || !runId) return;
    const id = setInterval(() => void settleFinished(runId), 3000);
    return () => clearInterval(id);
  }, [awaitingRun, runId, settleFinished]);
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
  const lastSourcesTeam =
    sessionRuns.filter((r) => r.status !== "queued").at(-1)?.teamId ??
    sourcesTeam.current;
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

  return {
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
  };
}
