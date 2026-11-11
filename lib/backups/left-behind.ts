import { backupWhen } from "../databases/failover-copy";

// Data a returning cluster member had left, kept as a backup (spec #176): the words the backups list shows.

/** "Left on server-a after the failover at 14:32"; a server that is gone since is not named. */
export function leftBehindLabel(
  server: string | null | undefined,
  at: string,
  timeZone: string,
  now = new Date(),
): string {
  const when = backupWhen(at, timeZone, now);
  return `Left on ${server || "a removed server"} after the failover${when ? ` at ${when}` : ""}`;
}

/** What restoring one costs, for the red box of its confirm. */
export const leftBehindRestoreCost = (noun: string) =>
  `The ${noun} is stopped and its current data is wiped: everything written since the failover is lost.`;
