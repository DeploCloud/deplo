// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { listApps } from "@/lib/data/apps";
import { listDatabases } from "@/lib/data/databases";
import { listProjects } from "@/lib/data/projects";
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
import { DEFAULT_LOG_RANGE_DAYS } from "@/lib/types";

export const metadata = { title: "Logs" };

/**
 * The general Logs page: pick a thing, then watch its logs full screen.
 */
export default async function LogsPage(props: PageProps<"/logs">) {
  const params = await props.searchParams;

  const apps = await listApps();
  // `view_logs` is held PER APP (ADR-0016). `listApps` already resolves each app's
  // capabilities in one batched pass and hands them back on the summary, so this is
  // the same answer `hasAppCapability` would give, without a call per row.
  const readableApps = apps.filter((a) =>
    a.capabilities?.includes("view_logs"),
  );

  // A database belongs to the team and to no project, so its logs are gated
  // team-wide.
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
      // Where the picker files it. All three are tolerated when they point at
      // something this viewer cannot see - the tree drops the app to the top
      // level rather than out of the list.
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

  // One readable target is not a choice: open it. `?pick=1` still forces the
  // chooser, which is the only way to see it on such an instance. Outside any
  // try/catch: `redirect` works by throwing.
  const pick = Array.isArray(params.pick) ? params.pick[0] : params.pick;
  if (!target && !pick && targets.length === 1)
    redirect(logTargetHref(targets[0]!.key));

  // The shape of the Overview, for the picker to file the targets into.
  const [projects, environments, folders] = await Promise.all([
    listProjects(),
    listAllEnvironmentsForTeam(),
    listFolders(),
  ]);
  const rows = buildLogTree(targets, { projects, environments, folders });

  if (!target) return <LogChooser rows={rows} />;

  // Reopening the remembered target puts it in the URL rather than rendering it
  // at a bare `/logs`, so a link somebody copies shows the logs they meant and
  // Back walks the targets they actually visited.
  const askedFor = params.app ?? params.db;
  if (!askedFor) redirect(logTargetHref(target.key));

  const picker = <LogTargetPicker rows={rows} value={target.key} />;

  if (target.kind === "database") {
    const db = databases.find((d) => d.id === target.key.slice("db:".length))!;
    const info = await getDatabaseLogsInfo(db.id);
    return (
      // Keyed per target: Next reuses this route segment when only the search params
      // change, so without it the SSE buffer and the container picker would survive a
      // switch and show one database's output under another's name.
      <DatabaseLiveStatusProvider
        key={target.key}
        initial={{ id: db.id, name: db.name, status: db.status }}
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
    latestDeploymentId: latest?.id ?? null,
    latestDeploymentStatus: latest?.status ?? null,
  };

  return (
    // The App's own layout mounts this provider; `/logs` sits outside it, and
    // without one the pane cannot follow a deploy that starts while it is open.
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
