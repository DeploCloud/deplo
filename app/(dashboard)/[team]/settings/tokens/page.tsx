import { reachesWholeTeam, requireActiveTeamId } from "@/lib/membership";
import { listTokens } from "@/lib/data/tokens/listing";
import { listProjects } from "@/lib/data/projects/read";
import { listApps } from "@/lib/data/apps/listing";
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
  if (!(await reachesWholeTeam()))
    return (
      <OutsideYourAccess
        title="API tokens"
        description="Your personal tokens that let scripts, CI jobs and AI agents call the API. Each one carries its own permissions."
        what="API tokens"
      />
    );

  const [tokens, projects, folders, apps, teams, activeTeamId] =
    await Promise.all([
      listTokens(),
      listProjects(),
      listFolders(),
      listApps(),
      listMyTeams(),
      requireActiveTeamId(),
    ]);
  const names = Object.fromEntries(
    [...teams, ...projects, ...folders, ...apps].map((n) => [n.id, n.name]),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        docs="tokens.overview"
        title="API tokens"
        description="Your personal tokens that let scripts, CI jobs and AI agents call the API. Each one carries its own permissions."
        actions={<NewTokenMenu />}
      />

      {tokens.length === 0 ? (
        <EmptyState
          graphic={<TokenGraphic />}
          title="No API tokens yet"
          docs="tokens.overview"
          description="A token lets a script, a CI job or an AI agent act as you, in the teams that allow it. Start from a template and give it only the permissions it needs."
        />
      ) : (
        <TokensList tokens={tokens} names={names} activeTeamId={activeTeamId} />
      )}
    </div>
  );
}
