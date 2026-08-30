import { isInstanceAdmin, reachesWholeTeam } from "@/lib/membership";
import { githubAppsPreviewReadiness, listGithubApps } from "@/lib/data/github";
import { listGitConnections } from "@/lib/data/git-connections";
import { PROVIDERS, tokenHelpUrl } from "@/lib/git/providers";
import type { GitProviderId } from "@/lib/types";
import { OutsideYourAccess } from "@/components/shared/outside-your-access";
import { safeReturnPath } from "@/lib/utils";
import { GitPanel } from "@/components/settings/git-panel";

export const metadata = { title: "Settings · Git" };

export default async function SettingsGitPage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await props.searchParams;
  // The page that sent the user here to connect something (?next=), so the
  // detour can end where it started instead of on this page. The `?git=` flag
  // the GitHub redirects carry is handled in the app shell, for every page.
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

  // The page header lives inside the panel: its Connect menu and the connect
  // dialog are one interaction, so they have to share state.
  return (
    <GitPanel
      githubApps={githubApps}
      connections={connections}
      providers={providers}
      previewReadiness={previewReadiness}
      next={next}
      isInstanceAdmin={await isInstanceAdmin()}
    />
  );
}
