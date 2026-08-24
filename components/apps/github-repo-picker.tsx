"use client";

import * as React from "react";
import Link from "next/link";
import {
  ChevronsUpDown,
  Check,
  Plus,
  SlidersHorizontal,
  Building2,
  User as UserIcon,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FieldLabel } from "@/components/ui/info-tip";
import { GitHubIcon } from "@/components/shared/brand-icons";
import { useGithubConnect } from "@/components/apps/github-connect-button";
import {
  RepoBrowser,
  type RepoSelection,
} from "@/components/apps/repo-browser";
import { cn, pickerInstallationId } from "@/lib/utils";
import type { GithubInstallationDTO } from "@/lib/data/github";

export interface GithubSelection {
  installationId: string;
  fullName: string;
  branch: string;
}

/** GitHub's per-installation "configure repository access" settings page. */
function installationSettingsUrl(inst: GithubInstallationDTO): string {
  return inst.accountType === "Organization"
    ? `https://github.com/organizations/${inst.accountLogin}/settings/installations/${inst.installationId}`
    : `https://github.com/settings/installations/${inst.installationId}`;
}

/**
 * How an installation reads in the switcher: the connected GitHub App's name
 * first (that's what decides which repositories are reachable — the same
 * account can host several Apps with different access), with the account it is
 * installed on as muted context, since one App can also be installed on more
 * than one account.
 */
function InstallationLabel({ inst }: { inst: GithubInstallationDTO }) {
  return (
    <span className="min-w-0 flex-1 truncate">
      <span className="font-medium">{inst.appName}</span>
      <span className="text-muted-foreground"> · {inst.accountLogin}</span>
    </span>
  );
}

