import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { listApps } from "@/lib/data/apps";
import { listDatabases } from "@/lib/data/databases";
import { getLogsInfo } from "@/lib/data/console";
import { getDatabaseLogsInfo } from "@/lib/data/database-console";
import { getLogs } from "@/lib/data/deployments";
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
  databaseTargetKey,
  logTargetHref,
  resolveLogTarget,
  type LogTarget,
} from "@/components/logs/log-target";
import { DEFAULT_LOG_RANGE_DAYS } from "@/lib/types";

export const metadata = { title: "Logs" };

/**
 * The general Logs page: pick a thing, then watch its logs full screen.
 *
 * Two states on one route, both full-bleed (see `components/layout/shell-frame.tsx`).
 * With no target it is the chooser; with one it is the same pane an App's own
 * Logs tab renders, plus a target picker in the toolbar where the title would
 * be. It replaces a page that fetched the last fifteen deployments AND all
 * fifteen of their build logs on every render, to show static build output for
 * one of them.
 *
 * The readable-target list is loaded either way, because state B's picker needs
 * it as much as state A's grid — which is also what makes validating the
 * remembered target free: membership in this list IS the check. A deleted App,
 * a revoked `view_logs`, a target belonging to the team the viewer just left
 * and a mangled cookie all come back as "not in the list", and the chooser
 * renders. Nothing has to clean the cookie up.
 */
export default async function LogsPage(props: PageProps<"/logs">) {
  const params = await props.searchParams;

  const apps = await listApps();
  // `view_logs` is held PER APP (ADR-0016). `listApps` already resolves each
  // app's capabilities in one batched pass and hands them back on the summary,
  // so this is the same answer `hasAppCapability` would give, without a call
  // per row. The real gates still sit behind it: `getLogsInfo` answers null,
  // the SSE route answers 403, `getLogs` answers [].
  const readableApps = apps.filter((a) =>
    a.capabilities?.includes("view_logs"),
  );

  // A database belongs to the team and to no project, so its logs are gated
  // team-wide. `listDatabases` opens with `requireTeamWide`, which THROWS for a
  // member who only reaches part of the team, so ask first rather than hand
  // them the error boundary — the same guard the Storage page uses.
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

  if (!target) return <LogChooser targets={targets} />;

  // Reopening the remembered target puts it in the URL rather than rendering it
  // at a bare `/logs`, so a link somebody copies shows the logs they meant and
  // Back walks the targets they actually visited. Outside any try/catch:
  // `redirect` works by throwing.
  const askedFor = params.app ?? params.db;
  if (!askedFor) redirect(logTargetHref(target.key));

  const picker = <LogTargetPicker targets={targets} value={target.key} />;

  if (target.kind === "database") {
    const db = databases.find((d) => d.id === target.key.slice("db:".length))!;
    const info = await getDatabaseLogsInfo(db.id);
    return (
      // Keyed per target: Next reuses this route segment when only the search
      // params change, so without it the SSE buffer and the container picker
      // would survive a switch and show one database's output under another's
      // name.
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

  // Which source opens decides whether the build seed is worth reading: the
  // pane defaults to Runtime whenever a container exists, and `BuildLogStream`
  // fills itself on its first poll, so seeding it there is a read nobody sees.
  const opensOnBuild = !(info?.streamable && info.instances.length > 0);
  const buildLogs = opensOnBuild && latest ? await getLogs(latest.id) : [];

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
        latestDeployment={
          latest ? { id: latest.id, status: latest.status } : null
        }
        initialBuildLogs={buildLogs}
        toolbar={picker}
      />
    </AppLiveStatusProvider>
  );
}
