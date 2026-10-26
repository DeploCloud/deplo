import "server-only";

import { and, eq, isNotNull } from "drizzle-orm";

import { getDb } from "../db/client";
import { memberships } from "../db/schema/control-plane/access-control";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { listInstallationRepos, listRepoBranches } from "../github/app";
import { providerFor } from "../git/providers/registry";
import type { RepoSummary } from "../git/providers/types";
import { getCurrentUser } from "../auth/current-user";
import {
  getActiveTeamId,
  hasCapability,
  reachesWholeTeam,
  requireMembership,
} from "../membership";
import type { GitRepo } from "../types/build";
import { listGithubInstallations } from "./github";
import {
  listGitBranches,
  listGitConnections,
  listGitRepos,
} from "./git-connections";

export interface NewRepo {
  provider: GitRepo["provider"];
  fullName: string;
  name: string;
  defaultBranch: string;
  url: string;
  private: boolean;
  createdAt: string;
  installationId: string | null;
  connectionId: string | null;
}

const WINDOW_MS = 7 * 24 * 60 * 60_000;
const MAX_CARDS = 3;
const CACHE_TTL_MS = 5 * 60_000;
// ponytail: max 10 probes per source, a queue if a team creates dozens of repos a week
const MAX_PROBES = 10;

export const repoKey = (provider: string, fullName: string): string =>
  `${provider}:${fullName}`.toLowerCase();

const isRecent = (createdAt: string, now: number): boolean =>
  now - Date.parse(createdAt) <= WINDOW_MS;

export function pickNewRepos(
  repos: NewRepo[],
  linked: ReadonlySet<string>,
  now: number,
): NewRepo[] {
  return repos
    .filter(
      (r) =>
        isRecent(r.createdAt, now) &&
        !linked.has(repoKey(r.provider, r.fullName)),
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, MAX_CARDS);
}

interface Source {
  id: string;
  list: () => Promise<RepoSummary[]>;
  branches: (fullName: string) => Promise<string[]>;
  toRepo: (r: RepoSummary) => NewRepo;
}

const cached = new Map<string, { value: NewRepo[]; expiresAt: number }>();

// A recent repo with no branch has no commit yet, and its first deploy would fail.
async function recentPushedRepos(source: Source): Promise<NewRepo[]> {
  const hit = cached.get(source.id);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  let value: NewRepo[] = [];
  try {
    const now = Date.now();
    const recent = (await source.list())
      .filter((r) => r.createdAt && isRecent(r.createdAt, now))
      .slice(0, MAX_PROBES);
    const probed = await Promise.all(
      recent.map(async (r) =>
        (await source.branches(r.fullName).catch(() => [])).length > 0
          ? source.toRepo(r)
          : null,
      ),
    );
    value = probed.filter((r): r is NewRepo => r !== null);
  } catch {}
  cached.set(source.id, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

export async function suggestNewReposEnabled(): Promise<boolean> {
  const user = await getCurrentUser();
  const teamId = await getActiveTeamId();
  if (!user || !teamId) return false;
  const row = (
    await getDb()
      .select({ on: memberships.suggestNewRepos })
      .from(memberships)
      .where(
        and(eq(memberships.userId, user.id), eq(memberships.teamId, teamId)),
      )
      .limit(1)
  )[0];
  return row?.on ?? false;
}

// A personal preference: it changes what this member sees, nothing anyone else does.
export async function setSuggestNewRepos(enabled: boolean): Promise<boolean> {
  const { userId, teamId } = await requireMembership();
  const updated = await getDb()
    .update(memberships)
    .set({ suggestNewRepos: enabled })
    .where(and(eq(memberships.userId, userId), eq(memberships.teamId, teamId)))
    .returning({ id: memberships.id });
  if (updated.length === 0) throw new Error("Not a member of this team");
  return enabled;
}

export async function listNewRepos(): Promise<NewRepo[]> {
  if (!(await suggestNewReposEnabled())) return [];
  const [wide, canCreate, canDeploy] = await Promise.all([
    reachesWholeTeam(),
    hasCapability("create_apps"),
    hasCapability("deploy_apps"),
  ]);
  if (!wide || !canCreate || !canDeploy) return [];

  const teamId = (await getActiveTeamId())!;
  const [installations, connections, linkedRows] = await Promise.all([
    listGithubInstallations(),
    listGitConnections(),
    getDb()
      .select({ provider: appsTable.repoProvider, repo: appsTable.repoRepo })
      .from(appsTable)
      .where(and(eq(appsTable.teamId, teamId), isNotNull(appsTable.repoRepo))),
  ]);

  const sources: Source[] = [
    ...installations.map((i): Source => ({
      id: `gh:${i.id}`,
      list: () => listInstallationRepos(i.id),
      branches: (fullName) => listRepoBranches(i.id, fullName),
      toRepo: (r) => ({
        ...summaryFields(r),
        provider: "github",
        url: `https://github.com/${r.fullName}`,
        installationId: i.id,
        connectionId: null,
      }),
    })),
    ...connections
      .filter((c) => providerFor(c.provider).api)
      .map((c): Source => ({
        id: `git:${c.id}`,
        list: () => listGitRepos(c.id),
        branches: (fullName) => listGitBranches(c.id, fullName),
        toRepo: (r) => ({
          ...summaryFields(r),
          provider: c.provider as GitRepo["provider"],
          url: r.url,
          installationId: null,
          connectionId: c.id,
        }),
      })),
  ];

  const found = (await Promise.all(sources.map(recentPushedRepos))).flat();
  const linked = new Set(
    linkedRows.map((r) => repoKey(r.provider ?? "", r.repo ?? "")),
  );
  return pickNewRepos(found, linked, Date.now());
}

function summaryFields(r: RepoSummary) {
  return {
    fullName: r.fullName,
    name: r.name,
    defaultBranch: r.defaultBranch,
    private: r.private,
    createdAt: r.createdAt,
  };
}
