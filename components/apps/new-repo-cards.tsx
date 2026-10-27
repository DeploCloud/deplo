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
  const card = <NewRepoCard repos={repos} teamId={teamId} view={view} />;
  return className ? <div className={className}>{card}</div> : card;
}
