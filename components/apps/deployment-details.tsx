import * as React from "react";
import {
  Activity,
  Braces,
  CircleCheck,
  CircleX,
  Clock,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Globe,
  Hammer,
  Logs,
  Rocket,
  Server,
  SquareTerminal,
  TriangleAlert,
} from "lucide-react";
import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusBadge, StatusDot } from "@/components/shared/status-badge";
import { DeploymentCreator } from "@/components/apps/deployment-creator";
import { CommitLink } from "@/components/apps/commit-link";
import { FrameworkBadge } from "@/components/apps/framework-badge";
import { BuildDuration } from "@/components/apps/build-duration";
import { RollbackButton } from "@/components/apps/rollback-deployment";
import { DetailRow, DetailRows } from "@/components/apps/detail-rows";
import { WithCover } from "@/components/apps/deployment-cover";
import type { AppSourceDescriptor } from "@/components/apps/app-source";
import type { Deployment } from "@/lib/types/deployment";
import type { DomainStatus } from "@/lib/types/domain";
import { cn, timeAgoShort } from "@/lib/utils";

const row = "flex min-w-0 items-center gap-1.5";
const icon = "size-3.5 shrink-0 text-muted-foreground";

const STATUS_LABEL: Record<Deployment["status"], string> = {
  ready: "Ready",
  building: "Building",
  queued: "Queued",
  error: "Error",
  canceled: "Canceled",
};

export type DeploymentSetting = { label: string; on: boolean; href: string };
export type DeploymentDomain = { host: string; status: DomainStatus | null };

// A preview's host carries no status; a domain behind Cloudflare or a proxy is a working one.
export const domainServes = (status: DomainStatus | null) =>
  !status || status === "valid" || status === "cloudflare";

function Cell({
  label,
  wide,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0", wide && "sm:col-span-2 xl:col-span-4")}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1.5 text-sm">{children}</div>
    </div>
  );
}

function SettingIcon({ on }: { on: boolean }) {
  return on ? (
    <CircleCheck className="size-4 shrink-0 fill-[var(--info)] text-background" />
  ) : (
    <CircleX className="size-4 shrink-0 fill-muted-foreground text-background" />
  );
}

