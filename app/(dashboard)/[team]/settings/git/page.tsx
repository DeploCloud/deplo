import { isInstanceAdmin, reachesWholeTeam } from "@/lib/membership";
import {
  githubAppsAccess,
  listGithubApps,
  teamUsesPreviews,
} from "@/lib/data/github";
import { listGitConnections } from "@/lib/data/git-connections";
import { PROVIDERS, tokenHelpUrl } from "@/lib/git/providers/registry";
import { tokenScopesLine } from "@/lib/git/provider-access";
import type { GitProviderId } from "@/lib/types/git";
import { OutsideYourAccess } from "@/components/shared/outside-your-access";
import { safeReturnPath } from "@/lib/utils";
import { GitPanel } from "@/components/settings/git-panel";

export const metadata = { title: "Settings · Git" };

export default async function SettingsGitPage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await props.searchParams;
  const next = safeReturnPath(Array.isArray(sp.next) ? sp.next[0] : sp.next);
  if (!(await reachesWholeTeam()))
    return (
      <OutsideYourAccess
        title="Git"
        description="Connect the hosts your code lives on, for imports and auto-deploys."
        what="Git connections"
      />
    );
  const githubApps = await listGithubApps();
  const appAccess = await githubAppsAccess({
    previews: await teamUsesPreviews(),
  });
  const connections = await listGitConnections();
  const providers = (Object.keys(PROVIDERS) as GitProviderId[]).map((id) => ({
    id,
    label: PROVIDERS[id].label,
    defaultBaseUrl: PROVIDERS[id].defaultBaseUrl,
    defaultUsername: PROVIDERS[id].defaultUsername,
    tokenScopes: tokenScopesLine(id),
    hasApi: PROVIDERS[id].api != null,
    tokenHelpUrl: tokenHelpUrl(id, PROVIDERS[id].defaultBaseUrl ?? ""),
  }));

  return (
    <GitPanel
      githubApps={githubApps}
      connections={connections}
      providers={providers}
      appAccess={appAccess}
      next={next}
      isInstanceAdmin={await isInstanceAdmin()}
    />
  );
}
