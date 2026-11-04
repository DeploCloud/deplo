"use client";

import { useParams } from "next/navigation";
import { ArrowLeft, Plus } from "lucide-react";
import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import { Bone } from "@/components/ui/skeleton";
import {
  DomainTableFrame,
  DomainsIntro,
} from "@/components/domains/domain-table";
import { DomainRowSkeleton } from "@/components/domains/domain-row";
import { EnvManager } from "@/components/env/env-manager";
import {
  PreviewsTableSkeleton,
  PullRequestsIntro,
} from "@/components/apps/previews/previews-table";
import { SettingsShortcut } from "@/components/shared/settings-shortcut";
import { useAppNav } from "@/components/apps/app-nav-store";
import {
  PreviewsNeedGithub,
  PreviewsOff,
} from "@/components/apps/previews/previews-unavailable";
import {
  AppActivityHeader,
  AppMonitoringHeader,
} from "@/components/apps/app-tab-headers";
import { HostChip } from "@/components/monitoring/host-chip";
import { ContainerMonitoringSkeleton } from "@/components/monitoring/container-monitoring-skeleton";
import { ScopedActivitySkeleton } from "@/components/activity/scoped-activity-skeleton";
import { CronJobsListSkeleton } from "@/components/crons/cron-jobs-list";
import { BackupsPanelSkeleton } from "@/components/storage/backups-panel/backups-panel";
import { ContainerLogsSkeleton } from "@/components/apps/container-logs";
import { LiveConsoleSkeleton } from "@/components/apps/live-console";
import { ProductionDeploymentCardSkeleton } from "@/components/apps/production-deployment-card";
import { RecentDeploymentsSkeleton } from "@/components/apps/recent-deployments";
import { DeploymentDetailsCardSkeleton } from "@/components/apps/deployment-details";
import { DeploymentSectionsSkeleton } from "@/components/apps/deployment-sections";
import { DeploymentShortcuts } from "@/components/apps/deployment-details";
import { DeploymentsTableSkeleton } from "@/components/apps/deployments-table/deployments-table";
import { DeploymentHistoryHeader } from "@/components/apps/deployment-history-header";

function useSlug() {
  return useParams<{ slug: string }>().slug;
}

export function AppOverviewSkeleton() {
  return (
    <div aria-busy className="space-y-6">
      <ProductionDeploymentCardSkeleton />
      <RecentDeploymentsSkeleton />
    </div>
  );
}

export function DeploymentsSkeleton() {
  const slug = useSlug();
  return (
    <div aria-busy className="space-y-4">
      <DeploymentsTableSkeleton
        header={<DeploymentHistoryHeader />}
        actions={
          <SettingsShortcut
            href={`/apps/${slug}/settings/deployments`}
            label="Deployment settings"
          />
        }
        scopeAppId="loading"
      />
    </div>
  );
}

export function DeploymentDetailSkeleton() {
  const slug = useSlug();
  return (
    <div aria-busy className="space-y-4">
      <Button
        variant="ghost"
        size="sm"
        asChild
        className="-ml-2 text-muted-foreground"
      >
        <Link href={`/apps/${slug}/deployments`}>
          <ArrowLeft className="size-4" />
          Back to deployments
        </Link>
      </Button>
      <DeploymentDetailsCardSkeleton />
      <DeploymentSectionsSkeleton />
      <DeploymentShortcuts
        slug={slug}
        show={{
          logs: true,
          monitoring: true,
          console: true,
          environment: true,
        }}
      />
    </div>
  );
}

export function DomainsSkeleton() {
  return (
    <div aria-busy className="space-y-4">
      <DomainsIntro
        action={
          <Bone box>
            <Button size="sm" disabled>
              <Plus className="size-4" />
              Add Domain
            </Button>
          </Bone>
        }
      />
      <DomainTableFrame showContainer={false}>
        <DomainRowSkeleton />
      </DomainTableFrame>
    </div>
  );
}

export function EnvironmentSkeleton() {
  return (
    <div aria-busy className="space-y-6">
      <EnvManager
        loading
        appId=""
        vars={[]}
        sharedVars={[]}
        sharedVarDetails={[]}
        canCreateShared={false}
        apps={[]}
        projects={[]}
        environments={[]}
        teams={[]}
      />
    </div>
  );
}

export function PullRequestsSkeleton() {
  const slug = useSlug();
  const nav = useAppNav();
  // The layout already told the nav store whether this App can have previews at all.
  const known = nav?.slug === slug ? nav : null;
  const github = known?.isGithubApp ?? true;
  const canDeploy = known?.capabilities.includes("manage_previews") ?? true;
  return (
    <div aria-busy className="space-y-4">
      <PullRequestsIntro
        branch={<Bone>main</Bone>}
        actions={
          <>
            <SettingsShortcut
              href={`/apps/${slug}/settings/pull-requests`}
              label="Pull request settings"
            />
            {github && canDeploy && (
              <Bone box>
                <Button variant="outline" size="sm" disabled>
                  <Plus className="size-4" />
                  New preview
                </Button>
              </Bone>
            )}
          </>
        }
      />
      {!github ? (
        <PreviewsNeedGithub slug={slug} />
      ) : known && !known.previewsEnabled ? (
        <PreviewsOff slug={slug} />
      ) : (
        <PreviewsTableSkeleton />
      )}
    </div>
  );
}

export function MonitoringSkeleton() {
  const slug = useSlug();
  return (
    <div aria-busy className="space-y-5">
      <AppMonitoringHeader
        actions={
          <div className="flex items-center gap-2">
            <Bone box>
              <HostChip serverId="" serverName="my-server" canManage />
            </Bone>
            <SettingsShortcut
              href={`/apps/${slug}/settings/resources`}
              label="Resource limits"
            />
          </div>
        }
      />
      <ContainerMonitoringSkeleton />
    </div>
  );
}

export function ActivitySkeleton() {
  return (
    <div aria-busy className="space-y-5">
      <AppActivityHeader />
      <ScopedActivitySkeleton />
    </div>
  );
}

// Wrapped like the page wraps LiveLogs.
export function LogsSkeleton() {
  const slug = useSlug();
  return (
    <div aria-busy className="flex min-h-0 flex-1 flex-col">
      <ContainerLogsSkeleton
        title={{ label: "App name", href: `/apps/${slug}` }}
      />
    </div>
  );
}

// The content of the App tab at `tab` (the path after the App's root), as its loading state draws it.
export function AppTabSkeleton({ tab }: { tab: string }) {
  const slug = useSlug();
  if (tab === "" || tab === "/") return <AppOverviewSkeleton />;
  if (tab === "/deployments") return <DeploymentsSkeleton />;
  if (/^\/deployments\/[^/]+\/?$/.test(tab))
    return <DeploymentDetailSkeleton />;
  if (tab === "/domains") return <DomainsSkeleton />;
  if (tab === "/environment") return <EnvironmentSkeleton />;
  if (tab === "/pull-requests") return <PullRequestsSkeleton />;
  if (tab === "/monitoring") return <MonitoringSkeleton />;
  if (tab === "/activity") return <ActivitySkeleton />;
  if (tab === "/cron-jobs") return <CronJobsListSkeleton />;
  if (tab === "/backups") return <BackupsPanelSkeleton kind="app" />;
  if (tab === "/logs") return <LogsSkeleton />;
  if (tab === "/console") return <LiveConsoleSkeleton slug={slug} />;
  return null;
}
