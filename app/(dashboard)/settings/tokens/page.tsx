import Link from "next/link";
import { KeyRound, BookOpen, ArrowRight } from "lucide-react";
import {
  hasCapability,
  reachesWholeTeam,
  requireActiveTeamId,
} from "@/lib/membership";
import { listTokens } from "@/lib/data/tokens";
import { listProjects } from "@/lib/data/projects";
import { listApps } from "@/lib/data/apps";
import { listFolders } from "@/lib/data/folders";
import { listMyTeams } from "@/lib/data/teams";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { OutsideYourAccess } from "@/components/shared/outside-your-access";
import { NewTokenMenu } from "@/components/settings/tokens/new-token-menu";
import { TokensList } from "@/components/settings/tokens/tokens-list";

export const metadata = { title: "Settings · API tokens" };

export default async function TokensPage() {
  // The page sits under Account and lists every token you minted, whatever team
  // it acts in, plus the ones that can act in the active team, which is what
  // `listTokens` needs whole-team reach for. Nothing here survives without it.
  if (!(await reachesWholeTeam()))
    return (
      <OutsideYourAccess
        title="API tokens"
        description="Tokens that let scripts, CI jobs and other clients call the API. Each one carries its own permissions."
        what="API tokens"
      />
    );

  const [tokens, projects, folders, apps, teams, canManage, activeTeamId] =
    await Promise.all([
      listTokens(),
      listProjects(),
      listFolders(),
      listApps(),
      listMyTeams(),
      hasCapability("manage_tokens"),
      requireActiveTeamId(),
    ]);
  // A token can reach teams and apps this page can't name; `scopeLabel` falls
  // back to a count for anything missing here rather than showing a blank.
  const names = Object.fromEntries(
    [...teams, ...projects, ...folders, ...apps].map((n) => [n.id, n.name]),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="API tokens"
        description="Tokens that let scripts, CI jobs and other clients call the API. Each one carries its own permissions."
        actions={canManage ? <NewTokenMenu /> : undefined}
      />

      <Link
        href="/api-docs"
        className="group flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:border-primary/40 hover:bg-secondary/40"
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary">
          <BookOpen className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">API reference & playground</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Browse every GraphQL query and mutation, and try read-only calls
            live — mutations run as a safe dry run.
          </p>
        </div>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </Link>

      {tokens.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No API tokens yet"
          description={
            canManage
              ? "A token lets a script, a CI job or an assistant call this team's API. Start from one of our templates and give it only the permissions it needs."
              : "Only members who can manage API tokens can create one. Ask a team admin if you need API access."
          }
        />
      ) : (
        <TokensList
          tokens={tokens}
          names={names}
          activeTeamId={activeTeamId}
          canManage={canManage}
        />
      )}
    </div>
  );
}