export function DeploymentDetailsCard({
  slug,
  deployment: d,
  cover,
  source,
  prUrl,
  commitUrl,
  creatorUrl,
  domains,
  settings,
  canRollbackApps,
}: {
  slug: string;
  deployment: Deployment & {
    canRollback: boolean;
    rollbackRebuilds: boolean;
  };
  cover: React.ReactNode;
  source: AppSourceDescriptor;
  prUrl: string | null;
  commitUrl: string | null;
  creatorUrl: string | null;
  domains: DeploymentDomain[];
  settings: DeploymentSetting[];
  canRollbackApps: boolean;
}) {
  const [first, ...more] = domains;
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
        <p className="text-sm font-semibold">Deployment Details</p>
        <div className="flex items-center gap-2">
          {d.canRollback && (
            <RollbackButton
              id={d.id}
              appSlug={slug}
              commitSha={d.commitSha}
              commitMessage={d.commitMessage}
              rebuild={d.rollbackRebuilds}
              can={canRollbackApps}
            />
          )}
          <Button variant="outline" size="sm" asChild>
            <a href={d.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-4" />
              Visit
            </a>
          </Button>
        </div>
      </div>

      <div className="p-5">
        <WithCover cover={cover}>
          <div className="grid content-start gap-x-6 gap-y-5 sm:grid-cols-2 xl:grid-cols-4">
            <Cell label="Created">
              <span className={row}>
                <DeploymentCreator
                  creator={d.creator}
                  creatorUser={d.creatorUser}
                  creatorProvider={d.creatorProvider}
                  creatorUrl={creatorUrl}
                  className="font-medium"
                />
                <span className="shrink-0 text-muted-foreground">
                  {timeAgoShort(d.createdAt)}
                </span>
              </span>
            </Cell>
            <Cell label="Status">
              <span className={row}>
                <StatusDot status={d.status} />
                <span className="font-medium">{STATUS_LABEL[d.status]}</span>
              </span>
            </Cell>
            <Cell label="Duration">
              <span className={row}>
                <Clock className={icon} />
                <BuildDuration
                  status={d.status}
                  startedAt={d.startedAt}
                  buildDurationMs={d.buildDurationMs}
                  className="font-medium"
                />
              </span>
            </Cell>
            <Cell label="Environment">
              <span className={row}>
                <Rocket className={icon} />
                <span className="font-medium">
                  {d.environment === "production" ? "Production" : "Preview"}
                </span>
              </span>
            </Cell>
            {first && (
              <Cell label="Domains" wide>
                <a
                  href={`https://${first.host}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${row} w-fit max-w-full font-medium hover:underline`}
                >
                  {domainServes(first.status) ? (
                    <Globe className={icon} />
                  ) : (
                    <DomainAlert status={first.status} />
                  )}
                  <span className="truncate">{first.host}</span>
                  {more.length > 0 && (
                    <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[11px] leading-none text-secondary-foreground">
                      +{more.length}
                    </span>
                  )}
                </a>
              </Cell>
            )}
            <Cell label="Source" wide>
              <div className="space-y-1.5">
                {source.isGit ? (
                  <p className={row}>
                    <GitBranch className={icon} />
                    <span className="truncate font-mono text-[13px]">
                      {d.branch}
                    </span>
                    {d.prNumber != null && (
                      <span className={`${row} text-muted-foreground`}>
                        <GitPullRequest className="size-3.5 shrink-0" />
                        {prUrl ? (
                          <a
                            href={prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline"
                          >
                            #{d.prNumber}
                          </a>
                        ) : (
                          `#${d.prNumber}`
                        )}
                      </span>
                    )}
                  </p>
                ) : (
                  <p className={row}>
                    <source.Icon className={icon} />
                    <span className="truncate">{source.label}</span>
                  </p>
                )}
                <p className={row}>
                  <GitCommitHorizontal className={icon} />
                  {d.commitSha && (
                    <CommitLink
                      sha={d.commitSha}
                      url={commitUrl}
                      signature={d.commitSignature}
                      className="font-mono text-[13px]"
                    />
                  )}
                  <span className="truncate">{d.commitMessage}</span>
                </p>
              </div>
            </Cell>
          </div>
        </WithCover>
      </div>

      <DetailRows className="border-t border-border">
        <DetailRow
          value="settings"
          title="Deployment Settings"
          meta={
            <span className="hidden flex-wrap items-center gap-x-5 gap-y-1 md:flex">
              {settings.map((s) => (
                <span key={s.label} className={row}>
                  <SettingIcon on={s.on} />
                  <span className={s.on ? "" : "text-muted-foreground"}>
                    {s.label}
                  </span>
                </span>
              ))}
            </span>
          }
        >
          <ul className="divide-y divide-border">
            {settings.map((s) => (
              <li
                key={s.label}
                className="flex items-center gap-2 px-5 py-3 text-sm"
              >
                <SettingIcon on={s.on} />
                <span className="font-medium">{s.label}</span>
                <span className="text-muted-foreground">
                  {s.on ? "On" : "Off"}
                </span>
                <Link
                  href={`/apps/${slug}${s.href}`}
                  className="ml-auto text-muted-foreground hover:text-foreground"
                >
                  Manage
                </Link>
              </li>
            ))}
          </ul>
        </DetailRow>
      </DetailRows>
    </Card>
  );
}

export function DeploymentSummary({
  framework,
  method,
  serverName,
  buildServerName,
}: {
  framework: string | null;
  method: string;
  serverName: string | null;
  buildServerName: string | null;
}) {
  return (
    <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 xl:grid-cols-4">
      {framework && (
        <Cell label="Framework">
          <FrameworkBadge id={framework} className="font-medium" />
        </Cell>
      )}
      <Cell label="Built with">
        <span className={row}>
          <Hammer className={icon} />
          <span className="font-medium">{method}</span>
        </span>
      </Cell>
      {serverName && (
        <Cell label="Runs on">
          <span className={row}>
            <Server className={icon} />
            <span className="truncate font-medium">{serverName}</span>
          </span>
        </Cell>
      )}
      {buildServerName && (
        <Cell label="Built on">
          <span className={row}>
            <Server className={icon} />
            <span className="truncate font-medium">{buildServerName}</span>
          </span>
        </Cell>
      )}
    </div>
  );
}

// The same words the Domains page uses for a domain that does not answer yet.
const DOMAIN_HINT: Partial<Record<DomainStatus, string>> = {
  pending: "This domain doesn’t resolve yet.",
  misconfigured: "This domain’s DNS doesn’t point here.",
};

function DomainAlert({ status }: { status: DomainStatus | null }) {
  return (
    <TriangleAlert
      className={cn(
        "size-4 shrink-0",
        status === "pending" ? "text-[var(--warning)]" : "text-destructive",
      )}
    />
  );
}

export function DeploymentDomainsMeta({
  domains,
}: {
  domains: DeploymentDomain[];
}) {
  const broken = domains.filter((d) => !domainServes(d.status));
  if (broken.length === 0)
    return (
      <>
        <span className="text-muted-foreground">
          {domains.length === 1 ? "1 domain" : `${domains.length} domains`}
        </span>
        <CircleCheck className="size-5 shrink-0 fill-[var(--info)] text-background" />
      </>
    );
  const worst = broken.find((d) => d.status !== "pending") ?? broken[0]!;
  return (
    <>
      <span className="text-muted-foreground">
        {broken.length === 1
          ? "1 needs attention"
          : `${broken.length} need attention`}
      </span>
      <DomainAlert status={worst.status} />
    </>
  );
}

export function DeploymentDomainList({
  slug,
  domains,
  manageHref,
}: {
  slug: string;
  domains: DeploymentDomain[];
  manageHref: string;
}) {
  return (
    <ul className="divide-y divide-border">
      {domains.map((x) => {
        const ok = domainServes(x.status);
        const hint = x.status && DOMAIN_HINT[x.status];
        return (
          <li
            key={x.host}
            className="flex items-center gap-2 px-5 py-3 text-sm"
          >
            {ok ? (
              <CircleCheck className="size-4 shrink-0 fill-[var(--success)] text-background" />
            ) : (
              <DomainAlert status={x.status} />
            )}
            <a
              href={`https://${x.host}`}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate font-medium hover:underline"
            >
              {x.host}
            </a>
            {!ok && hint && (
              <span className="hidden truncate text-muted-foreground sm:inline">
                {hint}
              </span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-3">
              {!ok && x.status && <StatusBadge status={x.status} />}
              <Link
                href={`/apps/${slug}${manageHref}`}
                className="text-muted-foreground hover:text-foreground"
              >
                Manage
              </Link>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const SHORTCUTS = [
  {
    key: "logs",
    title: "Runtime Logs",
    line: "See what the app prints while it runs",
    Icon: Logs,
  },
  {
    key: "monitoring",
    title: "Monitoring",
    line: "Live CPU and memory use",
    Icon: Activity,
  },
  {
    key: "console",
    title: "Console",
    line: "Run a command inside the live app",
    Icon: SquareTerminal,
  },
  {
    key: "environment",
    title: "Environment Variables",
    line: "The values this app runs with",
    Icon: Braces,
  },
] as const;

export type ShortcutKey = (typeof SHORTCUTS)[number]["key"];

export function DeploymentShortcuts({
  slug,
  show,
}: {
  slug: string;
  show: Record<ShortcutKey, boolean>;
}) {
  const items = SHORTCUTS.filter((s) => show[s.key]);
  if (items.length === 0) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]">
      {items.map((s) => (
        <Link
          key={s.key}
          href={`/apps/${slug}/${s.key}`}
          className="group flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3.5 hover:bg-surface"
        >
          <s.Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
          <span className="min-w-0">
            <span className="block text-sm font-medium">{s.title}</span>
            <span className="mt-1 block truncate text-xs text-muted-foreground">
              {s.line}
            </span>
          </span>
        </Link>
      ))}
    </div>
  );
}
