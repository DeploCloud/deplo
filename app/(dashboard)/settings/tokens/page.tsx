// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

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
import { TokenGraphic } from "@/components/settings/tokens/token-graphic";

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
        docs="tokens.overview"
        title="API tokens"
        description="Tokens that let scripts, CI jobs and other clients call the API. Each one carries its own permissions."
        actions={canManage ? <NewTokenMenu /> : undefined}
      />

      {tokens.length === 0 ? (
        <EmptyState
          graphic={<TokenGraphic />}
          title="No API tokens yet"
          docs="tokens.overview"
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
