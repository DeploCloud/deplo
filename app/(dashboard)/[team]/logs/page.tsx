import { redirect } from "next/navigation";
import { withTeam } from "@/lib/team-path";
import { cookies } from "next/headers";
import { listApps } from "@/lib/data/apps/listing";
import { listDatabases } from "@/lib/data/databases/rows";
import { listProjects } from "@/lib/data/projects/read";
import { listAllEnvironmentsForTeam } from "@/lib/data/environments";
import { listFolders } from "@/lib/data/folders";
import { getLogsInfo } from "@/lib/data/console";
import { getDatabaseLogsInfo } from "@/lib/data/database-console";
import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import { LiveLogs } from "@/components/apps/live-logs";
import { DatabaseLogs } from "@/components/storage/database-logs";
import {
  AppLiveStatusProvider,
  type LiveApp,
} from "@/components/apps/app-live-status";
import { DatabaseLiveStatusProvider } from "@/components/storage/database-live-status";
import { LogChooser, LogTargetPicker } from "@/components/logs/log-targets";
import {
  LOG_TARGET_COOKIE,
  appTargetKey,
  buildLogTree,
  databaseTargetKey,
  logTargetHref,
  resolveLogTarget,
  type LogTarget,
} from "@/components/logs/log-target";
import { DEFAULT_LOG_RANGE_DAYS } from "@/lib/types/deployment";

export const metadata = { title: "Logs" };

export default async function LogsPage(props: PageProps<"/[team]/logs">) {
  const { team } = await props.params;
  const params = await props.searchParams;

  const apps = await listApps();
  const readableApps = apps.filter((a) =>
    a.capabilities?.includes("view_logs"),
  );

  const canReadDatabases =
    (await hasCapability("view_logs")) && (await reachesWholeTeam());
  const databases = canReadDatabases ? await listDatabases() : [];

  const targets: LogTarget[] = [
    ...readableApps.map((a) => ({
      key: appTargetKey(a.slug),
      kind: "app" as const,
      name: a.name,
      detail: a.slug,
      status: a.status,
      logo: a.logo,
      projectId: a.projectId ?? null,
      environmentId: a.environmentId ?? null,
      folderId: a.folderId ?? null,
    })),
    ...databases.map((d) => ({
      key: databaseTargetKey(d.id),
      kind: "database" as const,
      name: d.name,
      detail: d.type,
      status: d.status,
      logo: d.logo,
      type: d.type,
    })),
  ];

  const remembered = (await cookies()).get(LOG_TARGET_COOKIE)?.value;
  const target = resolveLogTarget(targets, {
    app: params.app,
    db: params.db,
    pick: params.pick,
    cookie: remembered,
  });

  const pick = Array.isArray(params.pick) ? params.pick[0] : params.pick;
  if (!target && !pick && targets.length === 1)
    redirect(withTeam(logTargetHref(targets[0]!.key), team));

  const [projects, environments, folders] = await Promise.all([
    listProjects(),
    listAllEnvironmentsForTeam(),
    listFolders(),
  ]);
  const rows = buildLogTree(targets, { projects, environments, folders });

  if (!target) return <LogChooser rows={rows} />;

  const askedFor = params.app ?? params.db;
  if (!askedFor) redirect(withTeam(logTargetHref(target.key), team));

  const picker = <LogTargetPicker rows={rows} value={target.key} />;

  if (target.kind === "database") {
    const db = databases.find((d) => d.id === target.key.slice("db:".length))!;
    const info = await getDatabaseLogsInfo(db.id);
    return (
      <DatabaseLiveStatusProvider
        key={target.key}
        initial={{
          id: db.id,
          name: db.name,
          status: db.status,
          restartLoopStoppedAt: db.restartLoopStoppedAt,
        }}
      >
        <DatabaseLogs
          id={db.id}
          status={db.status}
          instances={info?.instances ?? []}
          streamable={!!info?.streamable}
          supportsTimeline={!!info?.supportsTimeline}
          logMaxDays={info?.logMaxDays ?? DEFAULT_LOG_RANGE_DAYS}
          toolbar={picker}
        />
      </DatabaseLiveStatusProvider>
    );
  }

  const app = readableApps.find(
    (a) => a.slug === target.key.slice("app:".length),
  )!;
  const latest = app.latestDeployment;
  const info = await getLogsInfo(app.id);

  const initialLive: LiveApp = {
    id: app.id,
    slug: app.slug,
    status: app.status,
    productionUrl: app.productionUrl ?? null,
    restartLoopStoppedAt: app.restartLoopStoppedAt ?? null,
    latestDeploymentId: latest?.id ?? null,
    latestDeploymentStatus: latest?.status ?? null,
  };

  return (
    <AppLiveStatusProvider key={target.key} initial={initialLive}>
      <LiveLogs
        appId={app.id}
        initialInstances={info?.instances ?? []}
        initialStreamable={!!info?.streamable}
        initialUnreachable={!!info?.unreachable}
        initialSupportsTimeline={!!info?.supportsTimeline}
        initialLogMaxDays={info?.logMaxDays ?? DEFAULT_LOG_RANGE_DAYS}
        deploymentsHref={`/apps/${app.slug}/deployments`}
        toolbar={picker}
      />
    </AppLiveStatusProvider>
  );
}
