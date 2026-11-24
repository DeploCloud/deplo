import { backupWhen } from "../databases/failover-copy";
import {
  composeHasHostBindMount,
  composeOwnVolumeKeys,
} from "../deploy/compose-lint/volumes";

// How an App that keeps data on its server fails over (spec #176, stories 70-72).
// https://deplo.build/docs/operations/clusters/apps-with-stored-data

/** An App's storage rows, its config files and its own compose: all that decides how it fails over. A row with no type is a Volume. */
export interface StoredOnDisk {
  volumes?:
    readonly { type?: string | null; projectPath?: string | null }[] | null;
  /** The files Deplo holds the content of and writes at every deploy; they travel in the failover bundle. */
  mounts?: readonly { filePath: string }[] | null;
  compose?: string | null;
}
type Stored = StoredOnDisk;

const rel = (p: string | null | undefined) =>
  (p ?? "").replace(/^(\.\/|\/)+/, "").replace(/\/+$/, "");

/**
 * Data on its server's disk that only a backup carries to another one: a Volume, or a File nothing but that
 * disk holds. A File whose content Deplo holds is written again wherever the stack starts, so it keeps nothing.
 */
export function appKeepsVolume(app: Stored): boolean {
  const written = new Set((app.mounts ?? []).map((m) => rel(m.filePath)));
  return (
    (app.volumes ?? []).some(
      (v) =>
        v.type !== "host" &&
        !(v.type === "app" && written.has(rel(v.projectPath))),
    ) || composeOwnVolumeKeys(app.compose ?? "").length > 0
  );
}

export function appHasBind(app: Stored): boolean {
  return (
    (app.volumes ?? []).some((v) => v.type === "host") ||
    composeHasHostBindMount(app.compose ?? "")
  );
}

/** What ties an App to one server: a Bind never leaves it, a Volume moves only with replication, nothing moves freely. */
export type AppDisk = "bind" | "volume" | null;

export function appDisk(app: Stored): AppDisk {
  return appHasBind(app) ? "bind" : appKeepsVolume(app) ? "volume" : null;
}

/** What a replicated App's failover keeps to, as its card lists them. */
export const REPLICATION_PROMISES = [
  "Never two writers",
  "A failover starts it from its copy on the new server, as up to date as the copy was",
];

export const bindSentence = (name: string, server: string) =>
  `${name} never fails over: it uses a folder that lives on ${server}, and only on that machine.`;

export const waitsSentence = (name: string, server: string, cluster: string) =>
  `${name} waits for ${server} if it stops: cluster ${cluster} does not copy its data. You can bring it back on another server from its latest backup.`;

export const replicatedSentence = (name: string) =>
  `${name} moves to another server on its own if its server stops, with its data replicated there as it changes.`;

export const copyPendingSentence = (name: string) =>
  `${name} fails over once a whole copy of its data is on another server. Deplo is making it now.`;

/** "the backup of 14:15", in the schedule's timezone; "its latest backup" when the time is unknown. */
export function backupName(
  takenAt: string,
  timeZone: string,
  now = new Date(),
): string {
  const when = backupWhen(takenAt, timeZone, now);
  return when ? `the backup of ${when}` : "its latest backup";
}

/** The one click, naming the backup it restores. */
export const bringBackLabel = (name: string, backup: string) =>
  `Bring ${name} back on another server from ${backup}`;

/** Why the cluster's leader did not make the move, as the person who asked reads it. */
export function moveRefusal(reason: string, name: string): string {
  switch (reason) {
    case "still_answering":
      return `${name}'s server may still be running it. Deplo never starts a second copy next to one that could be writing: try again in a minute.`;
    case "no_backup":
      return `${name} has no backup or copy another server can read.`;
    case "no_room":
      return `No other server of the cluster has room for ${name}.`;
    case "no_disk":
      return `No other server of the cluster has room for ${name}'s data and a tenth of its disk free.`;
    case "no_member_online":
      return `No other server of the cluster is online to take ${name}.`;
    case "start_failed":
      return `${name} did not start on another server.`;
    case "no_path":
    case "not_leading":
      return "The cluster's leader cannot reach its servers right now. Try again in a minute.";
  }
  return `The cluster's leader could not move ${name}.`;
}

/** How one other server's copy of an App stands, as its page lists it under Advanced. */
export interface CopyRow {
  server: string;
  state: "Up to date" | "Copying" | "Behind" | "Not copied";
  /** When the newest change reached it; null before the first. */
  lastCopyAt: string | null;
  /** How long since the App's server last reached it, while it is behind. */
  behindSeconds: number | null;
  bytes: number;
  error: string;
}

const and = (names: string[]) =>
  names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** The App's one line about its copies: the page shows it, and Activity says the same. */
export function copiesLine(serverName: string, rows: CopyRow[]): string {
  const up = rows.filter((r) => r.state === "Up to date").length;
  const copying = rows
    .filter((r) => r.state === "Copying")
    .map((r) => r.server);
  if (rows.length > 0 && up === rows.length)
    return `Copies: ${up} of ${rows.length} up to date`;
  if (up === 0 && copying.length > 0) return `Copying to ${and(copying)}`;
  if (up === 0 && !rows.some((r) => r.state === "Behind"))
    return `Not copied yet: this App cannot move if ${serverName} goes off`;
  return `Copies: ${up} of ${rows.length} up to date`;
}

/** What Activity says when the App's copies start or stop letting it move: never "0 up to date" and "it can move" alone. */
export function copiesActivity(
  appName: string,
  serverName: string,
  rows: CopyRow[],
  canMove: boolean,
): string {
  const line = copiesLine(serverName, rows);
  if (!canMove) return `${appName}: ${line}`;
  if (rows.some((r) => r.state === "Up to date"))
    return `${appName}: ${line}. It can move if ${serverName} goes off.`;
  return `${appName}: no copy is up to date yet. It can still move if ${serverName} goes off, without the writes no copy has received.`;
}