/** A round GitHub account avatar with an initials fallback if the image fails. */
function AccountAvatar({
  inst,
  className,
}: {
  inst: GithubInstallationDTO;
  className?: string;
}) {
  return (
    <Avatar className={cn("size-5", className)}>
      <AvatarImage src={inst.avatarUrl} alt="" />
      <AvatarFallback className="text-[10px]">
        {inst.accountLogin.slice(0, 2).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

/** The connect-your-first-App empty state, shown when no App is connected yet. */
function ConnectPanel({
  connect,
  connecting,
}: {
  connect: () => void;
  connecting: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-6 text-center">
      <GitHubIcon className="size-6 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium">Connect GitHub to pick a repo</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Deplo creates a GitHub App with only the permissions it needs, then
          you pick which repositories it can access.
        </p>
      </div>
      <Button type="button" size="sm" onClick={connect} disabled={connecting}>
        <GitHubIcon className="size-4" />
        Connect GitHub
      </Button>
    </div>
  );
}

/**
 * Repo source picker for the GitHub deploy source (app settings + the new-app
 * wizard): choose the connected account, then pick a repository and branch.
 *
 * This component owns only the GitHub-specific half — WHICH App installation
 * you deploy through. Browsing the repositories is {@link RepoBrowser}, shared
 * with every other provider so they all behave identically.
 *
 * The account switcher is ALWAYS rendered — even with zero connected Apps — so
 * the layout never jumps and there's always an obvious path to connect or manage
 * Apps. `manageHref`, when set, adds a "Manage connected apps" affordance
 * linking to the team's GitHub settings.
 */
export function GithubRepoPicker({
  installations,
  initial,
  onChange,
  manageHref,
}: {
  installations: GithubInstallationDTO[];
  /**
   * Pre-select a repo/branch already attached to the app (settings flow).
   * The installation is matched by id; when it isn't among the connected
   * installations (the App was reinstalled, or the app was imported and never
   * had one) NOTHING is selected - the switcher says so rather than showing an
   * App the app does not actually deploy through.
   */
  initial?: {
    installationId?: string | null;
    fullName: string;
    branch: string;
  };
  onChange: (value: GithubSelection | null) => void;
  /** When set, show a "Manage connected apps" link pointing here (e.g. /settings/git). */
  manageHref?: string;
}) {
  const { connect, pending: connecting } = useGithubConnect();
  // Never seed an App the user did not choose: for an app that already has a
  // repo, falling back to the first one claims a connection the row does not
  // have. See `pickerInstallationId`.
  const [installationId, setInstallationId] = React.useState(() =>
    pickerInstallationId(initial, installations),
  );
  // An app that carries a repo but no App to reach it through. The row is legal
  // (a public repo clones anonymously) but it is almost never what was meant,
  // and until now nothing on this screen said so - the switcher simply showed
  // the first connected App as though it were linked.
  const unlinkedRepo = Boolean(
    initial && !installationId && installations.length > 0,
  );

  const activeInstallation =
    installations.find((i) => i.id === installationId) ?? null;
  const hasInstallations = installations.length > 0;

  const handleChange = React.useCallback(
    (sel: RepoSelection | null) => {
      // `installationId` is stitched on here, at the last moment, so a selection
      // must never bubble without one: that pair would be a credential the user
      // never picked.
      onChange(sel && installationId ? { installationId, ...sel } : null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [installationId],
  );

  return (
    <div className="space-y-3">
      {/* Connected App — always rendered so the layout is stable and there's
          always a path to switch, connect, or manage Apps, even with none
          connected. */}
      <div className="space-y-1.5">
        <FieldLabel
          className="text-sm font-medium"
          info="The connected GitHub App whose repositories you deploy from. Two Apps on the same account can reach different repositories, so the App is what you pick here. Switch App, connect another, or manage your connected apps."
        >
          GitHub App
        </FieldLabel>
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex min-w-0 flex-1 basis-64 items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left text-sm transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                {activeInstallation ? (
                  <>
                    <AccountAvatar inst={activeInstallation} />
                    <InstallationLabel inst={activeInstallation} />
                    {activeInstallation.accountType === "Organization" ? (
                      <Building2 className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <UserIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                  </>
                ) : (
                  <>
                    <GitHubIcon
                      className={cn(
                        "size-4 shrink-0",
                        hasInstallations
                          ? "text-[var(--warning)]"
                          : "text-muted-foreground",
                      )}
                    />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate",
                        hasInstallations
                          ? "text-[var(--warning)]"
                          : "text-muted-foreground",
                      )}
                    >
                      {hasInstallations
                        ? "Not connected - choose an App"
                        : "No connected apps"}
                    </span>
                  </>
                )}
                <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-64">
              {hasInstallations && (
                <>
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    Connected GitHub Apps
                  </DropdownMenuLabel>
                  {installations.map((i) => (
                    <DropdownMenuItem
                      key={i.id}
                      onSelect={() => setInstallationId(i.id)}
                      className="gap-2"
                    >
                      <AccountAvatar inst={i} />
                      <InstallationLabel inst={i} />
                      {i.id === installationId && (
                        <Check className="size-4 shrink-0 text-[var(--success)]" />
                      )}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem
                onSelect={() => connect()}
                disabled={connecting}
                className="gap-2"
              >
                <Plus className="size-4" />
                {hasInstallations
                  ? "Connect another GitHub App"
                  : "Connect GitHub"}
              </DropdownMenuItem>
              {manageHref && (
                <DropdownMenuItem asChild className="gap-2">
                  <Link href={manageHref}>
                    <SlidersHorizontal className="size-4" />
                    Manage connected apps
                  </Link>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {manageHref && (
            <Button variant="outline" size="sm" asChild>
              <Link href={manageHref}>
                <SlidersHorizontal className="size-4" />
                Manage connected apps
              </Link>
            </Button>
          )}
        </div>
      </div>

      {unlinkedRepo && initial && (
        <p className="rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/5 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {initial.fullName}
          </span>{" "}
          is not connected to a GitHub App here, so Deplo clones it anonymously
          and pushes cannot deploy it. Choose the App that can reach it, pick
          the repository, then Save.
        </p>
      )}

      {!hasInstallations ? (
        <ConnectPanel connect={connect} connecting={connecting} />
      ) : (
        <RepoBrowser
          kind="github"
          sourceId={installationId}
          initial={initial}
          onChange={handleChange}
          avatarUrl={activeInstallation?.avatarUrl ?? ""}
          avatarFallback={activeInstallation?.accountLogin}
          repoLinkLabel="Open repository on GitHub"
          emptyMessage={
            installationId
              ? "No repositories accessible to this App."
              : "Choose a GitHub App above to list its repositories."
          }
          emptyAction={
            activeInstallation && (
              <a
                href={installationSettingsUrl(activeInstallation)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                Configure repository access on GitHub
                <ExternalLink className="size-3" />
              </a>
            )
          }
        />
      )}
    </div>
  );
}
