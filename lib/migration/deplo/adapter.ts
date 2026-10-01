import {
  StopAcceptedError,
  type MigrationSourceClient,
  type RuntimeQuery,
  type ServiceRuntime,
  type SourceCredential,
  type SourceDataExport,
} from "../source";
import type { SourceMember, SourceSchedule } from "../model";
import { SELF_PANEL_REFUSAL } from "../self";
import {
  TOKEN_RECIPE,
  checkData,
  exportOf,
  forgetExport,
  setRunning,
  streamData,
  workloadRunning,
  type WorkloadKind,
} from "./client";
import type { DeploExport } from "./export-shape";
import { instanceFingerprint } from "./instance";
import {
  sourceApplication,
  sourceDatabase,
  sourceTree,
  teamShared,
} from "./map";

const STOP_DEADLINE_MS = 120_000;
const STOP_POLL_MS = 1_500;

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function workloadOf(
  x: DeploExport,
  kind: string,
  id: string,
): {
  kind: WorkloadKind;
  app?: DeploExport["apps"][number];
  db?: DeploExport["databases"][number];
} {
  if (kind === "application" || kind === "compose") {
    const app = x.apps.find((a) => a.id === id);
    if (app) return { kind: "app", app };
  } else {
    const db = x.databases.find((d) => d.id === id);
    if (db) return { kind: "database", db };
  }
  throw new Error(
    "That service is no longer on the Deplo you are moving from.",
  );
}

async function assertReadable(c: SourceCredential): Promise<void> {
  forgetExport(c);
  const x = await exportOf(c);
  if (x.instance === instanceFingerprint()) throw new Error(SELF_PANEL_REFUSAL);
  const missing = [
    ...(x.apps.length > 0 && !x.canControl.apps ? ["Control apps"] : []),
    ...(x.databases.length > 0 && !x.canControl.databases
      ? ["Control databases"]
      : []),
  ];
  if (missing.length > 0)
    throw new Error(
      `This token cannot stop what it would move (it lacks ${missing.join(" and ")}), and the copy stops each service before it reads its data. ${TOKEN_RECIPE}`,
    );
}

async function serviceRuntime(
  c: SourceCredential,
  svc: RuntimeQuery,
): Promise<ServiceRuntime> {
  const x = await exportOf(c);
  const w = workloadOf(x, svc.kind, svc.id);
  const data = (w.app ?? w.db)!.data;
  const live = await workloadRunning(c, w.kind, svc.id).catch(() => null);
  const running =
    live ?? ["running", "active", "building"].includes((w.app ?? w.db)!.status);
  const notes: string[] = [];
  if (data.volumes.length + data.hostMounts.length === 0)
    notes.push(
      `{panel} says ${svc.appName} mounts nothing, so there is nothing to copy.`,
    );
  else if (!running)
    notes.push(
      `${svc.appName} is already stopped on {panel}, which is exactly the state its data has to be read in.`,
    );
  return { volumes: data.volumes, hostMounts: data.hostMounts, running, notes };
}

async function stopService(
  c: SourceCredential,
  kind: string,
  id: string,
): Promise<void> {
  const w = workloadOf(await exportOf(c), kind, id);
  await setRunning(c, w.kind, id, false);
  const started = Date.now();
  for (;;) {
    const running = await workloadRunning(c, w.kind, id).catch(() => null);
    if (running === false) return;
    if (Date.now() - started >= STOP_DEADLINE_MS)
      throw new StopAcceptedError(
        `That Deplo accepted the stop but still reported it running ${STOP_DEADLINE_MS / 1000} seconds later.`,
      );
    await new Promise((r) => setTimeout(r, STOP_POLL_MS));
  }
}

function dataExport(c: SourceCredential): SourceDataExport {
  const ref = async (svc: { kind: string; id: string }) => ({
    kind: workloadOf(await exportOf(c), svc.kind, svc.id).kind,
    id: svc.id,
  });
  return {
    check: async (svc, volumes) =>
      checkData(c, { ...(await ref(svc)), check: volumes }),
    exportVolume: (svc, name) =>
      (async function* () {
        yield* streamData(c, { ...(await ref(svc)), volume: name });
      })(),
    exportHostPath: (svc, path, allowFile) =>
      (async function* () {
        yield* streamData(c, {
          ...(await ref(svc)),
          hostPath: path,
          allowFile: allowFile === true,
        });
      })(),
  };
}

export function deploClient(c: SourceCredential): MigrationSourceClient {
  return {
    platform: "deplo",
    baseUrl: c.baseUrl,
    displayName: `Deplo at ${hostOf(c.baseUrl)}`,

    assertReadable: () => assertReadable(c),
    listProjects: async () => sourceTree(await exportOf(c)),
    getEnvironment: async (id) =>
      sourceTree(await exportOf(c))
        .flatMap((p) => p.environments ?? [])
        .find((e) => e.environmentId === id) ?? null,
    getService: async (kind, id) => {
      const x = await exportOf(c);
      const w = workloadOf(x, kind, id);
      return w.app ? sourceApplication(x, w.app) : sourceDatabase(x, w.db!);
    },
    getResolvedCompose: async () => null,

    // Nothing is installed on a Deplo source's machines, so the wizard has none to show.
    listServers: async () => [],
    listMembers: async (): Promise<SourceMember[]> =>
      (await exportOf(c)).members.map((m) => ({
        email: m.email,
        name: m.name,
        role: m.role,
      })),
    sourceTeam: async () => {
      const { team } = await exportOf(c);
      return { id: team.id, name: team.name };
    },
    otherTeams: async () => (await exportOf(c)).otherTeams,

    listSchedules: async (kind, id): Promise<SourceSchedule[]> => {
      const w = workloadOf(await exportOf(c), kind, id);
      return (w.app?.crons ?? []).map((j, i) => ({
        scheduleId: `${id}:cron:${i}`,
        name: j.name,
        cronExpression: j.schedule,
        command: j.command,
        serviceName: j.service,
        enabled: j.enabled,
      }));
    },
    teamSharedEnv: async () => {
      const shared = teamShared(await exportOf(c));
      return shared
        ? { env: shared.env, secretEnvKeys: shared.secretEnvKeys }
        : null;
    },
    serverSharedEnv: async () => null,
    listBackupDestinations: async () => (await exportOf(c)).destinations,

    serviceRuntime: (svc) => serviceRuntime(c, svc),
    stopService: (kind, id) => stopService(c, kind, id),
    startService: async (kind, id) => {
      const w = workloadOf(await exportOf(c), kind, id);
      await setRunning(c, w.kind, id, true);
    },
    platformNetworks: () => [],
    dataExport: dataExport(c),
  };
}
