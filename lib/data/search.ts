import "server-only";

import { assertUser } from "../auth";
import { currentIdentity, runWithIdentity } from "../auth/request-context";
import type { AppStatus, DatabaseStatus, DatabaseType, ID } from "../types";
import { listApps } from "./apps";
import { listDatabases } from "./databases";
import { foldQuery, matchesQuery } from "./match-query";
import { listMyTeams } from "./teams";

/**
 * Find an app or a database by name, slug or id, across every team the caller
 * can reach.
 *
 * This is the ONE read in deplo that spans teams, and the way it does so is the
 * whole point: it runs the ordinary per-team reads once per team, inside that
 * team's identity, instead of asking the database a single cross-team question.
 * That keeps every gate exactly where it already is - the token's project scope
 * (`inAppScope`), per-folder access, `requireTeamWide` for a narrowed token, the
 * team's two-factor policy - and adds no authorization code of its own. A
 * hand-written `where team_id in (…)` would have to re-implement all four, which
 * is the second authorization path `lib/mcp/execute.ts` exists to avoid.
 *
 * Why it exists at all: a person has the team switcher, but an API client and an
 * AI agent have neither that nor eyes. Without this, "which team is the
 * better-auth app in?" is answered by listing every app in every team and
 * grepping the result in the caller's own context window.
 */

/** The team a hit was found in - what the caller actually asked for. */
export interface SearchTeam {
  id: ID;
  name: string;
  slug: string;
}

/** Enough to recognise an app and to call `getApp`/`app(slug:)` next. */
export interface SearchApp {
  id: ID;
  name: string;
  slug: string;
  status: AppStatus;
  productionUrl: string | null;
  team: SearchTeam;
}

export interface SearchDatabase {
  id: ID;
  name: string;
  type: DatabaseType;
  status: DatabaseStatus;
  team: SearchTeam;
}

export interface SearchResults {
  apps: SearchApp[];
  databases: SearchDatabase[];
}

/**
 * The most results one search may answer with, per kind.
 *
 * A search is meant to end in a name, not in a listing: a caller that wants the
 * whole team reads `apps`. The cap matters because the caller with the strongest
 * reason to search is an AI agent, and a two-letter query across a big instance
 * would otherwise return every app it can see.
 */
const MAX_HITS = 50;

/**
 * Run a team-scoped read as this caller, in `teamId`, answering `[]` when that
 * team refuses.
 *
 * Refusal is a normal outcome here and not an error to surface: a team under an
 * unmet two-factor policy, or a project-scoped token that `requireTeamWide`
 * turns away, must simply contribute nothing to the results - the same answer
 * the caller would get by switching to that team in the UI. Skipping it is what
 * keeps one such team from failing the whole search.
 */
async function inTeam<T>(teamId: ID, read: () => Promise<T[]>): Promise<T[]> {
  const identity = currentIdentity();
  const user = await assertUser();
  try {
    return await runWithIdentity(
      // The token grant rides along untouched when there is one, so a bearer
      // client stays clamped in every team it reaches. A cookie session has no
      // grant and is unclamped, exactly as it is anywhere else.
      { ...(identity ?? {}), userId: user.id, teamId },
      read,
    );
  } catch {
    return [];
  }
}

export async function search(query: string): Promise<SearchResults> {
  const empty: SearchResults = { apps: [], databases: [] };
  if (!foldQuery(query)) return empty;

  // Already clamped to the teams a bearer token's scope names, so a token that
  // reaches one team searches one team.
  const teams = await listMyTeams();

  const found = await Promise.all(
    teams.map(async (t) => {
      const team: SearchTeam = { id: t.id, name: t.name, slug: t.slug };
      const [apps, databases] = await Promise.all([
        inTeam(t.id, listApps),
        inTeam(t.id, listDatabases),
      ]);
      // The `teamId` check is belt and braces, and worth the line: the reads
      // resolve their team through `requireActiveTeamId`, a React `cache()`.
      // That is a pass-through in a route handler (no async dispatcher outside a
      // render), which is why each iteration really does resolve `t.id` - but
      // inside an RSC render it WOULD memoize, and every team after the first
      // would answer with the first one's rows under another team's name.
      // Keeping only rows that belong to `t.id` means such a caller can get a
      // short answer, never a wrong one.
      return {
        apps: apps
          .filter((a) => a.teamId === t.id)
          .filter((a) => matchesQuery(query, a.name, a.slug, a.id))
          .map((a) => ({
            id: a.id,
            name: a.name,
            slug: a.slug,
            status: a.status,
            productionUrl: a.productionUrl,
            team,
          })),
        databases: databases
          .filter((d) => d.teamId === t.id)
          .filter((d) => matchesQuery(query, d.name, d.id))
          .map((d) => ({
            id: d.id,
            name: d.name,
            type: d.type,
            status: d.status,
            team,
          })),
      };
    }),
  );

  return {
    apps: found.flatMap((f) => f.apps).slice(0, MAX_HITS),
    databases: found.flatMap((f) => f.databases).slice(0, MAX_HITS),
  };
}
