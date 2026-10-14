import "server-only";

import { withoutRequestCache } from "./request-cache";

// The caps and access re-checks shared by the live log and console session stores.
export interface LiveSessionOwner {
  appId: string;
  teamId: string;
  userId: string;
  // Re-run on a timer long after the request that opened the session, so it never reads a cookie.
  authorize: () => Promise<boolean>;
}

type Held = LiveSessionOwner & { id: string };

const MAX_SESSIONS = 64;
const MAX_SESSIONS_PER_TEAM = 32;
const MAX_SESSIONS_PER_USER = 16;
const MAX_SESSIONS_PER_APP = 8;
const RECHECK_MS = 15_000;

export class SessionLimitError extends Error {}

// Room comes from the caller's own sessions first, then from the team holding the most, so a few people never lock out everyone else.
export function makeRoom<S extends Held>(
  sessions: Map<string, S>,
  want: Omit<LiveSessionOwner, "authorize">,
  evict: (s: S) => void,
): void {
  const held = () => [...sessions.values()];
  const mine = () => held().filter((s) => s.userId === want.userId);
  const sameApp = mine().filter((s) => s.appId === want.appId);
  if (sameApp.length >= MAX_SESSIONS_PER_APP) evict(sameApp[0]);
  else if (mine().length >= MAX_SESSIONS_PER_USER) evict(mine()[0]);

  const team = held().filter((s) => s.teamId === want.teamId);
  if (team.length >= MAX_SESSIONS_PER_TEAM) {
    const own = team.find((s) => s.userId === want.userId);
    if (!own)
      throw new SessionLimitError(
        "Your team has too many live sessions open. Close one and try again.",
      );
    evict(own);
  }
  if (sessions.size < MAX_SESSIONS) return;

  const own = mine()[0];
  if (own) return evict(own);
  const byTeam = new Map<string, S[]>();
  for (const s of held())
    byTeam.set(s.teamId, [...(byTeam.get(s.teamId) ?? []), s]);
  const heaviest = [...byTeam.values()].reduce(
    (a, b) => (b.length > a.length ? b : a),
    [],
  );
  if (heaviest.length > team.length) return evict(heaviest[0]);
  throw new SessionLimitError(
    "Too many live sessions on this Deplo right now. Try again in a moment.",
  );
}

// Re-checks every session's access every RECHECK_MS and hands the ones that lost it to `lost`.
export function accessSweep<S extends Held>(
  sessions: Map<string, S>,
  lost: (s: S) => void,
): () => Promise<void> {
  let running: Promise<void> | null = null;
  const check = async () => {
    await Promise.all(
      [...sessions.values()].map(async (s) => {
        const ok = await withoutRequestCache(s.authorize).catch(() => false);
        if (!ok && sessions.get(s.id) === s) lost(s);
      }),
    );
  };
  const sweep = () =>
    (running ??= check().finally(() => {
      running = null;
    }));
  setInterval(() => void sweep(), RECHECK_MS).unref();
  return sweep;
}
