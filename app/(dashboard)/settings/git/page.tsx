import { githubAppsPreviewReadiness, listGithubApps } from "@/lib/data/github";
import { PageHeader } from "@/components/shared/page-header";
import { GithubPanel } from "@/components/settings/github-panel";

export const metadata = { title: "Settings · Git" };

export default async function SettingsGitPage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await props.searchParams;
  // One-shot status from the GitHub OAuth-style redirect (?git=connected|error).
  const gitStatus = Array.isArray(sp.git) ? sp.git[0] : sp.git;
  const githubApps = await listGithubApps();
  // Whether each App can drive pull request previews. Read live; an App that
  // cannot be checked simply gets no entry and no warning.
  const previewReadiness = await githubAppsPreviewReadiness();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Git"
        description="Connect GitHub apps for repository access and auto-deploys."
      />
      <GithubPanel
        apps={githubApps}
        gitStatus={gitStatus}
        previewReadiness={previewReadiness}
      />
    </div>
  );
}
