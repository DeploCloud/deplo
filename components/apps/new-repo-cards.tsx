import { listNewRepos } from "@/lib/data/new-repos";
import { NewRepoCard } from "./new-repo-card";

export async function NewRepoCards({
  teamId,
  view,
  className,
}: {
  teamId: string;
  view: "grid" | "list";
  className?: string;
}) {
  const repos = await listNewRepos().catch(() => []);
  if (repos.length === 0) return null;
  const cards = repos.map((repo) => (
    <NewRepoCard
      key={`${repo.provider}:${repo.fullName}`}
      repo={repo}
      teamId={teamId}
      view={view}
    />
  ));
  return className ? <div className={className}>{cards}</div> : cards;
}
