import { GitPanel } from "@/components/settings/git-panel";

export default function Loading() {
  return (
    <GitPanel
      loading
      githubApps={[]}
      connections={[]}
      providers={[]}
      isInstanceAdmin={false}
      suggestNewRepos={false}
    />
  );
}
