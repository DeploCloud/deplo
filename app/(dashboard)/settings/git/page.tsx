import { reachesWholeTeam } from "@/lib/membership";
import { githubAppsPreviewReadiness, listGithubApps } from "@/lib/data/github";
import { listGitConnections } from "@/lib/data/git-connections";
import { PROVIDERS, tokenHelpUrl } from "@/lib/git/providers";
import type { GitProviderId } from "@/lib/types";
import { PageHeader } from "@/components/shared/page-header";
import { OutsideYourAccess } from "@/components/shared/outside-your-access";
import { GithubPanel } from "@/components/settings/github-panel";
import { GitConnectionsPanel } from "@/components/settings/git-connections-panel";

export const metadata = { title: "Settings · Git" };

export default async function SettingsGitPage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await props.searchParams;
  // One-shot status from the GitHub OAuth-style redirect (?git=connected|error).
  const gitStatus = Array.isArray(sp.git) ? sp.git[0] : sp.git;
  if (!(await reachesWholeTeam()))
    return (
      <OutsideYourAccess
        title="Git"
        description="Connect the hosts your code lives on, for imports and auto-deploys."
        what="Git connections"
      />
    );
  const githubApps = await listGithubApps();
  // Whether each App can drive pull request previews. Read live; an App that
  // cannot be checked simply gets no entry and no warning.
  const previewReadiness = await githubAppsPreviewReadiness();
  const connections = await listGitConnections();
  // The provider catalogue is static, so it is passed down rather than fetched:
  // one fewer round trip before the connect dialog can render.
  const providers = (Object.keys(PROVIDERS) as GitProviderId[]).map((id) => ({
    id,
    label: PROVIDERS[id].label,
    defaultBaseUrl: PROVIDERS[id].defaultBaseUrl,
    defaultUsername: PROVIDERS[id].defaultUsername,
    tokenScopes: PROVIDERS[id].tokenScopes,
    hasApi: PROVIDERS[id].api != null,
    tokenHelpUrl: tokenHelpUrl(id, PROVIDERS[id].defaultBaseUrl ?? ""),
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Git"
        description="Connect the hosts your code lives on, for imports and auto-deploys."
      />
      <GithubPanel
        apps={githubApps}
        gitStatus={gitStatus}
        previewReadiness={previewReadiness}
      />
      <GitConnectionsPanel connections={connections} providers={providers} />
    </div>
  );
}
