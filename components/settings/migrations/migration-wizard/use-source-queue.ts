"use client";

import * as React from "react";
import { toast } from "sonner";

import { gqlAction } from "@/lib/graphql-client";
import type { PendingMachine } from "../install-step/machine-state";
import { copyFor, type SourceKind } from "../sources";
import { type ReviewGroup } from "../review-step";
import { type StepId } from "../steps";
import {
  addTeam,
  retarget,
  uncoveredTeams,
  type QueuedTeam,
  type SourceTeam,
  type TeamTarget,
} from "../queue";
import {
  importableOf,
  type ImportRun,
  type Placement,
  type Plan,
  type ServerChoice,
  type TargetTeam,
} from "../types";
import { FLEET, HAND_OVER_SOURCES, IDENTIFY, SCAN } from "./operations";
import {
  defaultChoice,
  landingDefaults,
  reconcilePlacements,
  type Fleet,
  type FleetServer,
} from "./landing";

export type SourceQueue = ReturnType<typeof useSourceQueue>;

export function useSourceQueue({
  teamId,
  targetTeams,
  servers,
  buildServers,
  prefill,
  resumable,
  setStep,
}: {
  teamId: string;
  targetTeams: TargetTeam[];
  servers: ServerChoice[];
  buildServers: ServerChoice[];
  prefill: { url: string; kind: SourceKind } | null;
  resumable: ImportRun | null;
  setStep: (s: StepId) => void;
}) {
  const [url, setUrl] = React.useState(prefill?.url ?? "");
  const [apiKey, setApiKey] = React.useState("");
  const [scanning, setScanning] = React.useState(false);
  const [queue, setQueue] = React.useState<QueuedTeam[]>([]);
  const [at, setAt] = React.useState(0);
  const [adding, setAdding] = React.useState(false);
  const [panelTeams, setPanelTeams] = React.useState<string[] | null>(null);
  const [teamPlans, setTeamPlans] = React.useState<Record<number, Plan>>({});
  const [fleets, setFleets] = React.useState<Record<string, Fleet>>({});
  const latestPlan = React.useRef<Plan | null>(null);
  const [plan, setPlan] = React.useState<Plan | null>(null);
  const [forcedKind, setForcedKind] = React.useState<SourceKind | null>(
    prefill?.kind ?? null,
  );
  const [scanError, setScanError] = React.useState<string | null>(null);
  const [rescanning, setRescanning] = React.useState<Record<number, boolean>>(
    {},
  );

  const [serverMap, setServerMap] = React.useState<Record<string, string>>({});
  const [pendingMachines, setPendingMachines] = React.useState<
    Record<string, PendingMachine>
  >({});
  const attemptedMachines = React.useRef(new Set<string>());
  const [chosen, setChosen] = React.useState<Set<string>>(new Set());
  const [placements, setPlacements] = React.useState<Record<string, Placement>>(
    {},
  );

  const [targetTeamId, setTargetTeamId] = React.useState<string | null>(
    resumable?.teamId ?? null,
  );
  const targetTeamRef = React.useRef(targetTeamId ?? teamId);
  targetTeamRef.current = targetTeamId ?? teamId;
  const inTarget = () => ({ teamId: targetTeamRef.current });
  const sourcesTeam = React.useRef(teamId);

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
  const uncovered = uncoveredTeams(panelTeams, queue);

  const kind: SourceKind | null = plan?.platform ?? forcedKind;

  const sourceLabel = `An unnamed ${copyFor(kind).teamLabel}`;
  const sourceTeamName = (q: QueuedTeam) => q.name || sourceLabel;
  const ownFleet = React.useMemo<Fleet>(
    () => ({ servers, buildServers }),
    [servers, buildServers],
  );
  const fleetFor = React.useCallback(
    (target: TeamTarget): Fleet =>
      (target.kind === "existing" && fleets[target.teamId]) || ownFleet,
    [fleets, ownFleet],
  );

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

  async function submitConnect(e: React.FormEvent) {
    e.preventDefault();
    if (apiKey.trim()) return identifyAndAdd();
    if (queue.length > 0) return scanAll();
  }
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
    setApiKey("");
  }
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
    setStep("install");
  }

  async function landIn(
    i: number,
    home: string,
    key: string,
  ): Promise<string | null> {
    if (sourcesTeam.current !== home) {
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
  function retargetAt(i: number, target: TeamTarget) {
    updateQueue(retarget(queueRef.current, i, target));
    if (target.kind === "existing" && !fleetsRef.current[target.teamId])
      void loadFleet(target.teamId);
    void rescanTeam(i, target);
  }

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

  function setTeamImage(i: number, image: string | null) {
    updateQueue(
      queueRef.current.map((e, j) => (j === i ? { ...e, image } : e)),
    );
  }

  function updateQueue(next: QueuedTeam[]) {
    queueRef.current = next;
    setQueue(next);
  }

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
    },
    [],
  );

  const machinesReady = React.useMemo(
    () => (plan?.servers ?? []).every((m) => m.deploServerOnline),
    [plan],
  );

  const resetPlan = React.useCallback(() => {
    setPlan(null);
    setChosen(new Set());
    setPlacements({});
    setServerMap({});
    setPendingMachines({});
    attemptedMachines.current = new Set();
    setApiKey("");
    setScanError(null);
  }, []);

  const forgetPanel = React.useCallback(() => {
    updateQueue([]);
    setAt(0);
    setPanelTeams(null);
    setTeamPlans({});
    setTargetTeamId(null);
    sourcesTeam.current = teamId;
  }, [teamId]);

  return {
    url,
    setUrl,
    apiKey,
    setApiKey,
    scanning,
    queue,
    queueRef,
    updateQueue,
    at,
    atRef,
    setAt,
    adding,
    plan,
    latestPlan,
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
    fleetsRef,
    ownFleet,
    targetTeamId,
    setTargetTeamId,
    targetTeamRef,
    inTarget,
    sourcesTeam,
    uncovered,
    kind,
    sourceLabel,
    machinesReady,
    reviewGroups,
    submitConnect,
    identifyAndAdd,
    retargetAt,
    setTeamImage,
    hasWork,
    targetsOf,
    queuedAfter,
    landIn,
    machineResolved,
    resetPlan,
    forgetPanel,
  };
}
