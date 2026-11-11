import { formatBytes } from "../utils";

/** The two promises of spec #176, in its words, wherever a database's failover is described. */
export const FAILOVER_PROMISES = [
  "Never two writers",
  "A failover restores the latest backup, and says how old it was",
] as const;

/** The same, for a database that keeps a standby copy (#218). */
export const STANDBY_PROMISES = [
  "Never two writers",
  "A failover promotes the standby copy; a backup is restored only when the copy had stopped following",
] as const;

export const STANDBY_LOSS =
  "A failover loses about a second of writes: the standby copy follows every change.";

export const STANDBY_RECOVERY =
  "Recovery takes about two minutes: the copy takes over and nothing is restored.";

/** The Activity entry of a failover that promoted the standby copy instead of restoring a backup. */
export const promotedSentence = (name: string, server: string, from: string) =>
  `Promoted the standby copy of ${name} on ${server}: ${from} stopped answering. No backup was restored.`;

/** The schedule Deplo gives a database placed on a cluster. */
export const FAILOVER_BACKUP_SCHEDULE = "*/15 * * * *";
export const FAILOVER_BACKUP_MINUTES = 15;

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

function span(minutes: number): string {
  if (minutes < 60) return plural(Math.max(1, Math.round(minutes)), "minute");
  if (minutes < 48 * 60) return plural(Math.round(minutes / 60), "hour");
  return plural(Math.round(minutes / 1440), "day");
}

/** How much a failover can lose: the time between two backups, null when none is scheduled; with an archived change log, about a minute, and only while Deplo runs to collect it. */
export function lossSentence(
  windowMinutes: number | null,
  changeLogArchived = false,
): string {
  if (changeLogArchived && windowMinutes != null)
    return "A failover can lose about a minute of writes while Deplo is running: it collects the change log every minute. If Deplo is down too, the loss is everything written since it stopped.";
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

/** A backup's time as people read it: 14:15 today, "3 Mar, 14:15" otherwise; null when it is no date. */
export function backupWhen(
  takenAt: string | null,
  timeZone: string,
  now = new Date(),
): string | null {
  const at = takenAt ? new Date(takenAt) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  const part = (d: Date, o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-GB", { timeZone, ...o }).format(d);
  const day = (d: Date) => part(d, { day: "numeric", month: "short" });
  try {
    const time = part(at, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return day(at) === day(now) ? time : `${day(at)}, ${time}`;
  } catch {
    // A timezone this runtime does not know must not cost the entry.
    return timeZone === "UTC" ? null : backupWhen(takenAt, "UTC", now);
  }
}

/**
 * The Activity entry of a failover that restored a backup: its time in the schedule's timezone, with the date when
 * it is not today's. `logAt` is how far the change log replayed after it reached, when it reached past the backup.
 */
export function restoredSentence(
  name: string,
  server: string,
  takenAt: string | null,
  timeZone: string,
  now = new Date(),
  logAt: string | null = null,
): string {
  const when = backupWhen(takenAt, timeZone, now);
  if (!when || !takenAt)
    return `Restored ${name} on ${server} from its latest backup`;
  const at = new Date(takenAt);
  const upTo =
    logAt && new Date(logAt).getTime() > at.getTime()
      ? backupWhen(logAt, timeZone, at)
      : null;
  return `Restored ${name} on ${server} from the backup of ${when}${upTo ? ` and its change log up to ${upTo}` : ""}`;
}
