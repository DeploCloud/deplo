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

/** What ties an App to one server: a Bind never leaves it, a Volume comes back from a backup, nothing moves freely. */
export type AppDisk = "bind" | "volume" | null;

export function appDisk(app: Stored): AppDisk {
  return appHasBind(app) ? "bind" : appKeepsVolume(app) ? "volume" : null;
}

export const AUTO_FAILOVER_LABEL =
  "Fail over automatically from the latest backup";

export const bindSentence = (name: string, server: string) =>
  `${name} never fails over: it uses a folder that lives on ${server}, and only on that machine.`;

export const waitsSentence = (name: string, server: string) =>
  `${name} waits for ${server} if it stops, so it never starts on old files. You can bring it back on another server from its latest backup.`;

export const automaticSentence = (name: string) =>
  `${name} moves to another server on its own if its server stops, restored from its latest backup. Anything written after that backup is lost.`;

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
      return `${name} has no backup another server can read.`;
    case "no_room":
      return `No other server of the cluster has room for ${name}.`;
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
