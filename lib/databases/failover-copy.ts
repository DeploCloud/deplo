import { formatBytes } from "../utils";

/** The two promises of spec #176, in its words, wherever a database's failover is described. */
export const FAILOVER_PROMISES = [
  "Never two writers",
  "A failover restores the latest backup, and says how old it was",
] as const;

/** The schedule Deplo gives a database placed on a cluster. */
export const FAILOVER_BACKUP_SCHEDULE = "*/15 * * * *";
export const FAILOVER_BACKUP_MINUTES = 15;

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

function span(minutes: number): string {
  if (minutes < 60) return plural(Math.max(1, Math.round(minutes)), "minute");
  if (minutes < 48 * 60) return plural(Math.round(minutes / 60), "hour");
  return plural(Math.round(minutes / 1440), "day");
}

/** How much a failover can lose: the time between two backups, or null when none is scheduled. */
export function lossSentence(windowMinutes: number | null): string {
  if (windowMinutes == null)
    return "No backup is scheduled, so a failover has nothing recent to restore.";
  return `A failover can lose up to ${span(windowMinutes)} of writes: everything since the last backup.`;
}

/** How long recovery takes, from the last backup's size and the last measured restore speed. */
export function recoverySentence(
  lastBackupBytes: number | null,
  restoreBytesPerSec: number | null,
): string {
  if (!lastBackupBytes || !restoreBytesPerSec)
    return "Recovery takes a few minutes.";
  const seconds = lastBackupBytes / restoreBytesPerSec;
  const took =
    seconds < 60 ? "under a minute" : `about ${span(Math.round(seconds / 60))}`;
  return `Recovery takes ${took}: the last backup is ${formatBytes(lastBackupBytes)}.`;
}

/** The Activity entry of a failover that restored a backup: its time in the schedule's timezone, with the date when it is not today's. */
export function restoredSentence(
  name: string,
  server: string,
  takenAt: string | null,
  timeZone: string,
  now = new Date(),
): string {
  const at = takenAt ? new Date(takenAt) : null;
  if (!at || Number.isNaN(at.getTime()))
    return `Restored ${name} on ${server} from its latest backup`;
  const part = (d: Date, o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-GB", { timeZone, ...o }).format(d);
  const day = (d: Date) => part(d, { day: "numeric", month: "short" });
  try {
    const time = part(at, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const when = day(at) === day(now) ? time : `${day(at)}, ${time}`;
    return `Restored ${name} on ${server} from the backup of ${when}`;
  } catch {
    // A timezone this runtime does not know must not cost the entry.
    return restoredSentence(name, server, takenAt, "UTC", now);
  }
}
